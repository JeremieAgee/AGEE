import * as THREE from "three";
import { World, ComponentStore } from "../ecs";
import { Transform, Light } from "../core/Components";

export class LightingHelpers {
  private world: World;
  private scene: THREE.Scene;

  constructor(world: World, scene: THREE.Scene) {
    this.world = world;
    this.scene = scene;
  }

  addAmbientLight(color: number = 0x404040, intensity: number = 0.5): number {
    const eid = this.world.createEntity();
    const light = new THREE.AmbientLight(color, intensity);
    this.scene.add(light);

    this.world.addComponent(eid, Transform, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    this.world.addComponent(eid, Light, {
      lightRef: light,
      lightType: 3,
      color,
      intensity,
      castShadow: 0,
    });

    return eid;
  }

  addDirectionalLight(
    color: number = 0xffffff,
    intensity: number = 1,
    position: { x: number; y: number; z: number } = { x: 5, y: 10, z: 5 },
    castShadow: boolean = true
  ): number {
    const eid = this.world.createEntity();
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(position.x, position.y, position.z);

    if (castShadow) {
      light.castShadow = true;
      light.shadow.mapSize.width = 2048;
      light.shadow.mapSize.height = 2048;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 50;
      light.shadow.camera.left = -15;
      light.shadow.camera.right = 15;
      light.shadow.camera.top = 15;
      light.shadow.camera.bottom = -15;
      // Without a bias, the depth comparison self-intersects the casting surface at
      // shadow-map texel resolution, producing dense salt-and-pepper "shadow acne" across
      // every lit face (worst on curved geometry). normalBias offsets the sampled point
      // along the surface normal before the depth test, which clears acne on solid meshes
      // without the peter-panning a depth-only bias would introduce at these camera bounds.
      light.shadow.normalBias = 0.05;
    }

    this.scene.add(light);

    this.world.addComponent(eid, Transform, {
      x: position.x, y: position.y, z: position.z,
      rx: 0, ry: 0, rz: 0,
      sx: 1, sy: 1, sz: 1,
    });
    this.world.addComponent(eid, Light, {
      lightRef: light,
      lightType: 1,
      color,
      intensity,
      castShadow: castShadow ? 1 : 0,
    });

    return eid;
  }

  addPointLight(
    color: number = 0xffffff,
    intensity: number = 1,
    distance: number = 20,
    position: { x: number; y: number; z: number } = { x: 0, y: 5, z: 0 },
    castShadow: boolean = false
  ): number {
    const eid = this.world.createEntity();
    const light = new THREE.PointLight(color, intensity, distance);
    light.position.set(position.x, position.y, position.z);
    light.castShadow = castShadow;
    this.scene.add(light);

    this.world.addComponent(eid, Transform, {
      x: position.x, y: position.y, z: position.z,
      rx: 0, ry: 0, rz: 0,
      sx: 1, sy: 1, sz: 1,
    });
    this.world.addComponent(eid, Light, {
      lightRef: light,
      lightType: 0,
      color,
      intensity,
      distance,
      castShadow: castShadow ? 1 : 0,
    });

    return eid;
  }

  addSpotLight(
    color: number = 0xffffff,
    intensity: number = 1,
    distance: number = 30,
    angle: number = Math.PI / 6,
    penumbra: number = 0.3,
    position: { x: number; y: number; z: number } = { x: 0, y: 10, z: 0 },
    castShadow: boolean = true
  ): number {
    const eid = this.world.createEntity();
    const light = new THREE.SpotLight(color, intensity, distance, angle, penumbra);
    light.position.set(position.x, position.y, position.z);
    light.castShadow = castShadow;
    // See addDirectionalLight's normalBias comment — same shadow-acne fix, same reason.
    if (castShadow) light.shadow.normalBias = 0.05;
    this.scene.add(light);

    this.world.addComponent(eid, Transform, {
      x: position.x, y: position.y, z: position.z,
      rx: 0, ry: 0, rz: 0,
      sx: 1, sy: 1, sz: 1,
    });
    this.world.addComponent(eid, Light, {
      lightRef: light,
      lightType: 2,
      color,
      intensity,
      distance,
      angle,
      penumbra,
      castShadow: castShadow ? 1 : 0,
    });

    return eid;
  }
}
