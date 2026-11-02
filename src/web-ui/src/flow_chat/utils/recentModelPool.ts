import type { ModelPoolDefinition } from '@/infrastructure/api/service-api/ModelPoolAPI';

const STORAGE_PREFIX = 'openbitfun.model-selection.pool.v1:';

/** Device/session-scoped UI preference; the host owns the actual selection. */
export function getRecentModelPool(scopeKey: string): string | undefined {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${scopeKey}`)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setRecentModelPool(scopeKey: string, poolId: string): void {
  if (!poolId.trim()) return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${scopeKey}`, poolId.trim());
  } catch {
    // The mounted selector retains its own fallback when storage is unavailable.
  }
}

export function isSelectablePool(pool: ModelPoolDefinition, availableModelIds: ReadonlySet<string>): boolean {
  return ['ordered', 'balanced'].includes(pool.strategy)
    && pool.member_model_ids.some(id => availableModelIds.has(id));
}

/** Returning undefined leaves the choice to the pool list without changing the session. */
export function poolForModeSwitch(
  pools: ModelPoolDefinition[], availableModelIds: ReadonlySet<string>, rememberedId?: string,
): ModelPoolDefinition | undefined {
  const available = pools.filter(pool => isSelectablePool(pool, availableModelIds));
  return available.find(pool => pool.id === rememberedId) ?? (available.length === 1 ? available[0] : undefined);
}
