// Core
export { AGEE } from "./core/Engine";
export type { AGEEConfig, EngineState } from "./core/Engine";
export { Clock } from "./core/Clock";
export { EventBus } from "./core/EventBus";
export { EngineProfiler } from "./core/EngineProfiler";
export type { FrameStats, ProfilerConfig } from "./core/EngineProfiler";
export { ValidationLayer } from "./core/ValidationLayer";
export type { ValidationWarning } from "./core/ValidationLayer";

// Built-in components
export {
  Transform, Velocity, RigidBody, Collider,
  MeshRenderer, Light, AudioSource, ParticleEmitter, Tag,
  GPUMeshRenderer,
} from "./core/Components";
export { LocalTransform, WorldTransform, Parent, Children } from "./core/HierarchyComponents";

// ECS
export { World, System, defineComponent, ComponentStore, Query, BitSet, SparseSet, SystemScheduler } from "./ecs";
export type { ComponentDef, ComponentSchema, SystemPhase, SystemConstraint, ExecutionPlan, ExecutionStage } from "./ecs";
export { CommandBuffer } from "./ecs/CommandBuffer";

// Handles
export { HandleAllocator, HandleMap, INVALID_HANDLE } from "./core/handles/Handle";
export type { Handle, HandleEntry, ResourceType } from "./core/handles/Handle";
export { ResourceManager } from "./core/handles/ResourceManager";
export type { TextureHandle, MeshHandle, MaterialHandle, AudioHandle, AnimClipHandle, ResourceStats } from "./core/handles/ResourceManager";

// Asset System
export { AssetSystem } from "./assets/AssetSystem";
export { AssetStore } from "./assets/AssetStore";
export { AssetType, LoadStatus, INVALID_ASSET } from "./assets/AssetTypes";
export type { AssetId, AssetHandle } from "./assets/AssetTypes";
export { GLTFPipeline } from "./assets/pipeline/GLTFPipeline";
export type { GLTFAsset, GLTFInstantiateResult, GPUTarget } from "./assets/pipeline/GLTFPipeline";

// Math
export { Vec3 } from "./core/math/Vec3";
export { Quat } from "./core/math/Quat";
export { Mat4 } from "./core/math/Mat4";
export { AABB } from "./core/math/AABB";
export { Frustum } from "./core/math/Frustum";

// Spatial
export { SpatialHash } from "./core/spatial/SpatialHash";

// Serialization
export { BinaryWriter, BinaryReader } from "./core/serialization/BinaryBuffer";
export { SceneSerializer } from "./core/serialization/SceneSerializer";
export type { SerializedEntity, SerializedScene } from "./core/serialization/SceneSerializer";

// Systems — Rendering
export { RenderSystem } from "./systems/RenderSystem";
export { CullingSystem } from "./systems/CullingSystem";
export { PostProcessSystem } from "./systems/PostProcessSystem";
export { LODSystem, LODGroup } from "./systems/LODSystem";
export type { LODLevel } from "./systems/LODSystem";
export { InstancingSystem, InstancedTag } from "./systems/InstancingSystem";

// Systems — Physics
export { PhysicsSystem } from "./systems/PhysicsSystem";
export type { RaycastHit, CollisionEvent, CharacterControllerConfig, CharacterMoveResult } from "./systems/PhysicsSystem";

// Systems — Transform
export { TransformHierarchySystem } from "./systems/TransformHierarchySystem";

// Systems — Debug
export { PhysicsDebugRenderer } from "./systems/debug/PhysicsDebugRenderer";
export { DebugInspector } from "./systems/debug/DebugInspector";
export { DebugOverlay } from "./systems/debug/DebugOverlay";
export { DevConsole } from "./systems/debug/DevConsole";
export type { CommandFn } from "./systems/debug/DevConsole";
export { DebugDraw } from "./systems/debug/DebugDraw";

// Camera
export { CameraSystem, CameraMode, CameraData } from "./camera/CameraSystem";

// Input
export { InputSystem } from "./input/InputSystem";
export { InputActions } from "./input/InputActions";
export type { ActionBinding } from "./input/InputActions";

// Audio
export { AudioSystem } from "./audio/AudioSystem";
export { AudioMixer } from "./audio/AudioMixer";
export type { AudioBus } from "./audio/AudioMixer";

// Animation
export { AnimationSystem } from "./animation/AnimationSystem";
export { AnimationGraph } from "./animation/AnimationGraph";
export type { AnimationStateConfig, AnimationTransitionConfig } from "./animation/AnimationGraph";
export { Animator } from "./animation/AnimationComponents";

// Particles
export { ParticleSystemEngine } from "./particles/ParticleSystem";

// UI
export { UISystem } from "./ui/UISystem";
export { UIManager, WorldUI } from "./ui/UIManager";
export { Widget, Panel, Label, Button, ProgressBar, Image } from "./ui/Widget";
export type { UIStyle } from "./ui/Widget";

// Scene
export { SceneManager } from "./scene/SceneManager";
export type { SceneHandle, SceneState } from "./scene/SceneManager";

// Prefabs
export { PrefabSystem } from "./prefab/PrefabSystem";
export type { PrefabDef, PrefabEntity, PrefabComponent, PrefabVariant } from "./prefab/PrefabSystem";

// Terrain
export { TerrainSystem } from "./terrain/TerrainSystem";
export type { TerrainConfig } from "./terrain/TerrainSystem";
export { TerrainChunk } from "./terrain/TerrainChunk";
export { NoiseGenerator, SeededRandom } from "./terrain/NoiseGenerator";
export type { NoiseConfig } from "./terrain/NoiseGenerator";

// AI
export { AISystem, AIAgent, Perception, AIType } from "./ai/AISystem";
export { BehaviorTreeRunner, Blackboard } from "./ai/BehaviorTree";
export type { BTNode, BTStatus, BTNodeType, ActionFn, ConditionFn } from "./ai/BehaviorTree";
export { FSMBuilder, FSMRunner } from "./ai/FSM";
export type { FSMDefinition, FSMInstance, FSMState, FSMTransition } from "./ai/FSM";
export { UtilitySetBuilder, UtilityRunner, ResponseCurves } from "./ai/UtilityAI";
export type { UtilitySet, UtilityInstance, UtilityAction, UtilityConsideration } from "./ai/UtilityAI";
export { SteeringSystem, SteeringAgent, SteeringFlag } from "./ai/SteeringBehaviors";
export { GOAPDomainBuilder, GOAPPlanner } from "./ai/GOAP";
export type { GOAPDomain, GOAPInstance, GOAPAction, GOAPGoal, WorldState } from "./ai/GOAP";
export { AIDebugPanel } from "./ai/AIDebugPanel";

// Navigation
export { NavigationSystem, NavAgent } from "./navigation/NavigationSystem";

// Gameplay
export { GameState, GameStateManager } from "./gameplay/GameState";
export { SaveSystem } from "./gameplay/SaveSystem";
export type { SaveSlot, SaveResult } from "./gameplay/SaveSystem";

// Skeleton
export { SkeletonDefinition } from "./skeleton/SkeletonDefinition";
export { BoneFlags, BoneCategory, ColliderType } from "./skeleton/SkeletonDefinition";
export type { BoneConfig } from "./skeleton/SkeletonDefinition";
export { SkeletonInstance, DirtyFlags, MotorMode } from "./skeleton/SkeletonInstance";
export { SkeletonSystem } from "./skeleton/SkeletonSystem";
export type { JointConfig, SkeletonConfig } from "./skeleton/SkeletonSystem";
export { Joint, JointType, DofMask } from "./skeleton/SkeletonComponents";
export { HumanoidBone, createHumanoid, animateHumanoidWalk, startHumanoidRagdoll, updateHumanoidRagdoll, cleanupHumanoid } from "./skeleton/HumanoidFactory";
export { HUMANOID_BONES, HUMANOID_JOINTS } from "./skeleton/HumanoidFactory";
export type { BonePivot, HumanoidMaterials, HumanoidData } from "./skeleton/HumanoidFactory";

// Chunked Archetype ECS (AAA storage)
export { Chunk, CHUNK_SIZE } from "./ecs/Chunk";
export { ChunkedArchetype, ChunkedArchetypeStorage } from "./ecs/ChunkedArchetype";
export type { EntityLocation } from "./ecs/ChunkedArchetype";
export { ChunkedQuery } from "./ecs/ChunkedQuery";
export type { ChunkIterationContext } from "./ecs/ChunkedQuery";

// Event Journal (typed, deferred, replayable)
export { EventJournal, defineEvent } from "./core/EventJournal";

// Deterministic Math
export { DeterministicMath, SeededRNG } from "./core/DeterministicMath";
export { dsin, dcos, dtan, datan2, dasin, dacos, dsqrt } from "./core/DeterministicMath";

// Memory Budget
export { MemoryBudget } from "./core/MemoryBudget";
export type { BudgetConfig, EvictionCandidate } from "./core/MemoryBudget";

// Material System
export { MaterialSystem, MaterialComponent, createDefaultMaterial } from "./rendering/MaterialDef";
export type { MaterialDef, MaterialParams, MaterialHandle as MaterialDefHandle } from "./rendering/MaterialDef";
export { BlendMode, RenderQueue } from "./rendering/MaterialDef";

// Render Graph
export { RenderGraph, MainScenePass, ShadowPass, DebugWireframePass } from "./rendering/RenderGraph";
export type { RenderPass, RenderContext } from "./rendering/RenderGraph";
export { PassType } from "./rendering/RenderGraph";

// Collision layers
export { CollisionLayer } from "./systems/PhysicsSystem";
export type { CollisionFilter } from "./systems/PhysicsSystem";

// Navigation helpers
export { BinaryHeap } from "./navigation/BinaryHeap";

// Pooling
export { ObjectPool } from "./pooling/ObjectPool";

// Lighting
export { LightingHelpers } from "./lighting/LightingHelpers";

// Network
export {
  NetworkManager,
  Replicated, NetworkOwner, NetworkInterpolated,
  ComponentRegistry,
  WebSocketTransport, LoopbackTransport,
  SnapshotManager, InputBuffer, InterestManager,
  NetworkReceiveSystem, NetworkSendSystem,
  NETWORK_CONSTANTS, MessageType,
} from "./network";
export type {
  NetworkConfig, NetworkRole, ConnectionState,
  Transport, TransportEvent,
  InputPayload, Snapshot, SnapshotEntry, DeltaSnapshot, DeltaEntry,
} from "./network";

// GPU-native render pipeline
export { GPUContext } from "./gpu/GPUContext";
export type { GPUContextConfig } from "./gpu/GPUContext";
export { GPUMesh, VERTEX_BUFFER_LAYOUT } from "./gpu/GPUMesh";
export type { GPUMeshDescriptor } from "./gpu/GPUMesh";
export { GPURenderSystem } from "./gpu/GPURenderSystem";
export { GPUMaterialPool } from "./gpu/GPUMaterialPool";
export type { GPUMaterialParams } from "./gpu/GPUMaterialPool";
export { extractGeometry } from "./gpu/ThreeGeometryAdapter";
export { createFrameLayouts } from "./gpu/BindGroupLayouts";
export type { FrameLayouts } from "./gpu/BindGroupLayouts";
