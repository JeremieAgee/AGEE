import { World } from "../ecs";
import { SceneSerializer, SerializedScene } from "../core/serialization/SceneSerializer";

export interface SaveSlot {
  name: string;
  timestamp: number;
  metadata: Record<string, any>;
}

export interface SaveResult {
  success: boolean;
  error?: string;
}

export class SaveSystem {
  private serializer: SceneSerializer;
  private storagePrefix: string;

  constructor(serializer: SceneSerializer, storagePrefix: string = "agee_save_") {
    this.serializer = serializer;
    this.storagePrefix = storagePrefix;
  }

  save(world: World, slot: string, metadata: Record<string, any> = {}): SaveResult {
    const key = this.storagePrefix + slot;
    const backupKey = key + "_backup";

    try {
      const scene = this.serializer.serialize(world, slot);
      const saveData = {
        scene,
        slot: { name: slot, timestamp: Date.now(), metadata } as SaveSlot,
      };
      const serialized = JSON.stringify(saveData);

      // Atomic save: write to backup first, then promote
      const existing = localStorage.getItem(key);
      if (existing) {
        localStorage.setItem(backupKey, existing);
      }

      localStorage.setItem(key, serialized);

      // Verify write succeeded
      const verify = localStorage.getItem(key);
      if (verify !== serialized) {
        // Restore backup
        if (existing) localStorage.setItem(key, existing);
        localStorage.removeItem(backupKey);
        return { success: false, error: "Write verification failed" };
      }

      localStorage.removeItem(backupKey);
      return { success: true };
    } catch (e) {
      // Attempt to restore backup on failure
      try {
        const backup = localStorage.getItem(backupKey);
        if (backup) {
          localStorage.setItem(key, backup);
          localStorage.removeItem(backupKey);
        }
      } catch { /* best effort */ }

      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[AGEE] Save failed for slot "${slot}":`, msg);
      return { success: false, error: msg };
    }
  }

  load(world: World, slot: string): SaveResult {
    const key = this.storagePrefix + slot;
    const raw = localStorage.getItem(key);
    if (!raw) return { success: false, error: "Save slot not found" };

    let saveData: any;
    try {
      saveData = JSON.parse(raw);
    } catch (e) {
      // Try backup
      const backup = localStorage.getItem(key + "_backup");
      if (backup) {
        try {
          saveData = JSON.parse(backup);
          console.warn(`[AGEE] Primary save corrupted for slot "${slot}", loaded backup`);
        } catch {
          return { success: false, error: "Both primary and backup saves are corrupted" };
        }
      } else {
        return { success: false, error: "Save data is corrupted" };
      }
    }

    if (!saveData || typeof saveData !== "object" || !saveData.scene || !saveData.scene.entities) {
      return { success: false, error: "Save data missing scene or entities" };
    }

    try {
      const scene = saveData.scene as SerializedScene;
      this.serializer.deserialize(world, scene);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Deserialization failed: ${msg}` };
    }
  }

  listSlots(): SaveSlot[] {
    const slots: SaveSlot[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(this.storagePrefix)) continue;
      if (key.endsWith("_backup")) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key)!);
        if (data.slot) slots.push(data.slot);
      } catch { /* skip corrupt entries */ }
    }
    return slots.sort((a, b) => b.timestamp - a.timestamp);
  }

  deleteSlot(slot: string): void {
    localStorage.removeItem(this.storagePrefix + slot);
    localStorage.removeItem(this.storagePrefix + slot + "_backup");
  }

  hasSave(slot: string): boolean {
    return localStorage.getItem(this.storagePrefix + slot) !== null;
  }

  async exportSave(slot: string): Promise<Blob | null> {
    const raw = localStorage.getItem(this.storagePrefix + slot);
    if (!raw) return null;
    return new Blob([raw], { type: "application/json" });
  }

  async importSave(file: File): Promise<SaveResult & { slot?: string }> {
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      if (!data.slot?.name) return { success: false, error: "Import file missing slot name" };
      if (!data.scene?.entities) return { success: false, error: "Import file missing scene data" };
      localStorage.setItem(this.storagePrefix + data.slot.name, text);
      return { success: true, slot: data.slot.name };
    } catch {
      return { success: false, error: "Import file is not valid JSON" };
    }
  }
}
