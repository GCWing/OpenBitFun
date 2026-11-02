export interface BudgetedResource {
  /** Logical retained bytes, not process memory or GPU memory. */
  bytes: number;
  kind: 'derived' | 'history';
  lastUsedAt: number;
  /** Re-evaluated at eviction time; a lease must never be a stale render flag. */
  protectedReason?: () => string | undefined;
  evict: () => void;
}

/** Coordinates reconstructable caches. Documents, drafts and runtime state are not caches. */
export class ResourceBudget {
  private resources = new Map<object, BudgetedResource>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private trimming = false;

  constructor(readonly softBytes = 64 * 1024 * 1024, readonly hardBytes = 96 * 1024 * 1024) {}

  set(key: object, resource: BudgetedResource): void {
    this.resources.set(key, resource);
    this.schedule();
  }

  touch(key: object): void {
    const resource = this.resources.get(key);
    if (resource) resource.lastUsedAt = Date.now();
  }

  delete(key: object): void { this.resources.delete(key); }

  get byteSize(): number {
    let bytes = 0;
    for (const resource of this.resources.values()) bytes += resource.bytes;
    return bytes;
  }

  canPrefetch(): boolean { return this.byteSize < this.softBytes; }

  snapshot() {
    return [...this.resources.values()].map(resource => ({
      kind: resource.kind, bytes: resource.bytes, lastUsedAt: resource.lastUsedAt,
      protectedReason: resource.protectedReason?.(),
    }));
  }

  /** A host adapter may request pressure relief without reaching into product owners. */
  trim(pressure = false): void {
    if (this.trimming) return;
    this.trimming = true;
    try {
      let bytes = this.byteSize;
      if (!pressure && bytes <= this.hardBytes) return;
      const candidates = [...this.resources.entries()].sort(([, a], [, b]) =>
        Number(a.kind === 'history') - Number(b.kind === 'history') || a.lastUsedAt - b.lastUsedAt);
      for (const [key, resource] of candidates) {
        if (bytes <= this.softBytes) break;
        if (resource.protectedReason?.()) continue;
        // Remove accounting before invoking the owner; disposal can synchronously
        // publish state and register a newer resource under the same key.
        this.resources.delete(key);
        bytes -= resource.bytes;
        resource.evict();
      }
    } finally {
      this.trimming = false;
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    // Coalesce writes outside rendering. Age alone does not justify turning a
    // warm session into a blocking read, and needs no recurring sweep.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.trim();
    }, 0);
  }
}

export const resourceBudget = new ResourceBudget();

/** No stringify-sized temporary copy. Shared references are counted once per working set. */
export function estimateRetainedBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 32;
  for (const [key, child] of Object.entries(value)) {
    bytes += key.length * 2 + 8 + estimateRetainedBytes(child, seen);
  }
  return bytes;
}
