import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openbitfun:session-menu-preferences:v1';
const ACTIONS = ['rename', 'copyId', 'duplicate', 'openStorage', 'export', 'scheduledJobs', 'archive', 'manage', 'openWorktreeWorkspace', 'delete'] as const;
export type SessionMenuAction = typeof ACTIONS[number];
export interface SessionMenuPreferences {
  hiddenActions: SessionMenuAction[];
  showArchiveNotice: boolean;
  confirmDelete: boolean;
  confirmBtwClose: boolean;
}
const DEFAULTS: SessionMenuPreferences = {
  hiddenActions: [],
  showArchiveNotice: true,
  confirmDelete: true,
  confirmBtwClose: true,
};
let snapshot = load();
const listeners = new Set<() => void>();

function load(): SessionMenuPreferences {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SessionMenuPreferences>;
    return {
      hiddenActions: Array.isArray(parsed.hiddenActions)
        ? parsed.hiddenActions.filter((action): action is SessionMenuAction => ACTIONS.includes(action as SessionMenuAction))
        : [],
      showArchiveNotice: parsed.showArchiveNotice !== false,
      confirmDelete: parsed.confirmDelete !== false,
      confirmBtwClose: parsed.confirmBtwClose !== false,
    };
  } catch {
    return DEFAULTS;
  }
}
function publish(next: SessionMenuPreferences) {
  snapshot = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep the current surface usable when storage is unavailable. */ }
  listeners.forEach(listener => listener());
}
export function setSessionMenuPreference<K extends keyof SessionMenuPreferences>(key: K, value: SessionMenuPreferences[K]) {
  publish({ ...snapshot, [key]: value });
}
export function toggleSessionMenuAction(action: SessionMenuAction, visible: boolean) {
  const hiddenActions = new Set(snapshot.hiddenActions);
  if (visible) hiddenActions.delete(action); else hiddenActions.add(action);
  publish({ ...snapshot, hiddenActions: [...hiddenActions] });
}
export function useSessionMenuPreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
