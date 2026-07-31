# AGEE

Adaptive Game Engine Environment (AGEE) is a modular TypeScript browser game engine built around a custom ECS and runtime.

## Overview

AGEE is designed as a full-stack engine runtime for browser-based experiences. It combines a high-performance ECS, rendering, physics, audio, animation, UI, AI, networking, terrain, and scene management into a single TypeScript codebase.

## Key Features

- Custom ECS with archetype-based queries, SOA component stores, and staged system scheduling
- Three.js-based rendering (WebGL or WebGPU backend) for scene-graph content, layered as a
  transparent overlay above a separate native WebGPU render pipeline (`gpu/`) — mesh/material
  pools, bind groups, and a forward pass — which handles opaque scene geometry
- Rapier physics integration with collision layers and object interpolation
- Audio system with positional and global sound support
- Input system for keyboard, mouse, gamepad, and pointer lock
- Animation and skeleton systems, including humanoid ragdoll (animated ↔ physics-driven)
- UI widget layer and overlay management
- AI subsystems — Behavior Trees, FSM, Utility AI, GOAP, and Steering Behaviors — sharing
  common agent pooling/tick-rate scaffolding; each runs its own decision state rather than a
  single shared blackboard, so treat them as independent tools rather than a composable suite
- Scene and prefab serialization, dynamic scene loading, and persistence
- Networking stack with transport abstraction, snapshot replication, delta compression, and
  client/server roles (the server can track multiple per-client connections)
- Procedural terrain streaming with budgeted per-frame chunk loading and physics collider
  generation

## Structure

All source lives under `src/`:

- `src/core/` — engine runtime, math, ECS components, serialization, event bus, profiler, resource handles
- `src/ecs/` — world, systems, queries, archetype index, component stores, scheduler, command buffer
- `src/systems/` — rendering, physics, culling, transform hierarchy, post-processing, debug utilities
- `src/gpu/` — native WebGPU context, mesh/material pools, render pipeline
- `src/assets/` — asset registration, loaders, GLTF pipeline
- `src/audio/` — audio system and mixer
- `src/animation/` — animation graph and runtime
- `src/skeleton/` — skeletal animation, humanoid rigs, and ragdoll physics
- `src/ai/` — AI subsystems and behavior frameworks
- `src/navigation/` — pathfinding (grid A*) and navmesh queries
- `src/network/` — networking, transports, snapshot manager, replication
- `src/scene/` — scene manager and loading workflow
- `src/prefab/` — prefab registration and instantiation
- `src/terrain/` — procedural terrain, streaming chunks, and off-main-thread chunk generation
- `src/ui/` — UI manager and widget library
- `src/input/` — keyboard, mouse, gamepad, and pointer-lock input
- `src/gameplay/` — game state stack and save/load system
- `src/tests/` — the test suite (see Getting Started)

Runnable examples live under `examples/` (one subfolder per demo, each with its own
`index.html` + `main.ts`); `examples/shared/` holds small helpers (HUD, orbit camera) reused
across them.

## Getting Started

```sh
npm install
npm run dev        # starts the Vite dev server (serves index.html and every examples/*/index.html)
npm run build      # production build (outputs to dist/)
npm run typecheck  # tsc --noEmit
npm run test       # runs the test suite once (vitest run)
npm run test:watch # re-runs tests on change
```

Example usage:

```ts
import { AGEE } from "./src/index";

const engine = new AGEE({ canvas: document.querySelector("canvas"), renderBackend: "webgpu" });
await engine.init();
engine.start();
```

## Notes

- `AGEE` stands for **Adaptive Game Engine Environment**.
- The engine is intended for browser environments and supports both headless and browser-based modes.
- Some subsystems rely on browser APIs such as `navigator.gpu`, `WebSocket`, and Web Audio.
- **WebGPU is effectively required in non-headless mode**, even if `renderBackend: "webgl"` is
  passed. That option only controls the Three.js overlay's backend — the native render
  pipeline always requests a WebGPU device on init and throws (failing `engine.init()`
  entirely) if `navigator.gpu` isn't available.
- Terrain chunk generation offloads to a Web Worker (`src/terrain/terrain.worker.ts`) when the
  `Worker` API is available, falling back to synchronous main-thread generation otherwise
  (headless/Node, or a browser build that failed to start one).

## Contributing

Contributions are welcome — run `npm run typecheck` and `npm run test` before opening a PR
(CI runs both on every push/PR via `.github/workflows/ci.yml`).

## License

[MIT](./LICENSE)
