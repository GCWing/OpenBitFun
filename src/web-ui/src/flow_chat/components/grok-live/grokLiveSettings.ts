export interface GrokLiveSettings {
  size: number;
  fps: 'auto' | '60' | '120';
  follow: boolean;
  idleMotion: boolean;
  glow: boolean;
  showStats: boolean;
  bodyColor: 'black' | 'darkGray' | 'gray' | 'custom';
  bodyCustomColor: string;
  eyeColor: 'white' | 'lightGray' | 'custom';
  eyeCustomColor: string;
}

export const DEFAULT_GROK_LIVE_SETTINGS: GrokLiveSettings = {
  size: 96, fps: 'auto', follow: true, idleMotion: true, glow: false, showStats: false,
  bodyColor: 'black', bodyCustomColor: '#000000',
  eyeColor: 'white', eyeCustomColor: '#ffffff',
};

const BODY_COLOR_PRESETS: Record<string, string> = {
  black: '#000000', darkGray: '#3a3a3a', gray: '#737373',
};
const EYE_COLOR_PRESETS: Record<string, string> = {
  white: '#ffffff', lightGray: '#d9d9d9',
};

export function resolveGrokBodyColorHex(settings: GrokLiveSettings): string {
  if (settings.bodyColor === 'custom') return normalizeHex(settings.bodyCustomColor, '#000000');
  return BODY_COLOR_PRESETS[settings.bodyColor] ?? '#000000';
}

export function resolveGrokEyeColorHex(settings: GrokLiveSettings): string {
  if (settings.eyeColor === 'custom') return normalizeHex(settings.eyeCustomColor, '#ffffff');
  return EYE_COLOR_PRESETS[settings.eyeColor] ?? '#ffffff';
}

function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
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
      bodyColor: saved.bodyColor === 'darkGray' || saved.bodyColor === 'gray' || saved.bodyColor === 'custom'
        ? saved.bodyColor : 'black',
      bodyCustomColor: normalizeHex(saved.bodyCustomColor, '#000000'),
      eyeColor: saved.eyeColor === 'lightGray' || saved.eyeColor === 'custom' ? saved.eyeColor : 'white',
      eyeCustomColor: normalizeHex(saved.eyeCustomColor, '#ffffff'),
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
