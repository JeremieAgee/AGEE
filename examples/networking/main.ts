import * as THREE from "three";
import {
  AGEE, Transform, MeshRenderer, Replicated, NetworkInterpolated,
  LoopbackTransport,
} from "../../src/index";
import { createOrbitCamera } from "../shared/orbitCamera";
import { createHUD } from "../shared/hud";

const ORBITER_COUNT = 8;
const CLIENT_ID = 1;
const PULSE_INTERVAL = 2.5;
const PULSE_LIFETIME = 2;

// Deterministic per-networkId color so the same server entity always renders the same hue
// on the client, without needing an extra replicated "color" field.
function colorForNetworkId(id: number): number {
  const hue = (id * 47) % 360;
  return new THREE.Color(`hsl(${hue}, 70%, 55%)`).getHex();
}

async function main(): Promise<void> {
  // Two full AGEE instances in one page: `server` is headless and authoritative, `client`
  // renders. They talk over an in-memory LoopbackTransport pair instead of a real socket —
  // same NetworkManager/protocol code a client and a WebSocket server would use.
  const { client: clientTransport, server: serverTransport } = LoopbackTransport.createPair();

  const server = new AGEE({
    headless: true,
    network: { role: "server", tickRate: 15, transport: new LoopbackTransport() },
  });
  await server.init();

  const client = new AGEE({
    renderBackend: "webgpu",
    network: { role: "client", transport: clientTransport },
  });
  await client.init();

  createOrbitCamera(client, { target: { x: 0, y: 0, z: 0 }, distance: 16, height: 10 });
  client.lighting.addAmbientLight(0x334455, 0.6);
  client.lighting.addDirectionalLight(0xffffff, 0.8, { x: 5, y: 10, z: 5 }, false);

  function connect(): void {
    server.network!.addClient(CLIENT_ID, serverTransport);
    client.network!.connect("loopback://networking-example");
  }
  function disconnect(): void {
    client.network!.disconnect();
    server.network!.removeClient(CLIENT_ID);
  }
  connect();

  // --- Server: authoritative simulation, no rendering, no physics needed for this demo ---
  const serverTransformStore = server.world.getStore(Transform);
  const orbiterEids: number[] = [];

  for (let i = 0; i < ORBITER_COUNT; i++) {
    const eid = server.world.createEntity();
    const networkId = i + 1;
    server.world.addComponent(eid, Replicated, { networkId, owner: -1, priority: 1, lastSyncTick: 0 });
    server.world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    // InterestManager.filterSnapshot() (run for every server broadcast, since a server always
    // has one) looks entities up by networkId through this same map to know their position for
    // distance culling — without registering it here, that lookup misses and the entity is
    // silently dropped from every snapshot sent to every client, forever.
    server.network!.registerEntity(eid, networkId);
    orbiterEids.push(eid);
  }

  let simTime = 0;
  let nextPulseId = ORBITER_COUNT + 1;
  const activePulses: Array<{ eid: number; networkId: number; expiresAt: number }> = [];

  server.events.on("preUpdate", (dt: number) => {
    simTime += dt;

    for (let i = 0; i < orbiterEids.length; i++) {
      const radius = 3 + (i % 4) * 1.5;
      const speed = 0.3 + (i % 3) * 0.15;
      const phase = (i / orbiterEids.length) * Math.PI * 2;
      const angle = simTime * speed + phase;
      serverTransformStore.set(orbiterEids[i], "x", Math.cos(angle) * radius);
      serverTransformStore.set(orbiterEids[i], "z", Math.sin(angle) * radius);
      serverTransformStore.set(orbiterEids[i], "y", Math.sin(simTime * 2 + phase) * 0.3);
    }

    // Periodically spawn a short-lived "pulse" entity to demonstrate spawn/despawn
    // replication distinctly from continuous movement.
    if (Math.floor(simTime / PULSE_INTERVAL) > Math.floor((simTime - dt) / PULSE_INTERVAL)) {
      const eid = server.world.createEntity();
      const networkId = nextPulseId++;
      server.world.addComponent(eid, Replicated, { networkId, owner: -1, priority: 1, lastSyncTick: 0 });
      const a = Math.random() * Math.PI * 2;
      server.world.addComponent(eid, Transform, {
        x: Math.cos(a) * 7, y: 1.5, z: Math.sin(a) * 7, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
      });
      server.network!.registerEntity(eid, networkId);
      activePulses.push({ eid, networkId, expiresAt: simTime + PULSE_LIFETIME });
    }
    for (let i = activePulses.length - 1; i >= 0; i--) {
      if (simTime >= activePulses[i].expiresAt) {
        server.world.destroyEntity(activePulses[i].eid);
        activePulses.splice(i, 1);
      }
    }
  });

  server.start();

  // --- Client: mesh-ify whatever the network layer spawns, purely from Replicated+Transform ---
  const clientMeshStore = client.world.getStore(MeshRenderer);
  const clientInterpStore = client.world.getStore(NetworkInterpolated);
  const replicatedQuery = client.world.query(Replicated, Transform);

  client.events.on("preUpdate", () => {
    for (const eid of replicatedQuery.entities) {
      if (clientMeshStore.has(eid)) continue;

      const networkId = client.network!.getNetworkId(eid) ?? 0;
      const isPulse = networkId > ORBITER_COUNT;
      const mesh = new THREE.Mesh(
        isPulse ? new THREE.OctahedronGeometry(0.35) : new THREE.SphereGeometry(0.3, 16, 16),
        new THREE.MeshStandardMaterial({ color: colorForNetworkId(networkId), roughness: 0.5 })
      );
      mesh.castShadow = true;
      client.render.scene.add(mesh);
      client.world.addComponent(eid, MeshRenderer, { meshRef: mesh, visible: 1, castShadow: 1, receiveShadow: 0 });

      // Give every other orbiter extra render-delay smoothing, so the effect of
      // NetworkInterpolated.renderDelay is visible: same server motion, visibly different
      // client-side lag/smoothness.
      if (clientInterpStore.has(eid) && networkId % 2 === 0) {
        clientInterpStore.set(eid, "renderDelay", 400);
      }
    }
  });

  const hud = createHUD("Networking", [
    "Orbiting spheres are server-authoritative, replicated over a loopback transport",
    "Octahedrons are short-lived — watch them spawn/despawn on the client",
    "Even-numbered entities use extra interpolation delay (visibly smoother/laggier)",
  ]);

  let connected = true;
  const connBtn = document.createElement("button");
  connBtn.className = "agee-btn";
  connBtn.textContent = "Disconnect client";
  connBtn.style.marginTop = "6px";
  connBtn.addEventListener("click", () => {
    connected = !connected;
    if (connected) connect(); else disconnect();
    connBtn.textContent = connected ? "Disconnect client" : "Reconnect client";
  });
  hud.root.appendChild(connBtn);

  client.events.on("postUpdate", () => {
    hud.setLine("conn", `Client: ${client.network!.isConnected ? "connected" : "disconnected"} | rtt: ${client.network!.rtt.toFixed(0)}ms`);
    hud.setLine("tick", `Server tick: ${server.network!.currentTick} | client last recv: ${client.network!.lastReceivedTick}`);
    hud.setLine("entities", `Replicated entities — server: ${orbiterEids.length + activePulses.length}, client: ${replicatedQuery.entities.length}`);
  });

  client.start();
}

main().catch((err) => {
  console.error("[networking example] failed to start:", err);
  document.body.innerHTML = `<pre style="color:#f66;padding:16px;white-space:pre-wrap">${String(err?.stack ?? err)}</pre>`;
});
