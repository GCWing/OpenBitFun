/**
 * System clipboard access that prefers the desktop host's native clipboard.
 *
 * The WebView clipboard API works, but a first read raises a WebView2
 * permission prompt on the app origin. Desktop builds therefore read and write
 * through the Tauri clipboard plugin, and every other surface (browser web,
 * mobile web, tests) keeps the Web API path.
 */
import { readText as readNativeText, writeText as writeNativeText } from '@tauri-apps/plugin-clipboard-manager';
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
