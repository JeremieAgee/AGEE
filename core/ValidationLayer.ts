export interface ValidationWarning {
  type: string;
  message: string;
  entityId?: number;
  handle?: number;
  timestamp: number;
}

export class ValidationLayer {
  private enabled = true;
  private warnings: ValidationWarning[] = [];
  private maxWarnings = 1000;
  private seenWarnings = new Set<string>();

  private releasedHandles = new Set<number>();
  private activeAllocations = new Map<number, string>(); // handle -> type

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // --- Entity validation ---

  checkEntityAlive(eid: number, context: string, isAliveFn: (eid: number) => boolean): boolean {
    if (!this.enabled) return true;
    if (isAliveFn(eid)) return true;
    this.pushWarning('DEAD_ENTITY', `${context}: entity ${eid} is dead or recycled`, eid);
    return false;
  }

  checkEntityBounds(eid: number, context: string, maxEntity: number): boolean {
    if (!this.enabled) return true;
    if (eid >= 0 && eid < maxEntity) return true;
    this.pushWarning('ENTITY_OUT_OF_BOUNDS', `${context}: entity ${eid} out of bounds [0, ${maxEntity})`, eid);
    return false;
  }

  // --- Handle validation ---

  checkHandleValid(handle: number, context: string, isValidFn: (h: number) => boolean): boolean {
    if (!this.enabled) return true;
    if (isValidFn(handle)) return true;
    this.pushWarning('INVALID_HANDLE', `${context}: handle ${handle} is invalid`, undefined, handle);
    return false;
  }

  // --- Component access validation ---

  checkComponentAccess(eid: number, componentName: string, hasComponentFn: (eid: number) => boolean): boolean {
    if (!this.enabled) return true;
    if (hasComponentFn(eid)) return true;
    this.pushWarning('MISSING_COMPONENT', `entity ${eid} does not have component "${componentName}"`, eid);
    return false;
  }

  // --- Reference counting ---

  checkRefCountPositive(handle: number, refCount: number, context: string): boolean {
    if (!this.enabled) return true;
    if (refCount > 0) return true;
    this.pushWarning('ZERO_REFCOUNT', `${context}: handle ${handle} has refCount ${refCount}`, undefined, handle);
    return false;
  }

  checkNoDoubleRelease(handle: number, context: string): boolean {
    if (!this.enabled) return true;
    if (this.releasedHandles.has(handle)) {
      this.pushWarning('DOUBLE_RELEASE', `${context}: handle ${handle} released more than once`, undefined, handle);
      return false;
    }
    this.releasedHandles.add(handle);
    return true;
  }

  // --- Transform validation ---

  checkTransformFinite(eid: number, x: number, y: number, z: number): boolean {
    if (!this.enabled) return true;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return true;
    this.pushWarning(
      'NON_FINITE_TRANSFORM',
      `entity ${eid} has non-finite transform (${x}, ${y}, ${z})`,
      eid,
    );
    return false;
  }

  // --- Resource leak detection ---

  trackAllocation(handle: number, type: string): void {
    if (!this.enabled) return;
    this.activeAllocations.set(handle, type);
    // If a previously released handle is re-allocated, clear its released state
    this.releasedHandles.delete(handle);
  }

  trackDeallocation(handle: number): void {
    if (!this.enabled) return;
    this.activeAllocations.delete(handle);
  }

  reportLeaks(): ValidationWarning[] {
    const leaks: ValidationWarning[] = [];
    const now = performance.now();
    for (const [handle, type] of this.activeAllocations) {
      leaks.push({
        type: 'RESOURCE_LEAK',
        message: `handle ${handle} (type: ${type}) was allocated but never deallocated`,
        handle,
        timestamp: now,
      });
    }
    return leaks;
  }

  // --- Query ---

  getWarnings(): readonly ValidationWarning[] {
    return this.warnings;
  }

  getWarningCount(): number {
    return this.warnings.length;
  }

  clearWarnings(): void {
    this.warnings.length = 0;
    this.seenWarnings.clear();
    this.releasedHandles.clear();
    this.activeAllocations.clear();
  }

  // --- Reporting ---

  dumpReport(): void {
    if (this.warnings.length === 0) {
      console.log('[ValidationLayer] No warnings.');
      return;
    }

    const grouped = new Map<string, ValidationWarning[]>();
    for (const w of this.warnings) {
      let group = grouped.get(w.type);
      if (!group) {
        group = [];
        grouped.set(w.type, group);
      }
      group.push(w);
    }

    console.group(`[ValidationLayer] ${this.warnings.length} warning(s)`);
    for (const [type, items] of grouped) {
      console.group(`${type} (${items.length})`);
      for (const item of items) {
        console.warn(item.message);
      }
      console.groupEnd();
    }
    console.groupEnd();
  }

  // --- Internal ---

  private pushWarning(type: string, message: string, entityId?: number, handle?: number): void {
    // Dedup by type + entityId
    const key = entityId !== undefined ? `${type}:${entityId}` : `${type}:h${handle}`;
    if (this.seenWarnings.has(key)) return;
    this.seenWarnings.add(key);

    if (this.warnings.length >= this.maxWarnings) return;

    this.warnings.push({
      type,
      message,
      entityId,
      handle,
      timestamp: performance.now(),
    });
  }
}
