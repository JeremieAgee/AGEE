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
- `src/ai/` — AI subsystems and behavior frameworks
- `src/network/` — networking, transports, snapshot manager, replication
- `src/scene/` — scene manager and loading workflow
- `src/prefab/` — prefab registration and instantiation
- `src/terrain/` — procedural terrain and streaming chunks
- `src/ui/` — UI manager and widget library
- `src/tests/` — regression tests (no test runner is wired up to execute them yet — see Notes)

## Getting Started

This repository contains the source files for the engine only — there's no `package.json`,
`tsconfig.json`, or bundler config checked in yet. To use AGEE, add your own TypeScript
project configuration and package manifest (including `three` and `@dimforge/rapier3d-compat`
as dependencies), then import the engine from `src/index.ts`.

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
- `src/tests/regression.test.ts` exists but no test runner (Jest/Vitest/etc.) is configured to
  run it yet.

## Contributing

Contributions are welcome. Add missing configuration files (package manifest, tsconfig, a test
runner) and example projects to make the engine easier to build, test, and run.

