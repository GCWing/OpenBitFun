/**
 * Copy an image the UI is already showing to the system clipboard.
 *
 * The source is whatever the owning surface resolved for display (a data URL,
 * a blob URL, or an asset URL). The async Clipboard API with a PNG payload (the
 * one image type every engine accepts) is tried first because it needs no IPC;
 * desktop builds fall back to the native clipboard host when the WebView
 * refuses, for example once the click's user activation has expired.
 */
import { writeNativeClipboardImage, hasNativeClipboard } from './nativeClipboard';

interface DecodedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

async function loadImageElement(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  // Remote URLs must allow CORS for the canvas to stay readable; data, blob
  // and asset URLs are same-origin for the WebView.
  if (/^https?:/i.test(source) && !source.startsWith(window.location.origin)) {
    image.crossOrigin = 'anonymous';
  }
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  return image;
}

async function decodeImage(source: string): Promise<DecodedImage> {
  const image = await loadImageElement(source);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) {
    throw new Error('Image has no pixels to copy');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D context is unavailable');
  }
  context.drawImage(image, 0, 0);
  return { canvas, width, height };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

async function writeWebClipboardImage(decoded: Promise<DecodedImage>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
    throw new Error('Clipboard image write is not supported here');
  }
  // WebKit only honors the user gesture when the item is created right away,
  // so hand it the pending PNG instead of awaiting it first.
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': decoded.then(({ canvas }) => canvasToPng(canvas)) }),
  ]);
}

/** Copy the image at `source`; rejects when no clipboard path accepted it. */
export async function copyImageToClipboard(source: string): Promise<void> {
  const decoded = decodeImage(source);
  // Keep a rejected decode from surfacing as unhandled while the web write runs.
  decoded.catch(() => undefined);

  try {
    await writeWebClipboardImage(decoded);
    return;
  } catch (webError) {
    if (!hasNativeClipboard()) throw webError;
  }

  const { canvas, width, height } = await decoded;
  const pixels = canvas.getContext('2d')?.getImageData(0, 0, width, height).data;
  if (!pixels || !await writeNativeClipboardImage(pixels, width, height)) {
    throw new Error('No clipboard accepted the image');
  }
}
