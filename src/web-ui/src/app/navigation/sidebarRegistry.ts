import type { IconName } from '@openbitfun/ui';
import type { SceneTabId } from '@/app/components/SceneBar/types';

/** Bootstrap labels keep sidebar rendering independent of feature chunks. */
export type SidebarLabelKey = `common:${string}` | `shared:${string}`;

export interface SidebarContext {
  activeSceneId: SceneTabId | null;
  skillsTab: 'installed' | 'discover';
  isDesktop: boolean;
  isPeer: boolean;
  surfaceId: string;
}

export interface SidebarContribution {
  /** Stable, owner-namespaced identity. Never persist a label, callback or path. */
  id: string;
  labelKey: SidebarLabelKey;
  icon: IconName;
  isActive: (context: SidebarContext) => boolean;
  unavailableReason?: (context: SidebarContext) => SidebarLabelKey | null;
  /** Lazy preparation must check the captured surface before opening a destination. */
  open: (scope: { isCurrent: () => boolean }) => void | Promise<void>;
}

/** Trusted frontend contributions only; this is not a plugin execution boundary. */
export function createSidebarRegistry(initial: readonly SidebarContribution[] = []) {
  let entries: readonly SidebarContribution[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const registry = {
    getSnapshot: () => entries,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    register: (entry: SidebarContribution) => {
      if (!entry.id.includes('.') || entries.some(current => current.id === entry.id)) {
        throw new Error(`Invalid or duplicate sidebar contribution: ${entry.id}`);
      }
      const registered = Object.freeze({ ...entry });
      entries = [...entries, registered];
      notify();
      return () => {
        if (!entries.includes(registered)) return;
        entries = entries.filter(current => current !== registered);
        notify();
      };
    },
  };
  initial.forEach(registry.register);
  return registry;
}

/** One exact pinned destination wins; callers may then fall back to Home. */
export function selectedSidebarEntry(
  entries: readonly SidebarContribution[], pinnedIds: readonly string[], context: SidebarContext,
): string | undefined {
  return pinnedIds.find(id => {
    const entry = entries.find(candidate => candidate.id === id);
    return entry && !entry.unavailableReason?.(context) && entry.isActive(context);
  });
}
