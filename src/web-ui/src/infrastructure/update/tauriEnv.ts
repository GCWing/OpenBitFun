/** True when running inside the Tauri desktop shell (not pure browser dev). */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** Manual update actions are available in every desktop build. */
export function canCheckForAppUpdates(): boolean {
  return isTauriRuntime();
}

/** Development builds skip background discovery. */
export function canAutoCheckForAppUpdates(): boolean {
  return canCheckForAppUpdates() && !import.meta.env.DEV;
}
