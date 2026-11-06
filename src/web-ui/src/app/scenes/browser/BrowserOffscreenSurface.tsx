import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { decompress } from 'fzstd';
import './BrowserOffscreenSurface.scss';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createOffscreenGpu } from './browserOffscreenGpu';
import { listenForBrowserTextures, listenForBrowserTextureUi, type BrowserTextureUi } from './browserOsrTextureBridge';

const LEGACY_HEADER_BYTES = 20;
const FRAME_HEADER_BYTES = 52;
const FRAME_MAGIC = 0x3152534f;
const COMPRESSED_FRAME_MAGIC = 0x3352534f;
const MAX_FRAME_PIXELS = 24_000_000;
const CURSORS = ['default', 'pointer', 'text', 'crosshair', 'wait', 'not-allowed', 'grab', 'grabbing',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'move', 'none', 'progress'];
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const MAX_INPUT_BATCH = 32;

type Viewport = { width: number; height: number };
type Pointer = Viewport & { x: number; y: number; modifiers: number; panelOrigin: [number, number] };
type BrowserInput =
  | { kind: 'move'; pointer: Pointer }
  | { kind: 'button'; pointer: Pointer; button: 'left' | 'middle' | 'right'; up: boolean; clicks: number }
  | { kind: 'wheel'; pointer: Pointer; deltaX: number; deltaY: number }
  | { kind: 'leave' }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'key'; key: string; code: string; virtualKey: number; modifiers: number; location: number; repeat: boolean; up: boolean; text: string }
  | { kind: 'composition'; text: string; commit: boolean };

type DrawPixels = NonNullable<ReturnType<typeof createOffscreenGpu>>['draw'];

function drawFrame(surface: HTMLDivElement, backdrop: HTMLDivElement, canvas: HTMLCanvasElement, drawPixels: DrawPixels,
  previousSize: Viewport | undefined, buffer: ArrayBuffer) {
  const header = new DataView(buffer);
  const magic = header.getUint32(0, true);
  const compressed = magic === COMPRESSED_FRAME_MAGIC;
  const modern = compressed || magic === FRAME_MAGIC;
  const offset = modern ? 4 : 0;
  const headerBytes = modern ? FRAME_HEADER_BYTES : LEGACY_HEADER_BYTES;
  const revision = header.getUint32(offset, true);
  const width = header.getUint32(offset + 4, true);
  const height = header.getUint32(offset + 8, true);
  const viewWidth = header.getUint32(offset + 12, true);
  const viewHeight = header.getUint32(offset + 16, true);
  const x = modern ? header.getUint32(24, true) : 0;
  const y = modern ? header.getUint32(28, true) : 0;
  const patchWidth = modern ? header.getUint32(32, true) : width;
  const patchHeight = modern ? header.getUint32(36, true) : height;
  const patchPixels = patchWidth * patchHeight;
  const resized = previousSize?.width !== width || previousSize?.height !== height;
  if (!revision || !width || !height || !viewWidth || !viewHeight
    || x + patchWidth > width || y + patchHeight > height
    || patchPixels > MAX_FRAME_PIXELS
    || (!compressed && buffer.byteLength !== headerBytes + patchPixels * 4)
    || (resized && (x || y || patchWidth !== width || patchHeight !== height))) {
    throw new Error('Invalid offscreen browser frame');
  }

  if (patchWidth && patchHeight) {
    const payload = new Uint8Array(buffer, headerBytes);
    const pixels = compressed ? decompress(payload) : payload;
    if (pixels.byteLength !== patchPixels * 4) throw new Error('Invalid offscreen browser pixels');
    if (patchWidth === width && patchHeight === height) {
      // The viewport can grow before the next Chromium paint. Fill the newly
      // exposed area with the page color sampled just inside the scrollbar.
      const column = Math.max(0, width - Math.ceil(16 * width / viewWidth) - 1);
      const rows = [0.3, 0.55, 0.8].map(fraction => Math.floor(height * fraction));
      const colors = rows.map(row => {
        const offset = (row * width + column) * 4;
        return `rgb(${pixels[offset + 2]}, ${pixels[offset + 1]}, ${pixels[offset]})`;
      });
      const color = colors[0] === colors[2] ? colors[0] : colors[1];
      if (backdrop.style.backgroundColor !== color) backdrop.style.backgroundColor = color;
    }
    drawPixels(width, height, x, y, patchWidth, patchHeight, pixels);
  }
  // Size the painted surface in CSS pixels from the same frame as its bitmap.
  // The host clips it until Chromium has reflowed at the next viewport size.
  const cssWidth = `${viewWidth}px`;
  const cssHeight = `${viewHeight}px`;
  if (surface.style.width !== cssWidth) surface.style.width = cssWidth;
  if (surface.style.height !== cssHeight) surface.style.height = cssHeight;
  // WebGL keeps extra capacity during resizing. Map only the painted pixels
  // to the logical viewport. The surface clips the unused backing pixels.
  const backingWidth = `${viewWidth * canvas.width / width}px`;
  const backingHeight = `${viewHeight * canvas.height / height}px`;
  if (canvas.style.width !== backingWidth) canvas.style.width = backingWidth;
  if (canvas.style.height !== backingHeight) canvas.style.height = backingHeight;
  const cursor = modern ? CURSORS[header.getUint32(40, true)] : undefined;
  const caret = modern ? { x: header.getInt32(44, true), y: header.getInt32(48, true) } : undefined;
  return { revision, viewport: { width: viewWidth, height: viewHeight }, size: { width, height }, modern, cursor, caret };
}

function pointerAt(surface: HTMLElement, viewport: Viewport | undefined, event: MouseEvent): Pointer | undefined {
  if (!viewport) return;
  const rect = surface.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.floor((event.clientX - rect.left) * viewport.width / rect.width);
  const y = Math.floor((event.clientY - rect.top) * viewport.height / rect.height);
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return;

  // CEF event flags distinguish the three DOM button bits and four modifiers.
  const modifiers = (event.shiftKey ? 2 : 0) | (event.ctrlKey ? 4 : 0) | (event.altKey ? 8 : 0)
    | (event.buttons & 1 ? 16 : 0) | (event.buttons & 4 ? 32 : 0) | (event.buttons & 2 ? 64 : 0)
    | (event.metaKey ? 128 : 0);
  return { ...viewport, x, y, modifiers, panelOrigin: [Math.round(rect.left), Math.round(rect.top)] };
}

interface Props {
  label: string;
  sharedTexture?: boolean;
  title: string;
  active: boolean;
  inspecting?: boolean;
  onCancelInspection?: () => void;
  onError: (error: unknown) => void;
}

export function BrowserOffscreenSurface({ label, sharedTexture = false, title, active, inspecting, onCancelInspection, onError }: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const popupCanvasRef = useRef<HTMLCanvasElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const [softwareOnly, setSoftwareOnly] = useState(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    const backdrop = backdropRef.current;
    const canvas = canvasRef.current;
    const keyboard = keyboardRef.current;
    if (!active || !surface || !backdrop || !canvas || !keyboard) return;
    let disposed = false;
    const useSoftwareCanvas = () => {
      if (disposed) return;
      disposed = true;
      setSoftwareOnly(true);
    };
    let gpu: ReturnType<typeof createOffscreenGpu>;
    try {
      gpu = sharedTexture || softwareOnly ? undefined : createOffscreenGpu(canvas);
    } catch {
      useSoftwareCanvas();
      return;
    }
    const context = gpu || sharedTexture ? null : canvas.getContext('2d');
    if (!sharedTexture && !gpu && !context) {
      onError(new Error('Offscreen browser canvas is unavailable'));
      return;
    }
    const drawPixels: DrawPixels = (width, height, x, y, patchWidth, patchHeight, bytes) => {
      if (gpu) {
        try {
          gpu.draw(width, height, x, y, patchWidth, patchHeight, bytes);
        } catch (error) {
          useSoftwareCanvas();
          throw error;
        }
      } else if (context) {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const pixels = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        for (let index = 0; index < pixels.length; index++) {
          const bgra = pixels[index];
          pixels[index] = (bgra & 0xff00ff00) | ((bgra & 0xff) << 16) | ((bgra >>> 16) & 0xff);
        }
        const rgba = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        context.putImageData(new ImageData(rgba, patchWidth, patchHeight), x, y);
      }
    };
    if (gpu) canvas.addEventListener('webglcontextlost', useSoftwareCanvas);

    let modern = sharedTexture;
    let composing = false;
    let viewport: Viewport | undefined;
    let size: Viewport | undefined;
    let revision = 0;
    let inputRequest = 0;
    let sending = false;
    const pending: BrowserInput[] = [];
    const startedAt = performance.now();

    const paint = async () => {
      try {
        // Native long polling already waits for damage. Asking for the next
        // frame immediately keeps its delivery off the host's vsync boundary.
        while (!disposed) {
          const requestedAt = performance.now();
          const frame = await api.invoke<ArrayBuffer>('browser_webview_osr_frame', {
            request: { label, afterRevision: revision, protocol: 3 },
          });
          if (disposed) return;
          if (!(frame instanceof ArrayBuffer)) throw new Error('Offscreen browser requires binary IPC');
          if (frame.byteLength) {
            const frameInfo = drawFrame(surface, backdrop, canvas, drawPixels, size, frame);
            ({ revision, viewport, size, modern } = frameInfo);
            canvas.style.cursor = frameInfo.cursor ?? '';
            if (frameInfo.caret && frameInfo.caret.x >= 0 && frameInfo.caret.y >= 0) {
              keyboard.style.left = `${Math.min(99, 100 * frameInfo.caret.x / viewport.width)}%`;
              keyboard.style.top = `${Math.min(99, 100 * frameInfo.caret.y / viewport.height)}%`;
            }
          } else {
            if (!revision && performance.now() - startedAt > FIRST_FRAME_TIMEOUT_MS) {
              throw new Error('The offscreen browser did not produce a frame');
            }
            // Older hosts can return an empty response immediately before their
            // first paint. Avoid spinning while those hosts catch up.
            if (performance.now() - requestedAt < 16) {
              await new Promise<void>(resolve => window.setTimeout(resolve, 16));
            }
          }
        }
      } catch (error) {
        if (!disposed) onError(error);
      }
    };
    let stopTextures: (() => void) | undefined;
    if (sharedTexture) {
      const bitmapContext = canvas.getContext('bitmaprenderer');
      const popup = popupRef.current;
      const popupCanvas = popupCanvasRef.current;
      const popupContext = popupCanvas?.getContext('bitmaprenderer');
      if (!bitmapContext || !popup || !popupCanvas || !popupContext) {
        onError(new Error('Chromium bitmap presentation is unavailable'));
        return;
      }
      const watchdog = window.setTimeout(() => {
        if (!viewport && !disposed) onError(new Error('The CEF texture bridge did not present a frame'));
      }, FIRST_FRAME_TIMEOUT_MS);
      let textureUi: BrowserTextureUi | undefined;
      const applyTextureUi = () => {
        if (!textureUi) return;
        canvas.style.cursor = CURSORS[textureUi.cursor] ?? '';
        const caret = textureUi.caret;
        if (viewport && caret && caret[0] >= 0 && caret[1] >= 0) {
          keyboard.style.left = `${Math.min(99, 100 * caret[0] / viewport.width)}%`;
          keyboard.style.top = `${Math.min(99, 100 * caret[1] / viewport.height)}%`;
        }
      };
      const unlisten = listenForBrowserTextures(label, (isPopup, bitmap, x, y, width, height, left, top, scale, background) => {
        if (disposed) return;
        if (bitmap === undefined) {
          onError(new Error('Chromium could not import the shared browser texture'));
          return;
        }
        if (isPopup && !bitmap) {
          popup.hidden = true;
          popupContext.transferFromImageBitmap(null);
          return;
        }
        if (!bitmap || !Number.isFinite(scale) || scale <= 0 || width <= 0 || height <= 0
          || x < 0 || y < 0 || x + width > bitmap.width || y + height > bitmap.height) {
          onError(new Error('Invalid CEF shared-texture geometry'));
          return;
        }
        const target = isPopup ? popupCanvas : canvas;
        const clip = isPopup ? popup : surface;
        const next = { width: Math.round(width / scale), height: Math.round(height / scale) };
        if (target.width !== bitmap.width) target.width = bitmap.width;
        if (target.height !== bitmap.height) target.height = bitmap.height;
        target.style.width = `${bitmap.width / scale}px`;
        target.style.height = `${bitmap.height / scale}px`;
        target.style.transform = x || y ? `translate(${-x / scale}px, ${-y / scale}px)` : '';
        clip.style.width = `${next.width}px`;
        clip.style.height = `${next.height}px`;
        try {
          (isPopup ? popupContext : bitmapContext).transferFromImageBitmap(bitmap);
        } catch (error) {
          onError(error);
          return;
        }
        if (isPopup) {
          popup.style.left = `${left}px`;
          popup.style.top = `${top}px`;
          popup.hidden = false;
        } else {
          viewport = next;
          applyTextureUi();
          window.clearTimeout(watchdog);
          const color = `rgb(${(background >>> 16) & 255}, ${(background >>> 8) & 255}, ${background & 255})`;
          if (backdrop.style.backgroundColor !== color) backdrop.style.backgroundColor = color;
        }
      });
      let unlistenUi: (() => void) | undefined;
      stopTextures = () => {
        unlisten();
        unlistenUi?.();
        window.clearTimeout(watchdog);
        bitmapContext.transferFromImageBitmap(null);
        popupContext.transferFromImageBitmap(null);
        popup.hidden = true;
      };
      void listenForBrowserTextureUi(label, ui => {
        if (disposed) return;
        textureUi = ui;
        applyTextureUi();
      }).then(stop => {
        if (disposed) {
          stop();
          return;
        }
        unlistenUi = stop;
        return api.invoke('browser_webview_osr_input', { request: { label, events: [{ kind: 'redraw' }] } });
      }).catch(error => { if (!disposed) onError(error); });
    } else {
      void paint();
    }

    // Keep button transitions ordered and collapse pointer motion while IPC is busy.
    const scheduleInput = () => {
      if (!disposed && !inputRequest && !sending && pending.length) {
        inputRequest = window.requestAnimationFrame(() => {
          inputRequest = 0;
          sending = true;
          void api.invoke('browser_webview_osr_input', {
            request: { label, events: pending.splice(0, MAX_INPUT_BATCH) },
          }).catch(error => {
            if (!disposed) onError(error);
          }).finally(() => {
            sending = false;
            scheduleInput();
          });
        });
      }
    };
    const queue = (input: BrowserInput) => {
      const last = pending.at(-1);
      if (input.kind === 'move' && last?.kind === 'move') {
        pending[pending.length - 1] = input;
      } else if (input.kind === 'wheel' && last?.kind === 'wheel'
        && input.pointer.width === last.pointer.width && input.pointer.height === last.pointer.height
        && input.pointer.modifiers === last.pointer.modifiers) {
        last.pointer = input.pointer;
        last.deltaX += input.deltaX;
        last.deltaY += input.deltaY;
      } else {
        if (pending.length >= MAX_INPUT_BATCH * 3) {
          pending.length = 0;
          pending.push({ kind: 'leave' });
        }
        pending.push(input);
      }
      scheduleInput();
    };
    const move = (event: MouseEvent) => {
      const pointer = pointerAt(surface, viewport, event);
      if (pointer) queue({ kind: 'move', pointer });
    };
    const button = (event: MouseEvent) => {
      const pointer = pointerAt(surface, viewport, event);
      const button = (['left', 'middle', 'right'] as const)[event.button];
      if (!pointer || !button) return;
      const up = event.type === 'mouseup';
      if (!up) {
        // The host canvas has no text focus. Keep the browser's input proxy
        // focused after the main workbench handles the native mouse event.
        event.preventDefault();
        keyboard.style.left = `${100 * pointer.x / pointer.width}%`;
        keyboard.style.top = `${100 * pointer.y / pointer.height}%`;
        keyboard.focus({ preventScroll: true });
      }
      queue({ kind: 'button', pointer, button, up, clicks: Math.max(1, event.detail) });
    };
    const wheel = (event: WheelEvent) => {
      const pointer = pointerAt(surface, viewport, event);
      if (!pointer) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pointer.height : 1;
      queue({ kind: 'wheel', pointer, deltaX: -Math.round(event.deltaX * multiplier), deltaY: -Math.round(event.deltaY * multiplier) });
    };
    const leave = () => queue({ kind: 'leave' });
    const focus = (event: FocusEvent) => {
      if (event.relatedTarget === canvas || event.relatedTarget === keyboard) return;
      const focused = event.type === 'focus';
      if (!focused) {
        composing = false;
        keyboard.value = '';
      }
      queue({ kind: 'focus', focused });
    };
    const key = (event: KeyboardEvent) => {
      if (!modern || event.isComposing || composing || event.key === 'Process') return;
      event.preventDefault();
      event.stopPropagation();
      const up = event.type === 'keyup';
      const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
        | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
      const hasText = !up && !event.metaKey && (!event.ctrlKey || event.getModifierState('AltGraph'));
      const text = hasText && (Array.from(event.key).length === 1 || event.key === 'Enter')
        ? event.key === 'Enter' ? '\r' : event.key : '';
      queue({ kind: 'key', key: event.key, code: event.code, virtualKey: event.keyCode,
        modifiers, location: event.location, repeat: event.repeat, up, text });
    };
    const compositionStart = () => { composing = true; };
    const compositionUpdate = (event: CompositionEvent) => {
      if (modern) queue({ kind: 'composition', text: event.data, commit: false });
    };
    const compositionEnd = (event: CompositionEvent) => {
      composing = false;
      keyboard.value = '';
      if (modern) queue({ kind: 'composition', text: event.data, commit: true });
    };

    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mousedown', button);
    canvas.addEventListener('mouseup', button);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('mouseleave', leave);
    keyboard.addEventListener('focus', focus);
    keyboard.addEventListener('blur', focus);
    keyboard.addEventListener('keydown', key);
    keyboard.addEventListener('keyup', key);
    keyboard.addEventListener('compositionstart', compositionStart);
    keyboard.addEventListener('compositionupdate', compositionUpdate);
    keyboard.addEventListener('compositionend', compositionEnd);
    return () => {
      disposed = true;
      stopTextures?.();
      canvas.removeEventListener('webglcontextlost', useSoftwareCanvas);
      gpu?.dispose();
      window.cancelAnimationFrame(inputRequest);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mousedown', button);
      canvas.removeEventListener('mouseup', button);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('mouseleave', leave);
      keyboard.removeEventListener('focus', focus);
      keyboard.removeEventListener('blur', focus);
      keyboard.removeEventListener('keydown', key);
      keyboard.removeEventListener('keyup', key);
      keyboard.removeEventListener('compositionstart', compositionStart);
      keyboard.removeEventListener('compositionupdate', compositionUpdate);
      keyboard.removeEventListener('compositionend', compositionEnd);
    };
  }, [active, label, onError, sharedTexture, softwareOnly]);

  useEffect(() => {
    if (active && inspecting) keyboardRef.current?.focus({ preventScroll: true });
  }, [active, inspecting]);

  const cancelInspection = (event: ReactKeyboardEvent) => {
    if (active && inspecting && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onCancelInspection?.();
    }
  };

  return (
    <>
      <div ref={backdropRef} className="browser-offscreen-surface" hidden={!active} aria-hidden="true"
        data-openbitfun-component="browser-panel" data-openbitfun-part="offscreenSurface">
        <div ref={surfaceRef} className="browser-offscreen-frame"
          data-openbitfun-component="browser-panel" data-openbitfun-part="offscreenFrame">
          <canvas
            key={sharedTexture ? 'shared-texture' : softwareOnly ? 'software' : 'default'}
            ref={canvasRef}
            data-testid="browser-offscreen-surface"
            data-presentation={sharedTexture ? 'shared-texture' : 'cpu-frames'}
            onKeyDownCapture={cancelInspection}
          />
          {sharedTexture && <div ref={popupRef} className="browser-offscreen-popup" hidden
            data-openbitfun-component="browser-panel" data-openbitfun-part="offscreenPopup">
            <canvas ref={popupCanvasRef} />
          </div>}
        </div>
      </div>
      <textarea
        ref={keyboardRef}
        className="browser-offscreen-keyboard"
        data-openbitfun-component="browser-panel"
        data-openbitfun-part="offscreenKeyboard"
        data-testid="browser-offscreen-keyboard"
        aria-label={title}
        hidden={!active}
        autoComplete="off"
        spellCheck={false}
        onKeyDownCapture={cancelInspection}
      />
    </>
  );
}
