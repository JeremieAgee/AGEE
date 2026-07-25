# AGEE

Adaptive Game Engine Environment (AGEE) is a modular TypeScript browser game engine built around a custom ECS and runtime.

## Overview

AGEE is designed as a full-stack engine runtime for browser-based experiences. It combines a high-performance ECS, rendering, physics, audio, animation, UI, AI, networking, terrain, and scene management into a single TypeScript codebase.

## Key Features

- Custom ECS with archetype-based queries, SOA component stores, and staged system scheduling
- Rendering support for three.js WebGL and WebGPU backends
- Rapier physics integration with collision layers and object interpolation
- Audio system with positional and global sound support
- Input system for keyboard, mouse, gamepad, and pointer lock
- Animation and skeleton systems
- UI widget layer and overlay management
- AI frameworks: Behavior Trees, FSM, Utility AI, GOAP, and Steering Behaviors
- Scene and prefab serialization, dynamic scene loading, and persistence
- Networking stack with transport abstraction, snapshot replication, delta updates, and client/server roles
- Procedural terrain streaming with runtime chunk loading and physics collider generation

## Structure

- `core/` — engine runtime, math, ECS components, serialization, event bus, profiler, resource handles
- `ecs/` — world, systems, queries, archetype index, component stores, scheduler, command buffer
- `systems/` — rendering, physics, culling, transform hierarchy, post-processing, debug utilities
- `gpu/` — WebGPU context, mesh/material pools, render pipeline
- `assets/` — asset registration, loaders, GLTF pipeline
- `audio/` — audio system and mixer
- `animation/` — animation graph and runtime
- `ai/` — AI subsystems and behavior frameworks
- `network/` — networking, transports, snapshot manager, replication
- `scene/` — scene manager and loading workflow
- `prefab/` — prefab registration and instantiation
- `terrain/` — procedural terrain and streaming chunks
- `ui/` — UI manager and widget library

## Getting Started

This repository contains the source files for the engine. To use AGEE, add your own TypeScript project configuration and package manifest, then import the engine from `index.ts`.

Example usage:

```ts
import { AGEE } from "./index";

const engine = new AGEE({ canvas: document.querySelector("canvas"), renderBackend: "webgpu" });
await engine.init();
engine.start();
```

## Notes

- `AGEE` stands for **Adaptive Game Engine Environment**.
- The engine is intended for browser environments and supports both headless and browser-based modes.
- Some subsystems rely on browser APIs such as `navigator.gpu`, `WebSocket`, and Web Audio.

## Contributing

Contributions are welcome. Add missing configuration files, tests, or example projects to make the engine easier to build and run.
