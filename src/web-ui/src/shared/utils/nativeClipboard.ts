/**
 * System clipboard access that prefers the desktop host's native clipboard.
 *
 * The WebView clipboard API works, but a first read raises a WebView2
 * permission prompt on the app origin. Desktop builds therefore read and write
 * through the Tauri clipboard plugin, and every other surface (browser web,
 * mobile web, tests) keeps the Web API path.
 */
import {
  readText as readNativeText,
  writeImage as writeNativeImage,
  writeText as writeNativeText,
} from '@tauri-apps/plugin-clipboard-manager';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('NativeClipboard');

/** True when a native clipboard host can serve the request. */
export function hasNativeClipboard(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Clipboard text from the native host, or `null` when the native path is
 * unavailable so the caller can fall back to the Web API.
 */
export async function readNativeClipboardText(): Promise<string | null> {
  if (!hasNativeClipboard()) {
    return null;
  }

  try {
    return await readNativeText();
  } catch (error) {
    log.warn('Native clipboard read failed', { error });
    return null;
  }
}

/** Write through the native host; `false` means the caller should fall back. */
export async function writeNativeClipboardText(text: string): Promise<boolean> {
  if (!hasNativeClipboard()) {
    return false;
  }

  try {
    await writeNativeText(text);
    return true;
  } catch (error) {
    log.warn('Native clipboard write failed', { error });
    return false;
  }
}

/**
 * Write an RGBA bitmap through the native host; `false` means the caller has
 * no other path left to try.
 *
 * The bitmap is sent inline as the plugin's raw RGBA image shape instead of an
 * `Image` resource, so it needs no image-resource permission and does not
 * depend on the plugin sharing this bundle's `@tauri-apps/api` copy.
 */
export async function writeNativeClipboardImage(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<boolean> {
  if (!hasNativeClipboard()) {
    return false;
  }

  try {
    const image = { rgba: Array.from(rgba), width, height };
    await writeNativeImage(image as unknown as Parameters<typeof writeNativeImage>[0]);
    return true;
  } catch (error) {
    log.warn('Native clipboard image write failed', { error });
    return false;
  }
}
