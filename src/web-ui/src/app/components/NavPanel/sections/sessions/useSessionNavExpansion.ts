import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { SESSIONS_INITIAL_COUNT } from './sessionNavExpand';

/**
 * Expansion belongs to the device/workspace/source view, not either of its
 * live and background React projections. Publish a click immediately: during
 * replacement React renders the new list before cleaning up the old one.
 * An unmount hand-off therefore always arrives too late (and can leave an
 * older expanded value for the next switch).
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const notify = () => { for (const listener of listeners) listener(); };

/** Reset one workspace's source views, or every view for Collapse All. */
export function resetSessionNavExpansion(workspaceScope?: string): void {
  let changed = false;
  for (const key of counts.keys()) {
    if (workspaceScope === undefined || key === workspaceScope || key.startsWith(`${workspaceScope}:`)) {
      counts.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

export function useSessionNavExpansion(scope: string, { visible = true }: { visible?: boolean } = {}) {
  const read = useCallback(() => counts.get(scope) ?? SESSIONS_INITIAL_COUNT, [scope]);
  const displayCount = useSyncExternalStore(subscribe, read, read);
  // Retained live lists also support visibility without being unmounted.
  // Background lists reset at the workspace disclosure action, before unmount.
  useLayoutEffect(() => { if (!visible) resetSessionNavExpansion(scope); }, [scope, visible]);
  const setDisplayCount = useCallback((value: number) => {
    const next = Math.max(SESSIONS_INITIAL_COUNT, value);
    if (next === (counts.get(scope) ?? SESSIONS_INITIAL_COUNT)) return;
    if (next === SESSIONS_INITIAL_COUNT) counts.delete(scope);
    else counts.set(scope, next);
    notify();
  }, [scope]);
  return { displayCount: visible ? displayCount : SESSIONS_INITIAL_COUNT, setDisplayCount };
}
