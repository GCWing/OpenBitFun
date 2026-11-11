import {
  DEFAULT_SETTINGS,
  LIVING_LINE_SETTINGS_KEY,
  type LivingLineSettings,
  validateSettings,
} from './settings';

export {
  DEFAULT_SETTINGS,
  LIVING_LINE_SETTINGS_KEY,
  loadSettings,
  saveSettings,
  validateSettings,
  type LivingLineSettings,
} from './settings';

export const LIVING_LINE_SETTINGS_EVENT = 'openbitfun:living-line-settings';
export const LIVING_LINE_SETTINGS_CHANNEL = 'openbitfun-living-line-settings';

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLivingLineSettings(): LivingLineSettings {
  const storage = getStorage();
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(LIVING_LINE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return validateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveLivingLineSettings(patch: Partial<LivingLineSettings>): LivingLineSettings {
  const storage = getStorage();
  if (!storage) throw new Error('LivingLine settings storage is unavailable');
  const next = validateSettings({ ...readLivingLineSettings(), ...patch });
  storage.setItem(LIVING_LINE_SETTINGS_KEY, JSON.stringify(next));

  try {
    window.dispatchEvent(new CustomEvent(LIVING_LINE_SETTINGS_EVENT));
  } catch {
    /* Event dispatch is best-effort; persisted settings remain authoritative. */
  }

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(LIVING_LINE_SETTINGS_CHANNEL);
      channel.postMessage('changed');
      channel.close();
    }
  } catch {
    /* Cross-window broadcast is optional. */
  }

  return next;
}

export function subscribeLivingLineSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LIVING_LINE_SETTINGS_KEY) listener();
  };
  const handleCustom = () => listener();
  const handleFocus = () => listener();

  window.addEventListener('storage', handleStorage);
  window.addEventListener(LIVING_LINE_SETTINGS_EVENT, handleCustom);
  window.addEventListener('focus', handleFocus);

  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(LIVING_LINE_SETTINGS_CHANNEL);
      channel.onmessage = handleCustom;
    }
  } catch {
    channel = null;
  }

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(LIVING_LINE_SETTINGS_EVENT, handleCustom);
    window.removeEventListener('focus', handleFocus);
    channel?.close();
  };
}