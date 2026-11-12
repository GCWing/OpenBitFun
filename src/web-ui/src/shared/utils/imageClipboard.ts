/**
 * Copy an image the UI is already showing to the system clipboard.
 *
 * The source is whatever the owning surface resolved for display (a data URL,
 * a blob URL, or an asset URL). The async Clipboard API with a PNG payload (the
 * one image type every engine accepts) is tried first because it needs no IPC;
 * desktop builds fall back to the native clipboard host when the WebView
 * refuses, for example once the click's user activation has expired. Both
 * paths take the same PNG, which is the source's own bytes whenever it already
 * is one; only other formats are decoded and re-encoded through a canvas.
 */
import { hasNativeClipboard, writeNativeClipboardImage } from './nativeClipboard';

const PNG_MIME = 'image/png';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/**
 * Tauri serves local files to Windows WebViews from this http(s) host and
 * answers with the app origin in its CORS headers, so it stays copyable.
 */
const TAURI_ASSET_HOST = 'asset.localhost';

/**
 * Raised for a remote image on another origin. Its host decides whether the
 * page may read the pixels back, and most hosts do not send the CORS headers
 * that requires, so such images are not offered for copying.
 */
export class CrossOriginImageError extends Error {
  constructor() {
    super('Images served by another origin cannot be copied');
    this.name = 'CrossOriginImageError';
  }
}

function parseSource(source: string): URL | null {
  try {
    return new URL(source, window.location.href);
  } catch {
    return null;
  }
}

function isInlineSource(url: URL): boolean {
  return url.protocol === 'data:' || url.protocol === 'blob:';
}

/** True for an http(s) image on another origin than the app (see `CrossOriginImageError`). */
export function isCrossOriginImageSource(source: string): boolean {
  const url = parseSource(source);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
  if (url.hostname === TAURI_ASSET_HOST) return false;
  return url.origin !== window.location.origin;
}

/** Whether the copy action should be offered for `source`. */
export function canCopyImageSource(source: string | null | undefined): source is string {
  return typeof source === 'string' && source.length > 0 && !isCrossOriginImageSource(source);
}

async function loadImageElement(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  // A canvas stays readable only for same-origin pixels or a CORS-approved
  // load; the Tauri asset protocol approves the app origin.
  const url = parseSource(source);
  if (url && !isInlineSource(url) && url.origin !== window.location.origin) {
    image.crossOrigin = 'anonymous';
  }
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  return image;
}

async function encodeAsPng(source: string): Promise<Blob> {
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
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), PNG_MIME);
  });
}

async function isPngBlob(blob: Blob): Promise<boolean> {
  if (blob.size < PNG_SIGNATURE.length) return false;
  const header = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  return PNG_SIGNATURE.every((byte, index) => header[index] === byte);
}

/**
 * The PNG to put on the clipboard. A data or blob URL that already holds a PNG
 * is used as is: its bytes are read without decoding a single pixel.
 */
async function resolvePngBlob(source: string): Promise<Blob> {
  const url = parseSource(source);
  if (url && isInlineSource(url)) {
    const blob = await (await fetch(source)).blob();
    if (await isPngBlob(blob)) {
      return blob.type === PNG_MIME ? blob : new Blob([blob], { type: PNG_MIME });
    }
  }
  return encodeAsPng(source);
}

async function writeWebClipboardImage(png: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
    throw new Error('Clipboard image write is not supported here');
  }
  // WebKit only honors the user gesture when the item is created right away,
  // so hand it the pending PNG instead of awaiting it first.
  await navigator.clipboard.write([new ClipboardItem({ [PNG_MIME]: png })]);
}

/** Copy the image at `source`; rejects when no clipboard path accepted it. */
export async function copyImageToClipboard(source: string): Promise<void> {
  if (isCrossOriginImageSource(source)) {
    throw new CrossOriginImageError();
  }

  const png = resolvePngBlob(source);
  // Keep a rejected read from surfacing as unhandled while the web write runs.
  png.catch(() => undefined);

  try {
    await writeWebClipboardImage(png);
    return;
  } catch (webError) {
    if (!hasNativeClipboard()) throw webError;
  }

  if (!await writeNativeClipboardImage(await png)) {
    throw new Error('No clipboard accepted the image');
  }
}
