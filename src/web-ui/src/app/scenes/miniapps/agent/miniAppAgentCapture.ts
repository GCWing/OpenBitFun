/**
 * Pixel observation for an Agent-controlled MiniApp surface.
 *
 * `inspect` cannot see inside a canvas, so for any canvas-rendered MiniApp —
 * a game, a chart, a map, a drawing tool — the pixels *are* the state. This
 * module owns that one job: pick the surface region that carries the app's
 * output, scale it into the published bounds, and hand back an image.
 *
 * It depends only on the wire limits from `miniAppAgentProtocol` and on the
 * surface's document accessor. It knows nothing about nodes, input, bridging,
 * or transport, so a new capture source (video, SVG, a future renderer) is
 * added here without touching the action layer.
 */

import { requireSurfaceDocument, type MiniAppAgentDomSurface } from './miniAppAgentDomRuntime';
import {
  MINIAPP_AGENT_MAX_CAPTURE_BYTES,
  MINIAPP_AGENT_MAX_CAPTURE_EDGE,
  MINIAPP_AGENT_MAX_NAME_CHARS,
  surfaceError,
} from './miniAppAgentProtocol';

export interface CaptureResult {
  mimeType: string;
  dataBase64: string;
  width: number;
  height: number;
  source: string;
  label?: string;
}

/** Largest side at or below this stays PNG: crisp text, no artifacts. */
const PNG_EDGE_LIMIT = 480;
/** JPEG quality for a scaled frame. */
const JPEG_QUALITY = 0.85;
/** Same-origin child frames worth looking into for a canvas. */
const MAX_FRAME_DEPTH = 2;

interface CanvasCandidate {
  canvas: HTMLCanvasElement;
  doc: Document;
  label: string;
}

function clip(value: string, limit: number): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function canvasArea(canvas: HTMLCanvasElement): number {
  return (canvas.width || 0) * (canvas.height || 0);
}

function canvasLabel(canvas: HTMLCanvasElement): string {
  const id = canvas.getAttribute('id');
  if (id) return `#${clip(id, MINIAPP_AGENT_MAX_NAME_CHARS) ?? ''}`;
  const testId =
    canvas.getAttribute('data-testid') ??
    canvas.getAttribute('data-test-id') ??
    canvas.getAttribute('data-test');
  if (testId) return clip(testId, MINIAPP_AGENT_MAX_NAME_CHARS) ?? 'canvas';
  return 'canvas';
}

/** Every canvas this surface may read, including same-origin child frames. */
function collectCanvases(doc: Document, depth = 0): CanvasCandidate[] {
  const found: CanvasCandidate[] = Array.from(doc.querySelectorAll('canvas')).map((canvas) => ({
    canvas,
    doc,
    label: canvasLabel(canvas),
  }));
  if (depth >= MAX_FRAME_DEPTH) return found;
  for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
    let childDoc: Document | null = null;
    try {
      childDoc = (frame as HTMLIFrameElement).contentDocument;
    } catch {
      childDoc = null;
    }
    if (childDoc) found.push(...collectCanvases(childDoc, depth + 1));
  }
  return found;
}

function nextAnimationFrame(win: Window | null): Promise<void> {
  return new Promise((resolve) => {
    if (win && typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

function readCanvasPixels(candidate: CanvasCandidate, maxEdge: number): CaptureResult {
  const { canvas, doc } = candidate;
  const sourceWidth = canvas.width || 0;
  const sourceHeight = canvas.height || 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw surfaceError(
      'CAPABILITY_MISSING',
      `screenshot: ${candidate.label} has no pixel buffer to capture (width or height is 0).`,
    );
  }

  // Shrink in steps so a dense frame still fits the observation limit instead
  // of failing outright. Never upscale: a small canvas stays sharp.
  const edgesToTry = [maxEdge, Math.round(maxEdge * 0.7), Math.round(maxEdge * 0.5)].filter(
    (edge, index, all) => edge >= 320 && all.indexOf(edge) === index,
  );

  let lastError: unknown;
  for (const edge of edgesToTry) {
    const scale = Math.min(1, edge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const target = doc.createElement('canvas');
    target.width = width;
    target.height = height;
    const context = target.getContext('2d');
    if (!context) {
      throw surfaceError(
        'CAPABILITY_MISSING',
        'screenshot: this surface has no 2D drawing context, so canvas pixels cannot be captured.',
      );
    }
    try {
      context.drawImage(canvas, 0, 0, width, height);
    } catch (error) {
      // Tainted canvas: cross-origin media the app painted cannot be read back.
      throw surfaceError(
        'CAPABILITY_MISSING',
        `screenshot: ${candidate.label} paints pixels the host may not read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const mimeType = Math.max(width, height) <= PNG_EDGE_LIMIT ? 'image/png' : 'image/jpeg';
    let dataUrl: string;
    try {
      dataUrl =
        mimeType === 'image/png'
          ? target.toDataURL('image/png')
          : target.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch (error) {
      throw surfaceError(
        'CAPABILITY_MISSING',
        `screenshot: ${candidate.label} cannot be exported as an image: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const separator = dataUrl.indexOf(',');
    if (separator < 0) {
      lastError = surfaceError('HOST_ERROR', 'screenshot: the canvas export produced no data.');
      continue;
    }
    const dataBase64 = dataUrl.slice(separator + 1);
    if (dataBase64.length > (MINIAPP_AGENT_MAX_CAPTURE_BYTES / 3) * 4) {
      lastError = surfaceError(
        'HOST_ERROR',
        'screenshot: the captured frame is larger than the observation limit.',
      );
      continue;
    }
    return { mimeType, dataBase64, width, height, source: 'canvas', label: candidate.label };
  }
  throw lastError instanceof Error
    ? lastError
    : surfaceError('HOST_ERROR', 'screenshot: the frame could not be captured.');
}

/**
 * Capture what the MiniApp is painting right now.
 *
 * The read happens inside an animation frame: a WebGL canvas may present an
 * empty drawing buffer outside the frame that draws it.
 */
export async function captureSurface(
  surface: MiniAppAgentDomSurface,
  maxEdge: number,
): Promise<CaptureResult> {
  const doc = requireSurfaceDocument(surface);
  const candidates = collectCanvases(doc)
    .filter((candidate) => canvasArea(candidate.canvas) > 0)
    .sort((left, right) => canvasArea(right.canvas) - canvasArea(left.canvas));
  if (candidates.length === 0) {
    throw surfaceError(
      'CAPABILITY_MISSING',
      'screenshot: this MiniApp paints no canvas, so there are no pixels to capture. Read its DOM instead, or use the app bridge for internal state.',
    );
  }
  await nextAnimationFrame(doc.defaultView);
  return readCanvasPixels(candidates[0], Math.min(maxEdge, MINIAPP_AGENT_MAX_CAPTURE_EDGE));
}
