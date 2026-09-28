/**
 * Tauri-specific utilities for E2E tests.
 * Contains functions for checking Tauri availability and getting window information.
 */
import { browser } from '@wdio/globals';

/**
 * Check if Tauri API is available in the current window.
 * Useful for determining if we're running in a real Tauri app vs browser.
 * 
 * @returns true if Tauri API is available, false otherwise
 */
export async function isTauriAvailable(): Promise<boolean> {
  const result = await browser.execute(() => {
    // @ts-ignore
    return typeof window.__TAURI__ !== 'undefined';
  });
  return result;
}

/**
 * Invoke a Tauri command from the running app's webview.
 *
 * Used to read host state the UI already exposes (for example
 * `get_memory_status`) so a spec can assert on the same payload the UI renders
 * instead of scraping translated text.
 *
 * @param command - Tauri command name (snake_case)
 * @param args - command arguments object; omit for commands that take none
 */
export async function invokeTauriCommand<T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return browser.execute(
    async (cmd: string, payload: Record<string, unknown>) => {
      const invoke = (window as unknown as {
        __TAURI__?: { core?: { invoke?: (name: string, args?: unknown) => Promise<unknown> } };
      }).__TAURI__?.core?.invoke;

      if (typeof invoke !== 'function') {
        throw new Error('Tauri invoke is not available in this webview');
      }

      return await invoke(cmd, payload);
    },
    command,
    args,
  ) as Promise<T>;
}

/**
 * Get information about the current Tauri window.
 * Returns window label, title, and visibility states.
 * 
 * @returns Window information object, or null if unable to retrieve
 */
export async function getWindowInfo(): Promise<{
  label: string;
  title: string;
  isVisible: boolean;
  isMaximized: boolean;
  isMinimized: boolean;
} | null> {
  try {
    const result = await browser.execute(async () => {
      try {
        // @ts-ignore
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        
        return {
          label: win.label,
          title: await win.title(),
          isVisible: await win.isVisible(),
          isMaximized: await win.isMaximized(),
          isMinimized: await win.isMinimized(),
        };
      } catch {
        return null;
      }
    });
    return result;
  } catch {
    return null;
  }
}
