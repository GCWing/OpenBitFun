import { useCallback, useRef, useState, useEffect } from 'react';
import { useOverlayLayerActions } from '@openbitfun/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useWorkspaceContext } from '../../infrastructure/contexts/WorkspaceContext';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { sendDebugProbe } from '@/shared/utils/debugProbe';
import { nowMs } from '@/shared/utils/timing';
import { useI18n } from '@/infrastructure/i18n';
import { supportsNativeWindowControls } from '@/infrastructure/runtime';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import {
  captureFocusedEditable,
  restoreWindowKeyboardFocus,
  type WindowKeyboardFocusTarget,
} from './windowKeyboardFocus';

const log = createLogger('useWindowControls');

const formatErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const createWindowKeyboardFocusTarget = (
  appWindow: ReturnType<typeof getCurrentWindow> | null
): WindowKeyboardFocusTarget => {
  if (!appWindow) return null;

  return {
    setFocus: () => appWindow.setFocus(),
    setWebviewFocus: () => getCurrentWebview().setFocus(),
  };
};

/**
 * Window controls hook.
 * Manages minimize, maximize, OS fullscreen, close, and related actions.
 *
 * Important: OS fullscreen is not maximize. Fullscreen asks the operating
 * system to put the entire Desktop window into fullscreen (`F11` on
 * Windows/Linux, `Control+Command+F` on macOS). Maximize keeps the app as a
 * normal window that fills the available work area. Keep their state and
 * handlers separate so callers do not accidentally wire panel/fullscreen
 * behavior to maximize/restore UI.
 */
export const useWindowControls = (options?: { isToolbarMode?: boolean }) => {
  const { t } = useI18n('errors');
  const { dismissAll: dismissAllOverlayLayers } = useOverlayLayerActions();
  const isToolbarMode = options?.isToolbarMode ?? false;
  const canUseNativeWindowControls = supportsNativeWindowControls();
  const { hasWorkspace, closeWorkspace } = useWorkspaceContext();
  
  // Maximized state: ordinary OS window maximize/restore, not fullscreen.
  const [isMaximized, setIsMaximized] = useState(false);
  // OS fullscreen state: entire Desktop window fullscreen, not panel fullscreen.
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Debounce guard to prevent rapid toggles
  const isMaximizeInProgress = useRef(false);
  const isFullscreenInProgress = useRef(false);
  
  // Skip state updates during manual operations
  const shouldSkipStateUpdate = useRef(false);

  const updateWindowState = useCallback(async (appWindow: any, skipVisibilityCheck = false) => {
    if (shouldSkipStateUpdate.current) {
      return;
    }

    try {
      if (!skipVisibilityCheck) {
        const isVisible = await appWindow.isVisible();
        if (!isVisible) {
          return;
        }
      }

      const [maximized, fullscreen] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFullscreen(),
      ]);
      setIsMaximized(maximized);
      setIsFullscreen(fullscreen);
    } catch (_error) {
      // Ignore errors to avoid noise when the window is minimized or transitioning.
    }
  }, []);

  // Listen for window state changes
  useEffect(() => {
    if (!canUseNativeWindowControls) return;

    let disposed = false;
    let unlistenResized: (() => void) | undefined;

    // Debounce timer
    let resizeTimer: NodeJS.Timeout | null = null;

    // Update state when window regains focus.
    // Note: Tauri may not expose onFocus; use page visibility as a fallback.
    const handleVisibilityChange = async () => {
      // Skip visibility handling while a window state transition is in flight.
      if (shouldSkipStateUpdate.current) {
        return;
      }
      
      if (document.visibilityState === 'visible') {
        sendDebugProbe(
          'useWindowControls.ts:handleVisibilityChange',
          'Window became visible',
          {
            isToolbarMode,
          }
        );
        try {
          const appWindow = getCurrentWindow();
          // Delay update until window fully restores
          setTimeout(async () => {
            const startedAt = nowMs();
            try {
              await updateWindowState(appWindow);
              sendDebugProbe(
                'useWindowControls.ts:handleVisibilityChange',
                'Window restore sync completed',
                {
                  isToolbarMode,
                },
                { startedAt }
              );
            } catch (error) {
              sendDebugProbe(
                'useWindowControls.ts:handleVisibilityChange',
                'Window restore sync failed',
                {
                  error: formatErrorMessage(error),
                  isToolbarMode,
                }
              );
            }
          }, 300);
        } catch (error) {
          sendDebugProbe(
            'useWindowControls.ts:handleVisibilityChange',
            'Window restore setup failed',
            {
              error: formatErrorMessage(error),
              isToolbarMode,
            }
          );
        }
      }
    };
    
    const setupListener = async () => {
      try {
        const appWindow = getCurrentWindow();

        // Get initial state (skip visibility check so we still sync
        // when the window is maximized before it becomes visible)
        await updateWindowState(appWindow, true);
        
        // Listen for resize (with debounce and visibility checks)
        const resolvedUnlistenResized = await appWindow.onResized(async () => {
          // Skip resize handling while a window state transition is in flight.
          if (shouldSkipStateUpdate.current) {
            return;
          }
          
          // Clear previous timer
          if (resizeTimer) {
            clearTimeout(resizeTimer);
          }
          
          // Debounce: delay to avoid frequent calls (300ms covers maximize/restore/fullscreen)
          resizeTimer = setTimeout(async () => {
            await updateWindowState(appWindow);
          }, 300); // 300ms debounce covers window change duration
        });

        // Cleanup may have run while awaiting registration: unlisten
        // immediately instead of leaking the resized callback (and its
        // debounce timer) against an unmounted tree.
        if (disposed) {
          resolvedUnlistenResized();
          return;
        }
        unlistenResized = resolvedUnlistenResized;

        // Add page visibility listener
        document.addEventListener('visibilitychange', handleVisibilityChange);
      } catch (error) {
        log.error('Failed to setup window state listener', error);
      }
    };
    
    setupListener();
    
    return () => {
      disposed = true;
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      if (unlistenResized) {
        unlistenResized();
      }
      // Remove page visibility listener
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [canUseNativeWindowControls, isToolbarMode, updateWindowState]);

  // Window control handlers
  const handleMinimize = useCallback(async () => {
    if (!canUseNativeWindowControls) return;

    // Save active element to restore focus after window restore
    const focusSnapshot = captureFocusedEditable();
    
    try {
      const appWindow = getCurrentWindow();
      await appWindow.minimize();
      
      // Ensure input is usable after restore
      // Listen for restore
      const handleWindowRestore = async () => {
        restoreWindowKeyboardFocus(
          createWindowKeyboardFocusTarget(getCurrentWindow()),
          focusSnapshot,
          100
        );
        
        // Run once
        window.removeEventListener('focus', handleWindowRestore);
      };
      
      // Listen for restore
      window.addEventListener('focus', handleWindowRestore, { once: true });
    } catch (error) {
      log.error('Failed to minimize window', error);
      // Avoid error toast when minimized to prevent UI blockage
    }
  }, [canUseNativeWindowControls]);

  const handleMaximize = useCallback(async () => {
    if (!canUseNativeWindowControls) return;

    // Debounce: ignore while in progress
    if (isMaximizeInProgress.current) {
      return;
    }
    
    // Save active element to restore focus after window change
    const focusSnapshot = captureFocusedEditable();
    let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
    
    try {
      isMaximizeInProgress.current = true;
      // Skip auto updates to avoid duplicate state changes
      shouldSkipStateUpdate.current = true;
      
      appWindow = getCurrentWindow();
      
      // Optimization: skip isVisible check; query maximized directly.
      // If minimized, user restores via taskbar instead of double-clicking header.
      // Check current state to avoid duplicate toggles.
      let currentMaximized = false;
      try {
        currentMaximized = await appWindow.isMaximized();
      } catch (error) {
        log.warn('Failed to get maximized state, assuming not maximized', error);
        currentMaximized = false;
      }
      // Use requestAnimationFrame to avoid blocking UI updates
      const updateState = (newState: boolean) => {
        requestAnimationFrame(() => {
          setIsMaximized(newState);
        });
      };
      
      // Toggle maximize/restore
      if (currentMaximized) {
        await appWindow.unmaximize();
        updateState(false);
      } else {
        await appWindow.maximize();
        updateState(true);
      }
      
      // Delay DOM work to avoid blocking UI rendering
      requestAnimationFrame(() => {
        restoreWindowKeyboardFocus(
          createWindowKeyboardFocusTarget(appWindow),
          focusSnapshot,
          50
        );
      });
    } catch (error) {
      log.error('Failed to toggle maximize window', error);
      notificationService.error(t('window.maximizeFailed', { error: formatErrorMessage(error) }));
    } finally {
      // Reduce final delay: 200ms is sufficient for window updates
      setTimeout(() => {
        isMaximizeInProgress.current = false;
        shouldSkipStateUpdate.current = false;
        if (appWindow) {
          void updateWindowState(appWindow, true);
        }
      }, 200);
    }
  }, [canUseNativeWindowControls, t, updateWindowState]);

  const handleToggleFullscreen = useCallback(async () => {
    if (!canUseNativeWindowControls) return;

    if (isFullscreenInProgress.current) {
      return;
    }

    const focusSnapshot = captureFocusedEditable();
    let appWindow: ReturnType<typeof getCurrentWindow> | null = null;

    try {
      isFullscreenInProgress.current = true;
      shouldSkipStateUpdate.current = true;

      appWindow = getCurrentWindow();

      // OS fullscreen is intentionally separate from maximize/restore.
      // The desktop host owns the native maximize/fullscreen transition so the
      // web UI does not expose visible intermediate OS window states.
      const nextState = await systemAPI.toggleMainWindowFullscreen();

      requestAnimationFrame(() => {
        setIsFullscreen(nextState.isFullscreen);
        setIsMaximized(nextState.isMaximized);
        restoreWindowKeyboardFocus(
          createWindowKeyboardFocusTarget(appWindow),
          focusSnapshot,
          80
        );
      });

      return nextState.isFullscreen;
    } catch (error) {
      log.error('Failed to toggle fullscreen window', error);
      notificationService.error(t('window.fullscreenFailed', { error: formatErrorMessage(error) }));
      return undefined;
    } finally {
      setTimeout(() => {
        isFullscreenInProgress.current = false;
        shouldSkipStateUpdate.current = false;
        if (appWindow) {
          void updateWindowState(appWindow, true);
        }
      }, 300);
    }
  }, [canUseNativeWindowControls, t, updateWindowState]);

  const handleClose = useCallback(async () => {
    if (!canUseNativeWindowControls) return;

    try {
      const appWindow = getCurrentWindow();
      await appWindow.close();
    } catch (error) {
      log.error('Failed to close window', error);
      notificationService.error(t('window.closeFailed', { error: formatErrorMessage(error) }));
    }
  }, [canUseNativeWindowControls, t]);

  // Home button: reset to startup page
  const handleHomeClick = useCallback(async () => {
    try {
      // 1) Close current workspace (triggers state update)
      if (hasWorkspace) {
        await closeWorkspace();
      }
      
      // 2) Dismiss transient overlays so the reset lands on a clean surface.
      dismissAllOverlayLayers();
    } catch (error) {
      log.error('Failed to return to startup page', error);
    }
  }, [closeWorkspace, dismissAllOverlayLayers, hasWorkspace]);

  return {
    handleMinimize,
    handleMaximize,
    handleToggleFullscreen,
    handleClose,
    handleHomeClick,
    isMaximized,
    isFullscreen,
    canUseNativeWindowControls
  };
};
