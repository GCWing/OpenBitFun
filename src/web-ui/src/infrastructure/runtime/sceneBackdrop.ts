import { emitTo } from '@tauri-apps/api/event';
import { createLogger } from '@/shared/utils/logger';
import { isMacOSDesktopRuntime } from './environment';

const log = createLogger('SceneBackdrop');
const event = 'window://scene-backdrop';

export interface NativeSceneSurface {
  left: number;
  top: number;
  right: number;
  bottom: number;
  topLeftRadius: number;
  bottomLeftRadius: number;
  pixelRatio: number;
  color: [number, number, number];
}

/** Resolve the browser's computed CSS color, including color-mix/wide-gamut CSS. */
function opaqueColor(value: string): NativeSceneSurface['color'] | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  // Translucent/custom surfaces must keep their existing composition.
  return alpha === 255 ? [red, green, blue] : null;
}

/** Controller-local paint beneath the page. Older hosts simply ignore it. */
export function observeNativeSceneBackdrop(element: HTMLElement): {
  refresh: () => void;
  dispose: () => void;
} {
  if (!isMacOSDesktopRuntime()) return { refresh() {}, dispose() {} };
  const clientId = crypto.randomUUID();
  let disposed = false;
  let frame: number | undefined;
  let lastPayload: string | undefined;
  let colorValue: string | undefined;
  let color: NativeSceneSurface['color'] | null = null;
  const publish = (surface: NativeSceneSurface | null) => {
    const payload = JSON.stringify(surface);
    if (payload === lastPayload) return;
    lastPayload = payload;
    void emitTo('main', event, { version: 1, clientId, surface })
      .catch(error => log.warn('Native scene background unavailable', { error }));
  };
  const measure = () => {
    frame = undefined;
    if (disposed) return;
    const rect = element.getBoundingClientRect();
    if (!element.isConnected || rect.width <= 0 || rect.height <= 0) {
      publish(null); return;
    }
    const style = getComputedStyle(element);
    if (style.backgroundColor !== colorValue) {
      colorValue = style.backgroundColor;
      color = opaqueColor(colorValue);
    }
    if (!color || (style.backgroundImage && style.backgroundImage !== 'none')
      || (style.opacity && Number(style.opacity) !== 1)) {
      publish(null); return;
    }
    publish({
      left: Math.max(0, rect.left), top: Math.max(0, rect.top),
      right: Math.max(0, window.innerWidth - rect.right),
      bottom: Math.max(0, window.innerHeight - rect.bottom),
      topLeftRadius: Number.parseFloat(style.borderTopLeftRadius) || 0,
      bottomLeftRadius: Number.parseFloat(style.borderBottomLeftRadius) || 0,
      pixelRatio: window.devicePixelRatio,
      color,
    });
  };
  const refresh = () => {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(measure);
  };
  const observer = new ResizeObserver(refresh);
  observer.observe(element);
  window.addEventListener('resize', refresh);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', refresh);
      if (frame !== undefined) cancelAnimationFrame(frame);
      void emitTo('main', event, { version: 1, clientId, release: true })
        .catch(error => log.warn('Failed to release native scene background', { error }));
    },
  };
}
