import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BLANK_TARGET_INTERCEPT_SCRIPT } from './browserInspectorScript';
import { STREAM_RENDER_OPTIMIZATION_SCRIPT } from './browserStreamPerformanceScript';
import { validateUrl } from './browserUrlCheck';
import { BrowserPreviewCache, prepareBrowserPreview, type BrowserPreviewResponse } from './browserPreviewCache';
import { alignBrowserViewport, type BrowserViewportBounds } from './browserViewportGeometry';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { createNativeWebviewVisibility, hasNativeWebviewOccluder } from './nativeWebviewVisibility';
import { observeNativeWebviewOcclusion } from './nativeWebviewOcclusionObserver';
export { NATIVE_WEBVIEW_OCCLUSION_SELECTOR, rectanglesIntersect } from './nativeWebviewVisibility';

const WEBVIEW_RESIZE_DEBOUNCE_MS = 160;
const WEBVIEW_BOUNDS_WAIT_TIMEOUT_MS = 2000;
const BROWSER_WEBVIEW_PAGE_LOAD_EVENT = 'browser-webview-page-load';
const WEBVIEW_CREATE_RETRY_DELAYS_MS = [0, 250, 750];

// Webview labels are window-global in Tauri, while this hook can be mounted
// once per cached editor tab. Keep allocation outside the hook so independent
// panels cannot both start at `<prefix>-0`.
let nextBrowserWebviewSequence = 0;

export function allocateBrowserWebviewLabel(labelPrefix: string): string {
  return `${labelPrefix}-${nextBrowserWebviewSequence++}`;
}

type BrowserLogger = {
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

type BrowserWebviewHandle = {
  close: () => Promise<void>;
  hide: () => Promise<void>;
  label: string;
  setFocus: () => Promise<void>;
  show: () => Promise<void>;
};

type WebviewBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type BrowserWebviewPageLoadPayload = {
  label: string;
  event: 'started' | 'finished';
  url: string;
};

export interface UseEmbeddedBrowserWebviewOptions {
  defaultUrl: string;
  initialUrl?: string;
  isVisible: boolean;
  labelPrefix: string;
  log: BrowserLogger;
  openRequestId?: string;
}

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const payload = 'payload' in record ? record.payload : undefined;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).message === 'string'
        ? String((payload as Record<string, unknown>).message)
        : null);
    if (message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function isWebviewNotFoundError(error: unknown): boolean {
  return formatUnknownError(error).toLowerCase().includes('webview not found');
}

function isTransientWebviewCreationError(error: unknown): boolean {
  const message = formatUnknownError(error).toLowerCase();
  return message.includes('0x80070057')
    || message.includes('0x8007139f')
    || message.includes('failed to create webview');
}

function normalizeUrl(raw: string, defaultUrl: string): string {
  const value = raw.trim();
  if (!value) return defaultUrl;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) return value;
  return `https://${value}`;
}

async function evalWebview(label: string, script: string): Promise<void> {
  await api.invoke('browser_webview_eval', { request: { label, script } });
}

async function injectBrowserPageScripts(label: string): Promise<void> {
  await evalWebview(label, `${BLANK_TARGET_INTERCEPT_SCRIPT};\n${STREAM_RENDER_OPTIMIZATION_SCRIPT};`);
}

async function navigateWebview(label: string, url: string, openRequestId?: string): Promise<void> {
  await api.invoke('browser_webview_navigate', {
    request: { label, url, openRequestId },
  });
}

async function reloadWebview(label: string): Promise<void> {
  await api.invoke('browser_webview_reload', { request: { label } });
}

async function setWebviewBounds(label: string, bounds: WebviewBounds): Promise<void> {
  await api.invoke('browser_webview_set_bounds', {
    request: {
      label,
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
    },
  });
}

async function setAgentTargetState(
  label: string,
  active: boolean,
  openRequestId?: string,
): Promise<void> {
  await api.invoke('browser_webview_set_agent_target_state', {
    request: { label, active, openRequestId },
  });
}

async function createBrowserWebview(
  label: string,
  url: string,
  bounds: WebviewBounds,
  openRequestId?: string,
): Promise<BrowserWebviewHandle> {
  const { Webview } = await import('@tauri-apps/api/webview');
  await api.invoke('browser_webview_create', {
    request: {
      label,
      url,
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
      openRequestId,
    },
  });
  const handle = await Webview.getByLabel(label) as unknown as BrowserWebviewHandle | null;
  if (!handle) {
    throw new Error(`Webview not found after creation: ${label}`);
  }
  return handle;
}

export function useEmbeddedBrowserWebview(options: UseEmbeddedBrowserWebviewOptions) {
  const { defaultUrl, initialUrl, isVisible, labelPrefix, log, openRequestId } = options;
  const isTauri = useMemo(() => isTauriEnvironment(), []);
  const startUrl = initialUrl ?? defaultUrl;

  const viewportRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<BrowserWebviewHandle | null>(null);
  const currentUrlRef = useRef<string>(startUrl);
  const resizeTimerRef = useRef<number | null>(null);
  const lastBoundsRef = useRef<WebviewBounds | null>(null);
  const webviewLabelRef = useRef<string>('');
  const pageLoadUnlistenRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(isVisible);
  activeRef.current = isVisible;
  const mountedRef = useRef(true);
  const toolbarSuspendedRef = useRef(false);
  const nativeVisibleRef = useRef(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBounds, setPreviewBounds] = useState<BrowserViewportBounds | null>(null);
  const preview = useMemo(() => new BrowserPreviewCache({
    capture: label => api.invoke<BrowserPreviewResponse>('browser_webview_capture_preview', { request: { label } }),
    prepare: prepareBrowserPreview,
    onFrame: setPreviewUrl,
    onError: previewError => log.warn('Browser preview unavailable; using the default placeholder', previewError),
  }), [log]);
  const visibility = useMemo(() => createNativeWebviewVisibility(target => {
    const viewport = viewportRef.current;
    if (!mountedRef.current || !activeRef.current || toolbarSuspendedRef.current
      || target !== webviewRef.current || !viewport?.isConnected) return false;
    const rect = viewport.getBoundingClientRect();
    // Keep the last valid geometry during transient layout swaps, but still
    // check overlays against it rather than bypassing the visibility decision.
    const last = lastBoundsRef.current;
    const nativeBounds = last ? {
      left: last.left, top: last.top,
      right: last.left + last.width, bottom: last.top + last.height,
    } : null;
    const bounds = rect.width > 1 && rect.height > 1 ? rect : nativeBounds;
    // Bounds updates are debounced; the native view may still occupy its old
    // rectangle after the DOM container has moved.
    return !!bounds && !hasNativeWebviewOccluder(viewport, bounds, nativeBounds ?? undefined);
  }, (target, visible) => {
    if (target !== webviewRef.current) return;
    nativeVisibleRef.current = visible;
    preview.setVisible(visible && document.visibilityState !== 'hidden');
  }), [preview]);

  const syncVisibility = useCallback(async (focus = false) => {
    const target = webviewRef.current;
    if (target) await visibility(target, focus);
  }, [visibility]);

  const [inputValue, setInputValue] = useState(startUrl);
  const [currentUrl, setCurrentUrl] = useState(startUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webviewLabel, setWebviewLabel] = useState('');

  const readViewportBounds = useCallback((): WebviewBounds | null => {
    if (!viewportRef.current) return null;

    const rect = viewportRef.current.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return null;

    return alignBrowserViewport(rect, window.devicePixelRatio);
  }, []);

  const waitForViewportBounds = useCallback(async (): Promise<WebviewBounds> => {
    const startedAt = performance.now();

    while (performance.now() - startedAt < WEBVIEW_BOUNDS_WAIT_TIMEOUT_MS) {
      const bounds = readViewportBounds();
      if (bounds) return bounds;

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    throw new Error('Browser viewport did not become visible before webview creation');
  }, [readViewportBounds]);

  const syncWebviewBounds = useCallback(async (handle?: BrowserWebviewHandle | null) => {
    const target = handle ?? webviewRef.current;
    if (!isTauri || !target || !viewportRef.current) return;

    const nextBounds = readViewportBounds();
    if (!nextBounds) {
      await visibility(target);
      return;
    }

    const previous = lastBoundsRef.current;
    const boundsChanged =
      !previous ||
      previous.left !== nextBounds.left || previous.top !== nextBounds.top ||
      previous.width !== nextBounds.width || previous.height !== nextBounds.height;

    if (boundsChanged) {
      if (!previous || previous.width !== nextBounds.width || previous.height !== nextBounds.height) {
        preview.invalidate();
      }
      await setWebviewBounds(target.label, nextBounds);
      lastBoundsRef.current = nextBounds;
      if (!previous || previous.width !== nextBounds.width || previous.height !== nextBounds.height) {
        preview.invalidate();
      }
    }
    // The image is positioned relative to the host, but uses the applied native
    // rectangle rather than stretching to the host's fractional CSS dimensions.
    const viewport = viewportRef.current;
    const applied = lastBoundsRef.current;
    if (!mountedRef.current || target !== webviewRef.current || !viewport || !applied) return;
    const rect = viewport.getBoundingClientRect();
    const relative = { left: applied.left - rect.left, top: applied.top - rect.top, width: applied.width, height: applied.height };
    setPreviewBounds(current => current && current.left === relative.left && current.top === relative.top
      && current.width === relative.width && current.height === relative.height ? current : relative);
    await visibility(target);
  }, [isTauri, preview, readViewportBounds, visibility]);

  const closeWebview = useCallback(async (handle?: BrowserWebviewHandle | null) => {
    const target = handle ?? webviewRef.current;
    if (!target) return;

    try {
      await setAgentTargetState(target.label, false).catch(() => {});
      await target.close();
    } catch (closeError) {
      if (!isWebviewNotFoundError(closeError)) {
        log.warn('Close browser webview failed', closeError);
      }
    } finally {
      if (!handle || target === webviewRef.current) {
        nativeVisibleRef.current = false;
        preview.setVisible(false);
        preview.setTarget('');
        webviewRef.current = null;
        webviewLabelRef.current = '';
        setWebviewLabel('');
        lastBoundsRef.current = null;
        pageLoadUnlistenRef.current?.();
        pageLoadUnlistenRef.current = null;
      }
    }
  }, [log, preview]);

  const startPageLoadListener = useCallback(async (label: string) => {
    pageLoadUnlistenRef.current?.();
    pageLoadUnlistenRef.current = null;

    const { listen } = await import('@tauri-apps/api/event');
    pageLoadUnlistenRef.current = await listen<BrowserWebviewPageLoadPayload>(
      BROWSER_WEBVIEW_PAGE_LOAD_EVENT,
      ({ payload }) => {
        if (!payload || payload.label !== label) return;
        preview.invalidate();
        if (payload.event === 'started') {
          setIsLoading(true);
        } else {
          setIsLoading(false);
        }
        if (payload.url && payload.url !== currentUrlRef.current) {
          currentUrlRef.current = payload.url;
          setInputValue(payload.url);
          setCurrentUrl(payload.url);
          setError(null);
          injectBrowserPageScripts(label).catch(() => {});
        }
      },
    );
  }, [preview]);

  const createWebview = useCallback(async (url: string) => {
    const previous = webviewRef.current;
    if (previous) await closeWebview(previous);

    const { Webview } = await import('@tauri-apps/api/webview');
    const initialBounds = await waitForViewportBounds();
    let lastError: unknown = null;

    for (let attempt = 0; attempt < WEBVIEW_CREATE_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = WEBVIEW_CREATE_RETRY_DELAYS_MS[attempt];
      if (delay > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }

      const label = allocateBrowserWebviewLabel(labelPrefix);
      webviewLabelRef.current = label;
      setWebviewLabel(label);
      try {
        const handle = await createBrowserWebview(label, url, initialBounds, openRequestId);
        if (!mountedRef.current) {
          await handle.close();
          throw new Error('Browser surface disposed during webview creation');
        }
        webviewRef.current = handle;
        preview.setTarget(label);
        lastBoundsRef.current = initialBounds;
        await injectBrowserPageScripts(label);
        await startPageLoadListener(label);
        return handle;
      } catch (creationError) {
        lastError = creationError;
        const staleHandle = await Webview.getByLabel(label).catch(() => null);
        await staleHandle?.close().catch(() => {});
        if (!isTransientWebviewCreationError(creationError)
          || attempt === WEBVIEW_CREATE_RETRY_DELAYS_MS.length - 1) {
          throw creationError;
        }
        log.warn('Retry browser webview creation after transient WebView2 error', {
          attempt: attempt + 1,
          error: formatUnknownError(creationError),
        });
      }
    }

    throw lastError;
  }, [closeWebview, labelPrefix, log, openRequestId, preview, startPageLoadListener, waitForViewportBounds]);

  const navigateExistingWebview = useCallback(async (url: string): Promise<boolean> => {
    const label = webviewLabelRef.current;
    if (!label || !webviewRef.current) return false;

    try {
      await navigateWebview(label, url, openRequestId);
      window.setTimeout(() => {
        if (webviewLabelRef.current === label) {
          void injectBrowserPageScripts(label).catch(() => {});
        }
      }, 1000);
      window.setTimeout(() => {
        if (webviewLabelRef.current === label) {
          void injectBrowserPageScripts(label).catch(() => {});
        }
      }, 2500);
      return true;
    } catch (navigationError) {
      log.warn('Navigate browser webview via existing instance failed', navigationError);
      return false;
    }
  }, [log, openRequestId]);

  const loadUrl = useCallback(async (rawUrl: string) => {
    const nextUrl = normalizeUrl(rawUrl, defaultUrl);
    preview.invalidate();
    setInputValue(nextUrl);
    setCurrentUrl(nextUrl);
    currentUrlRef.current = nextUrl;
    setError(null);
    setIsLoading(true);

    if (!isTauri) {
      setIsLoading(false);
      return;
    }

    try {
      validateUrl(nextUrl);
      let handle = webviewRef.current;
      if (!handle) {
        handle = await createWebview(nextUrl);
      } else {
        const navigated = await navigateExistingWebview(nextUrl);
        if (!navigated) {
          handle = await createWebview(nextUrl);
        }
      }
      await syncWebviewBounds(handle);
      await visibility(handle, true);
      if (mountedRef.current && handle === webviewRef.current) {
        await setAgentTargetState(handle.label, activeRef.current, openRequestId);
      }
    } catch (loadError) {
      const message = formatUnknownError(loadError);
      log.error('Load browser url failed', loadError);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [createWebview, defaultUrl, isTauri, log, navigateExistingWebview, openRequestId, preview, syncWebviewBounds, visibility]);

  const queueSync = useCallback(() => {
    if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      void syncWebviewBounds().catch((syncError) => {
        log.warn('Sync browser webview bounds failed', syncError);
      });
    }, WEBVIEW_RESIZE_DEBOUNCE_MS);
  }, [log, syncWebviewBounds]);

  useEffect(() => {
    if (!isTauri) return;
    if (isVisible && !webviewRef.current) {
      void loadUrl(currentUrlRef.current).catch(loadError => {
        log.warn('Restore browser webview failed', loadError);
      });
      return;
    }
    const handle = webviewRef.current;
    if (!handle) return;
    void (async () => {
      if (activeRef.current) await syncWebviewBounds(handle);
      await visibility(handle, isVisible);
      if (mountedRef.current && handle === webviewRef.current) {
        await setAgentTargetState(handle.label, activeRef.current, openRequestId);
      }
    })().catch(syncError => log.warn('Update browser webview visibility failed', syncError));
  }, [isTauri, isVisible, loadUrl, log, openRequestId, syncWebviewBounds, visibility]);

  useEffect(() => {
    if (!isTauri) return;

    const observer = new ResizeObserver(() => {
      if (isVisible) queueSync();
    });

    if (viewportRef.current) observer.observe(viewportRef.current);

    const handleResize = () => {
      if (isVisible) queueSync();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, [isTauri, isVisible, queueSync]);

  useEffect(() => {
    mountedRef.current = true;
    preview.resume();
    const handleDocumentVisibility = () => preview.setVisible(nativeVisibleRef.current && document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleDocumentVisibility);
    return () => {
      mountedRef.current = false;
      preview.dispose();
      document.removeEventListener('visibilitychange', handleDocumentVisibility);
      pageLoadUnlistenRef.current?.();
      pageLoadUnlistenRef.current = null;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      const handle = webviewRef.current;
      if (handle) {
        // Drain pending show/focus operations before closing the native view.
        void visibility(handle).catch(() => {}).then(() => closeWebview(handle));
      }
    };
  }, [closeWebview, preview, visibility]);

  useEffect(() => {
    if (!isTauri || !isVisible) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      void syncVisibility().catch(syncError => {
        log.warn('Update browser webview occlusion failed', syncError);
      });
    };
    return observeNativeWebviewOcclusion(viewport, update);
  }, [isTauri, isVisible, log, syncVisibility]);

  useEffect(() => {
    if (!isTauri) return;
    const update = () => {
      void syncVisibility().catch(syncError => {
        log.warn('Update browser webview occlusion failed', syncError);
      });
    };
    const handleToolbarActivating = () => {
      toolbarSuspendedRef.current = true;
      update();
    };
    const handleToolbarSettled = () => {
      toolbarSuspendedRef.current = false;
      update();
    };
    window.addEventListener('toolbar-mode-activating', handleToolbarActivating);
    window.addEventListener('toolbar-mode-activation-finished', handleToolbarSettled);
    return () => {
      window.removeEventListener('toolbar-mode-activating', handleToolbarActivating);
      window.removeEventListener('toolbar-mode-activation-finished', handleToolbarSettled);
    };
  }, [isTauri, log, syncVisibility]);

  const evalInWebview = useCallback(async (script: string) => {
    const label = webviewLabelRef.current;
    if (!isTauri || !label) return;
    await evalWebview(label, script);
  }, [isTauri]);

  const goBack = useCallback(() => {
    void evalInWebview('history.back()').catch(() => {});
  }, [evalInWebview]);

  const goForward = useCallback(() => {
    void evalInWebview('history.forward()').catch(() => {});
  }, [evalInWebview]);

  const reload = useCallback(() => {
    const label = webviewLabelRef.current;
    if (!isTauri || !label) return;
    void reloadWebview(label).catch(() => {});
  }, [isTauri]);

  const getWebviewLabel = useCallback(() => webviewLabelRef.current, []);
  const getCurrentUrl = useCallback(() => currentUrlRef.current, []);
  const hasWebview = useCallback(() => webviewRef.current !== null, []);

  return useMemo(() => ({
    currentUrl,
    error,
    evalInWebview,
    getCurrentUrl,
    getWebviewLabel,
    goBack,
    goForward,
    hasWebview,
    inputValue,
    isLoading,
    isTauri,
    loadUrl,
    previewUrl,
    previewBounds,
    reload,
    setInputValue,
    viewportRef,
    webviewLabel,
  }), [
    currentUrl,
    error,
    evalInWebview,
    getCurrentUrl,
    getWebviewLabel,
    goBack,
    goForward,
    hasWebview,
    inputValue,
    isLoading,
    isTauri,
    loadUrl,
    previewUrl,
    previewBounds,
    reload,
    viewportRef,
    webviewLabel,
  ]);
}
