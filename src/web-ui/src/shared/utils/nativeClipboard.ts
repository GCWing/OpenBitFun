/**
 * System clipboard access that prefers the desktop host's native clipboard.
 *
 * The WebView clipboard API works, but a first read raises a WebView2
 * permission prompt on the app origin. Desktop builds therefore read and write
 * through the desktop host, and every other surface (browser web, mobile web,
 * tests) keeps the Web API path.
 */
import {
  readText as readNativeText,
  writeText as writeNativeText,
} from '@tauri-apps/plugin-clipboard-manager';
import type { ITransportAdapter } from '@/infrastructure/api/adapters/base';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('NativeClipboard');

/** Desktop command that decodes a PNG request body onto the system clipboard. */
export const WRITE_CLIPBOARD_IMAGE_COMMAND = 'write_clipboard_image';

let controllerAdapter: Promise<ITransportAdapter> | null = null;

/**
 * This machine's own Tauri host. The clipboard belongs to the device the user
 * is sitting at, so an image write never follows the rendered Peer device.
 * Loaded on first use: text clipboard callers never need the transport.
 */
function controllerHost(): Promise<ITransportAdapter> {
  controllerAdapter ??= import('@/infrastructure/api/adapters/tauri-adapter')
    .then(({ TauriTransportAdapter }) => new TauriTransportAdapter());
  return controllerAdapter;
}

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
 * Write a PNG image through the native host; `false` means the caller has no
 * other path left to try.
 *
 * The encoded PNG travels as the raw IPC body and the host decodes it, so a
 * large image never becomes a JSON array of RGBA pixels built on the UI thread.
 */
export async function writeNativeClipboardImage(png: Blob): Promise<boolean> {
  if (!hasNativeClipboard()) {
    return false;
  }

  try {
    const bytes = new Uint8Array(await png.arrayBuffer());
    const host = await controllerHost();
    await host.request<void>(WRITE_CLIPBOARD_IMAGE_COMMAND, bytes);
    return true;
  } catch (error) {
    log.warn('Native clipboard image write failed', { error, byteLength: png.size });
    return false;
  }
}
