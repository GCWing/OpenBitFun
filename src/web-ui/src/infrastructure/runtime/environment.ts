type TauriInternals = {
  invoke?: unknown;
  metadata?: {
    currentWindow?: {
      label?: string;
    };
  };
};

const getTauriInternals = (): TauriInternals | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
};

export const isTauriRuntime = (): boolean => {
  const internals = getTauriInternals();
  return typeof internals?.invoke === 'function';
};

export const supportsNativeWindowControls = (): boolean => {
  // Tauri window APIs read metadata.currentWindow; browser builds must not call them without it.
  const currentWindow = getTauriInternals()?.metadata?.currentWindow;
  return isTauriRuntime() && typeof currentWindow?.label === 'string';
};

export const supportsNativeWindowDragging = supportsNativeWindowControls;

export const isMacOSDesktopRuntime = (): boolean =>
  supportsNativeWindowControls() &&
  typeof navigator !== 'undefined' &&
  typeof navigator.platform === 'string' &&
  navigator.platform.toUpperCase().includes('MAC');

export const isWindowsDesktopRuntime = (): boolean =>
  supportsNativeWindowControls() &&
  typeof navigator !== 'undefined' &&
  (
    (typeof navigator.userAgent === 'string' && navigator.userAgent.toUpperCase().includes('WINDOWS'))
    || (typeof navigator.platform === 'string' && navigator.platform.toUpperCase().includes('WIN'))
  );

/**
 * Linux Desktop runs WebKitGTK, whose clipboard bridge differs from WebView2 and
 * WKWebView: OS clipboards arrive without DataTransfer payloads, so the composer
 * falls back to reading them through the host.
 */
export const isLinuxDesktopRuntime = (): boolean =>
  supportsNativeWindowControls() &&
  typeof navigator !== 'undefined' &&
  typeof navigator.userAgent === 'string' &&
  navigator.userAgent.toUpperCase().includes('LINUX');
