import { createStore } from 'zustand/vanilla';

export const SIDEBAR_PREFERENCES_KEY = 'openbitfun:appearance:sidebar';
export const DEFAULT_SIDEBAR_PINS = ['builtin.todos'];
// The old standalone import page moved into Settings. Keep its saved ID for
// older installs, but exclude it from the current sidebar and visible ordering.
export const isVisibleSidebarPin = (id: string) => id !== 'builtin.external-import';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StorageIssue = 'read' | 'version' | 'write' | null;

function browserStorage(): PreferenceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** Controller presentation only: no host config writes or surface-owned resource IDs. */
export function createSidebarPreferences(storage = browserStorage()) {
  let record: Record<string, unknown> = { version: 1, pinnedIds: DEFAULT_SIDEBAR_PINS };
  let storageIssue: StorageIssue = null;
  try {
    const raw = storage?.getItem(SIDEBAR_PREFERENCES_KEY);
    if (raw !== null && raw !== undefined) {
      const saved: unknown = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid sidebar preferences');
      const candidate = saved as Record<string, unknown>;
      if (candidate.version !== undefined && candidate.version !== 1) storageIssue = 'version';
      else if (!Array.isArray(candidate.pinnedIds) || candidate.pinnedIds.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('Invalid sidebar pins');
      } else record = { ...candidate, version: 1, pinnedIds: [...new Set(candidate.pinnedIds)] };
    }
  } catch { storageIssue = 'read'; }

  return createStore<{
    pinnedIds: string[];
    storageIssue: StorageIssue;
    setPinned: (id: string, pinned: boolean) => void;
    move: (id: string, direction: -1 | 1) => void;
    reset: () => void;
  }>((set, get) => {
    const save = (pinnedIds: string[], reset = false) => {
      if (!reset && (get().storageIssue === 'read' || get().storageIssue === 'version')) return;
      const next = { ...record, version: 1, pinnedIds };
      try {
        if (!storage) throw new Error('Storage unavailable');
        storage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify(next));
        record = next;
        set({ pinnedIds, storageIssue: null });
      } catch { set({ storageIssue: 'write' }); }
    };
    return {
      pinnedIds: [...record.pinnedIds as string[]],
      storageIssue,
      setPinned: (id, pinned) => {
        const ids = get().pinnedIds;
        if (!id.trim() || ids.includes(id) === pinned) return;
        save(pinned ? [...ids, id] : ids.filter(current => current !== id));
      },
      move: (id, direction) => {
        const ids = [...get().pinnedIds];
        const index = ids.indexOf(id);
        let target = index + direction;
        while (target >= 0 && target < ids.length && !isVisibleSidebarPin(ids[target])) target += direction;
        if (index < 0 || target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        save(ids);
      },
      reset: () => save([...DEFAULT_SIDEBAR_PINS], true),
    };
  });
}

export const sidebarPreferences = createSidebarPreferences();
