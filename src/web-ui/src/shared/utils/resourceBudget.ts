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

declare global {
  var __OPENBITFUN_RESOURCE_BUDGET__: Pick<ResourceBudget, 'snapshot'> | undefined;
}
// Read-only logical accounting for native performance diagnostics. No cache
// mutation, authoritative payloads, DOM references or forced collection API.
if (import.meta.env.DEV || globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ === true) {
  globalThis.__OPENBITFUN_RESOURCE_BUDGET__ = { snapshot: () => resourceBudget.snapshot() };
}

const completedModelRoundBytesCache = new WeakMap<object, { itemsRef: unknown; attemptsRef: unknown; bytes: number }>();
const turnCompletedRoundPrefixCache = new Map<string, {
  firstRound: object;
  lastCompletedRound: object;
  completedCount: number;
  prefixBytes: number;
}>();

function isCacheableCompletedModelRound(obj: Record<string, unknown>): boolean {
  return (
    obj.status === 'completed' &&
    obj.isStreaming === false &&
    obj.isComplete === true &&
    typeof obj.id === 'string' &&
    Array.isArray(obj.items)
  );
}

function estimateCompletedRoundBytes(round: Record<string, unknown>, seen: Set<object>): number {
  const cached = completedModelRoundBytesCache.get(round);
  if (cached && cached.itemsRef === round.items && cached.attemptsRef === round.attempts) {
    return cached.bytes;
  }
  let roundBytes = 32;
  for (const [key, child] of Object.entries(round)) {
    roundBytes += key.length * 2 + 8 + estimateRetainedBytes(child, seen);
  }
  completedModelRoundBytesCache.set(round, {
    itemsRef: round.items,
    attemptsRef: round.attempts,
    bytes: roundBytes,
  });
  return roundBytes;
}

function estimateModelRoundsArrayBytes(
  turnId: string,
  rounds: unknown[],
  seen: Set<object>,
): number {
  if (seen.has(rounds)) return 0;
  seen.add(rounds);
  const totalLen = rounds.length;
  if (totalLen === 0) return 32;

  const completedPrefixCount =
    totalLen > 1 &&
    rounds[0] &&
    typeof rounds[0] === 'object' &&
    isCacheableCompletedModelRound(rounds[totalLen - 2] as Record<string, unknown>)
      ? totalLen - 1
      : 0;

  let startIdx = 0;
  let bytes = 32;

  if (completedPrefixCount > 0) {
    const firstRound = rounds[0] as object;
    const lastCompleted = rounds[completedPrefixCount - 1] as object;
    const prevPrefix = turnCompletedRoundPrefixCache.get(turnId);
    if (
      prevPrefix &&
      prevPrefix.firstRound === firstRound &&
      prevPrefix.completedCount === completedPrefixCount &&
      prevPrefix.lastCompletedRound === lastCompleted
    ) {
      bytes += prevPrefix.prefixBytes;
      startIdx = completedPrefixCount;
    } else {
      let prefixBytes = 0;
      let allCompleted = true;
      for (let i = 0; i < completedPrefixCount; i += 1) {
        const round = rounds[i];
        if (!round || typeof round !== 'object' || !isCacheableCompletedModelRound(round as Record<string, unknown>)) {
          allCompleted = false;
          break;
        }
        const indexDigits = String(i).length;
        seen.add(round);
        prefixBytes += indexDigits * 2 + 8 + estimateCompletedRoundBytes(round as Record<string, unknown>, seen);
      }
      if (allCompleted) {
        turnCompletedRoundPrefixCache.set(turnId, {
          firstRound,
          lastCompletedRound: lastCompleted,
          completedCount: completedPrefixCount,
          prefixBytes,
        });
        bytes += prefixBytes;
        startIdx = completedPrefixCount;
      }
    }
  }

  for (let i = startIdx; i < totalLen; i += 1) {
    const indexDigits = String(i).length;
    bytes += indexDigits * 2 + 8 + estimateRetainedBytes(rounds[i], seen);
  }
  return bytes;
}

/** No stringify-sized temporary copy. Shared references are counted once per working set. */
export function estimateRetainedBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (isCacheableCompletedModelRound(record)) {
    return estimateCompletedRoundBytes(record, seen);
  }
  const isDialogTurn = typeof record.id === 'string' && Array.isArray(record.modelRounds);
  let bytes = 32;
  for (const [key, child] of Object.entries(record)) {
    if (isDialogTurn && key === 'modelRounds' && Array.isArray(child)) {
      bytes += key.length * 2 + 8 + estimateModelRoundsArrayBytes(record.id as string, child, seen);
    } else {
      bytes += key.length * 2 + 8 + estimateRetainedBytes(child, seen);
    }
  }
  return bytes;
}
