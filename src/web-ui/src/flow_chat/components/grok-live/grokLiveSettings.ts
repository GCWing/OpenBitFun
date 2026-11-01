export interface GrokLiveSettings {
  size: number;
  fps: 'auto' | '60' | '120';
  follow: boolean;
  idleMotion: boolean;
  glow: boolean;
  showStats: boolean;
}

export const DEFAULT_GROK_LIVE_SETTINGS: GrokLiveSettings = {
  size: 96, fps: 'auto', follow: true, idleMotion: true, glow: false, showStats: false,
};

const KEY = 'openbitfun.grok-live.settings.v1';
const EVENT = 'openbitfun:grok-live-settings';
const CHANNEL = 'openbitfun-grok-live-settings';

export function readGrokLiveSettings(): GrokLiveSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<GrokLiveSettings>;
    return {
      size: typeof saved.size === 'number' && Number.isFinite(saved.size)
        ? Math.max(64, Math.min(128, Math.round(saved.size))) : 96,
      fps: saved.fps === '60' || saved.fps === '120' ? saved.fps : 'auto',
      follow: typeof saved.follow === 'boolean' ? saved.follow : true,
      idleMotion: typeof saved.idleMotion === 'boolean' ? saved.idleMotion : true,
      glow: saved.glow === true,
      showStats: saved.showStats === true,
    };
  } catch {
    return { ...DEFAULT_GROK_LIVE_SETTINGS };
  }
}

export function saveGrokLiveSettings(patch: Partial<GrokLiveSettings>): GrokLiveSettings {
  const next = { ...readGrokLiveSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage('changed');
      channel.close();
    }
  } catch { /* Cross-window broadcast is optional; persisted settings still load at startup. */ }
  window.dispatchEvent(new Event(EVENT));
  return next;
}

export function subscribeGrokLiveSettings(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) onChange(); };
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', onChange);
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  if (channel) channel.onmessage = onChange;
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', onChange);
    channel?.close();
  };
}
