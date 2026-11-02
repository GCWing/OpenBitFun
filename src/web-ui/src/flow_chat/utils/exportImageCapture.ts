import type { Options } from 'modern-screenshot';
import { withTimeout } from '@/shared/utils/timing';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('ExportImageCapture');
const CAPTURE_TIMEOUT_MS = 15_000;

/** Computed CSS already resolves var(). Copying inherited custom properties onto
 * every cloned element bloats a transcript SVG by tens of MB and can prevent
 * WebKit from decoding it. Keep every browser-supported paint/layout property,
 * including vendor-prefixed ones, without serializing the theme catalog. */
export function getExportCaptureStyleProperties(container: HTMLElement): string[] {
  return Array.from(getComputedStyle(container)).filter(name => !name.startsWith('--'));
}

/** Check the raster before adding the logo: an SVG decode/draw failure can
 * produce a valid, nonempty PNG containing only the requested background. */
export function assertExportCanvasHasContent(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context || !canvas.width || !canvas.height) {
    throw new Error('Capture returned an empty canvas');
  }

  let reference: number[] | undefined;
  // Read bounded strips instead of allocating another full long-image buffer.
  for (let y = 0; y < canvas.height; y += 32) {
    const { data } = context.getImageData(0, y, canvas.width, Math.min(32, canvas.height - y));
    for (let i = 0; i < data.length; i += 4) {
      if (!reference) {
        reference = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      } else if (
        Math.abs(reference[3] - data[i + 3]) > 2
        || (reference[3] > 0 && data[i + 3] > 0 && (
          Math.abs(reference[0] - data[i]) > 2
          || Math.abs(reference[1] - data[i + 1]) > 2
          || Math.abs(reference[2] - data[i + 2]) > 2
        ))
      ) {
        return;
      }
    }
  }
  throw new Error('Capture returned a blank image');
}

export async function captureExportCanvas(
  container: HTMLElement,
  backgroundColor: string,
  filter?: NonNullable<Options['filter']>,
): Promise<HTMLCanvasElement> {
  // Measure after web fonts settle; otherwise the SVG can embed the right face
  // into boxes that were sized with fallback glyphs.
  await withTimeout(
    container.ownerDocument.fonts?.ready ?? Promise.resolve(),
    CAPTURE_TIMEOUT_MS,
    'Image export fonts',
  );
  const { domToCanvas } = await import('modern-screenshot');
  const options: Options = {
    backgroundColor,
    filter,
    includeStyleProperties: getExportCaptureStyleProperties(container),
    fetch: { bypassingCache: true },
    // Windows/Linux ship web fonts. Embed the used faces so the standalone SVG
    // keeps the same glyph metrics instead of silently switching to a fallback.
    font: {},
    features: { removeControlCharacter: true, fixSvgXmlDecode: true },
  };

  // PNG and Blob use the same SVG rasterizer; changing the encoding is not a
  // recovery strategy. Retry at a lower resolution to reduce raster memory.
  for (const scale of [2, 1]) {
    let timedOut = false;
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await withTimeout<HTMLCanvasElement>(
        domToCanvas(container, { ...options, scale }).then(result => {
          if (timedOut) {
            result.width = 0;
            result.height = 0;
          }
          return result;
        }),
        CAPTURE_TIMEOUT_MS,
        'Conversation image capture',
        () => { timedOut = true; },
      );
      assertExportCanvasHasContent(canvas);
      return canvas;
    } catch (error) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      // A timeout does not cancel the library's work. Do not start a concurrent
      // capture against the same DOM; let the caller clean up and report it.
      if (timedOut || scale === 1) throw error;
      log.warn('Capture failed; retrying at reduced scale', { error });
    }
  }
  throw new Error('Conversation image capture failed');
}
