import { createStore } from 'zustand/vanilla';

export type BrowserLinkTarget = 'builtin' | 'external';
export const BROWSER_LINK_TARGET_STORAGE_KEY = 'openbitfun:browserLinkTarget';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function controllerStorage(): PreferenceStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

/** Link presentation belongs to the controller, independent of the selected host. */
export function createBrowserLinkPreferenceStore(storage = controllerStorage()) {
  let saved: string | null | undefined;
  try { saved = storage?.getItem(BROWSER_LINK_TARGET_STORAGE_KEY); }
  catch { /* Keep link opening usable when storage is unavailable. */ }

  return createStore<{
    target: BrowserLinkTarget;
    setTarget: (target: BrowserLinkTarget) => void;
  }>((set) => ({
    // Existing installs keep their behavior; unknown records are left intact.
    target: saved === 'external' ? 'external' : 'builtin',
    setTarget: target => {
      try { storage?.setItem(BROWSER_LINK_TARGET_STORAGE_KEY, target); }
      catch { /* Retain the selection for this window when persistence fails. */ }
      set({ target });
    },
  }));
}

export const browserLinkPreferenceStore = createBrowserLinkPreferenceStore();
