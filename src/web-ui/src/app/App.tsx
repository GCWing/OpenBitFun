import { lazy, Suspense, useEffect, useCallback, useLayoutEffect, useState, useRef } from 'react';
import { ChatProvider } from '../infrastructure/contexts/ChatProvider';
import { ViewModeProvider } from '../infrastructure/contexts/ViewModeProvider';
import { SSHRemoteProvider } from '../features/ssh-remote';
import { ContextMenuRenderer } from '../shared/context-menu-system/components/ContextMenuRenderer';
import { NotificationContainer, notificationService } from '../shared/notification-system';
import { UpdateNotificationCard } from '@/infrastructure/update/UpdateNotificationCard';
import { NotificationCenter } from '../shared/notification-system/components/NotificationCenter';
import { AnnouncementProvider } from '../shared/announcement-system';
import { ConfirmDialogRenderer } from '@/infrastructure/confirm-dialog';
import { SessionUsageModal } from '../flow_chat/components/usage/SessionUsageModal';
import { createLogger } from '@/shared/utils/logger';
import { startupTrace } from '@/shared/utils/startupTrace';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { useWorkspaceContext } from '../infrastructure/contexts/WorkspaceContext';
import { useGlobalSceneShortcuts } from './hooks/useGlobalSceneShortcuts';
import { useDebugInspector } from '@/infrastructure/debug/useDebugInspector';
import { useI18n } from '@/infrastructure/i18n';
import { scheduleDeferredStartupSystems } from './startup/deferredStartupSystems';
import { shouldScheduleDeferredStartupSystems } from './startup/deferredStartupGate';
import { STARTUP_OVERLAY_HIDDEN_EVENT } from './startup/startupSignals';
import {
  getStartupOverlayElapsedMs,
  hideStartupOverlay,
  isStartupOverlayPresent,
} from './startup/startupOverlay';
import {
  clearStartupModuleReloadAttempt,
  retryStartupAfterModuleLoadFailure,
} from './startup/startupModuleRecovery';
import { ToolbarModeProvider } from '../flow_chat/components/toolbar-mode/ToolbarModeProvider';
import { RealtimeVoiceCallProvider } from '../flow_chat/components/voice/RealtimeVoiceCallProvider';
import type { AgentCompanionPetCommand } from './services/agentCompanionPetCommands';
import AskUserAnnouncer from './components/NavPanel/AskUserAnnouncer';
import { handleBrowserShortcut } from './browserShortcutPolicy';
import { fontPreferenceService } from '@/infrastructure/font-preference/core/FontPreferenceService';
import { activateCreationRuntime } from '@/infrastructure/creation/creationRuntime';
import { attachCreationRuntime, recordCreationActivationError } from '@/infrastructure/creation/creationBridge';
import { createCreationUiApi } from './creation/creationUiApi';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';

const log = createLogger('App');

function isBackgroundTaskCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === 'BackgroundTaskCancelledError';
}

interface AppLayoutStartupGateProps {
  onReady: () => void;
}

const LazyAppLayout = lazy(async () => {
  startupTrace.markPhase('app_layout_import_start');
  try {
    const module = await import('./layout/AppLayout');
    clearStartupModuleReloadAttempt();
    startupTrace.markPhase('app_layout_import_end');
    return {
      default: function AppLayoutStartupGate({ onReady }: AppLayoutStartupGateProps) {
        useLayoutEffect(() => {
          startupTrace.markPhase('app_layout_ready');
          onReady();
        }, [onReady]);

        return <module.default />;
      },
    };
  } catch (error) {
    startupTrace.markPhase('app_layout_import_failed');
    if (retryStartupAfterModuleLoadFailure(error)) {
      startupTrace.markPhase('app_layout_import_reload_requested');
      return await new Promise<never>(() => undefined);
    }
    // The static overlay otherwise hides AppErrorBoundary and makes a real
    // startup failure look like an endless loading state.
    void hideStartupOverlay();
    throw error;
  }
});

const LazyGlobalSearchRoot = lazy(() => import('./global-search/GlobalSearchRoot'));

/**
 * OpenBitFun main application component.
 *
 * Unified architecture:
 * - Use a single AppLayout component
 * - AppLayout switches content based on workspace presence
 * - Without a workspace: show startup content (branding + actions)
 * - With a workspace: show workspace panels
 * - Header is always present; elements toggle by state
 */
// Minimum time (ms) the splash is shown, so the handoff remains intentional without delaying a ready shell.
const MIN_SPLASH_MS = 650;
// Keep hidden tray setup out of the first post-handoff interaction window.
// Close-to-tray initializes it on demand if the user closes earlier.
const DEFERRED_TRAY_INIT_DELAY_MS = 1500;

function App() {
  const { t } = useI18n('settings/application');

  // Workspace loading state — drives splash exit timing
  const { loading: workspaceLoading } = useWorkspaceContext();
  const peerSurfaceActive = usePeerDeviceModeOptional()?.peerMode.active ?? false;

  const [startupOverlayVisible, setStartupOverlayVisible] = useState(isStartupOverlayPresent);
  const mainWindowShownRef = useRef(false);
  const userCloseRequestedRef = useRef(false);
  const interactiveShellReadyRef = useRef(false);
  const interactiveShellReadyFrameRef = useRef<number | null>(null);
  const reportedFrontendTransactionRef = useRef<string | null>(null);
  const openBitFunControlStartupRef = useRef(false);
  const [openBitFunControlReady, setOpenBitFunControlReady] = useState(false);
  const workspaceLoadingRef = useRef(workspaceLoading);
  const appLayoutReadyRef = useRef(false);
  const [interactiveShellReady, setInteractiveShellReady] = useState(false);
  const [appLayoutReady, setAppLayoutReady] = useState(false);

  workspaceLoadingRef.current = workspaceLoading;

  const releaseInteractiveShellReadyIfReady = useCallback((reason: string, afterPaint = true) => {
    const latestWorkspaceLoading = workspaceLoadingRef.current;
    const latestAppLayoutReady = appLayoutReadyRef.current;
    startupTrace.markPhase('interactive_shell_ready_gate_check', {
      workspaceLoading: latestWorkspaceLoading,
      appLayoutReady: latestAppLayoutReady,
      alreadyReady: interactiveShellReadyRef.current,
      reason,
      afterPaint,
    });
    if (latestWorkspaceLoading || !latestAppLayoutReady || interactiveShellReadyRef.current) {
      return;
    }
    if (interactiveShellReadyFrameRef.current !== null) {
      window.cancelAnimationFrame(interactiveShellReadyFrameRef.current);
      interactiveShellReadyFrameRef.current = null;
    }
    interactiveShellReadyRef.current = true;
    startupTrace.markPhase('interactive_shell_ready', { reason, afterPaint });
    window.dispatchEvent(new CustomEvent('openbitfun:interactive-shell-ready', {
      detail: { reason },
    }));
    setInteractiveShellReady(true);
  }, []);

  const markInteractiveShellReadyIfReady = useCallback((reason: string) => {
    const latestWorkspaceLoading = workspaceLoadingRef.current;
    const latestAppLayoutReady = appLayoutReadyRef.current;
    startupTrace.markPhase('interactive_shell_ready_gate_check', {
      workspaceLoading: latestWorkspaceLoading,
      appLayoutReady: latestAppLayoutReady,
      alreadyReady: interactiveShellReadyRef.current,
      alreadyScheduled: interactiveShellReadyFrameRef.current !== null,
      reason,
    });
    if (
      latestWorkspaceLoading ||
      !latestAppLayoutReady ||
      interactiveShellReadyRef.current ||
      interactiveShellReadyFrameRef.current !== null
    ) {
      return;
    }

    startupTrace.markPhase('interactive_shell_ready_after_paint_scheduled', { reason });
    interactiveShellReadyFrameRef.current = window.requestAnimationFrame(() => {
      interactiveShellReadyFrameRef.current = null;
      releaseInteractiveShellReadyIfReady(`${reason}-after-paint`);
    });
  }, [releaseInteractiveShellReadyIfReady]);

  const handleAppLayoutReady = useCallback(() => {
    startupTrace.markPhase('app_layout_ready_state_update_requested');
    appLayoutReadyRef.current = true;
    setAppLayoutReady(true);
    markInteractiveShellReadyIfReady('app-layout-ready');
  }, [markInteractiveShellReadyIfReady]);

  useEffect(() => {
    return () => {
      if (interactiveShellReadyFrameRef.current !== null) {
        window.cancelAnimationFrame(interactiveShellReadyFrameRef.current);
        interactiveShellReadyFrameRef.current = null;
      }
    };
  }, []);

  // A Creative frontend candidate is not confirmable merely because its HTML
  // finished loading. Report readiness only after the real app layout and
  // workspace shell have rendered through the infrastructure adapter. The
  // immutable host confirmation window keeps its primary action disabled
  // until this handshake succeeds.
  useEffect(() => {
    if (!interactiveShellReady || !openBitFunControlReady || !isTauriRuntime() || peerSurfaceActive) {
      return;
    }
    const transactionId = new URLSearchParams(window.location.search)
      .get('openbitfunFrontendTransaction');
    const controller = new AbortController();
    const creation = createCreationUiApi(controller.signal);
    recordCreationActivationError(null);
    let detachCreation: (() => void) | undefined;
    let cancelled = false;
    let retryTimer: number | undefined;
    const retryUntil = Date.now() + 12_000;
    const reportReady = async (): Promise<void> => {
      try {
        await api.invoke('frontend_update_candidate_ready', {
          request: { transactionId },
        });
        if (!cancelled) {
          reportedFrontendTransactionRef.current = transactionId;
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (Date.now() < retryUntil) {
          retryTimer = window.setTimeout(() => void reportReady(), 250);
          return;
        }
        log.error('Failed to report Creative frontend readiness', error);
      }
    };
    void activateCreationRuntime({
      api: creation.api, disposeApi: creation.dispose, signal: controller.signal,
    }).then(() => {
      if (cancelled) return;
      detachCreation = attachCreationRuntime(creation);
      if (!cancelled && transactionId && reportedFrontendTransactionRef.current !== transactionId) {
        return reportReady();
      }
    }).catch(async error => {
      if (cancelled) return;
      recordCreationActivationError(error);
      log.error('Failed to activate UI customization', error);
      if (transactionId) {
        try {
          await api.invoke('frontend_update_candidate_failed', {
            request: { transactionId, message: error instanceof Error ? error.message : String(error) },
          });
        } catch (reportError) {
          // An older host can reject this additive command; its independent
          // deadline still rolls back. Never send success on the failure path.
          log.warn('Failed to report UI customization failure', reportError);
        }
      }
    });
    return () => {
      cancelled = true;
      detachCreation?.();
      controller.abort();
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [interactiveShellReady, openBitFunControlReady, peerSurfaceActive]);

  // Once the workspace finishes loading, wait for the remaining min-display
  // time and then begin the exit animation.
  useEffect(() => {
    if (workspaceLoading || !appLayoutReady) return;
    const elapsed = getStartupOverlayElapsedMs();
    const scheduledDelayMs = Math.max(0, MIN_SPLASH_MS - elapsed);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      startupTrace.markPhase('startup_overlay_hide_start', {
        elapsedMs: getStartupOverlayElapsedMs(),
        minSplashMs: MIN_SPLASH_MS,
        scheduledDelayMs,
      });
      void hideStartupOverlay().then(() => {
        if (!cancelled) {
          setStartupOverlayVisible(false);
          startupTrace.markPhase('startup_overlay_hidden');
          // WebKit can suspend animation frames in an occluded/reloaded window.
          // The completed handoff still proves the layout and workspace mounted;
          // do not leave product control and customization waiting for a paint.
          releaseInteractiveShellReadyIfReady('startup-overlay-hidden', false);
          window.dispatchEvent(new CustomEvent(STARTUP_OVERLAY_HIDDEN_EVENT));
        }
      });
    }, scheduledDelayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspaceLoading, appLayoutReady, releaseInteractiveShellReadyIfReady]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('openbitfun_main_window_close_requested', () => {
        userCloseRequestedRef.current = true;
        startupTrace.markPhase('main_window_user_close_requested', { reason: 'user-close-requested' });
      }))
      .then(removeListener => {
        if (disposed) {
          removeListener();
          return;
        }
        unlisten = removeListener;
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to listen for main window close request in startup visibility guard', error);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const showMainWindow = useCallback(async (reason: string) => {
    if (mainWindowShownRef.current) {
      return;
    }
    mainWindowShownRef.current = true;

    try {
      await api.invoke('show_main_window');
      log.debug('Main window shown', { reason });
      startupTrace.markPhase('main_window_shown', { reason });
      window.dispatchEvent(new CustomEvent('openbitfun:main-window-shown', { detail: { reason } }));
    } catch (error: any) {
      log.error('Failed to show main window', error);

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const mainWindow = getCurrentWindow();
        await mainWindow.show();
        await mainWindow.setFocus();
        log.debug('Main window shown via fallback', { reason });
        startupTrace.markPhase('main_window_shown_fallback', { reason });
        window.dispatchEvent(new CustomEvent('openbitfun:main-window-shown', { detail: { reason } }));
      } catch (fallbackError) {
        log.error('Fallback window show failed', fallbackError);
        mainWindowShownRef.current = false;
      }
    }
  }, []);

  const verifyMainWindowVisible = useCallback(async (reason: string) => {
    if (userCloseRequestedRef.current) {
      log.debug('Skipping main window startup visibility retry after user close request', {
        reason,
        closeReason: 'user-close-requested',
      });
      return;
    }

    if (!isTauriRuntime()) {
      void showMainWindow(reason);
      return;
    }

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const mainWindow = getCurrentWindow();
      if (await mainWindow.isVisible()) {
        return;
      }

      log.warn('Main window is not visible after native startup show, retrying', { reason });
      mainWindowShownRef.current = false;
      await showMainWindow(reason);
    } catch (error) {
      log.warn('Failed to verify main window visibility after native startup show', { reason, error });
    }
  }, [showMainWindow]);

  // Desktop shows the startup splash from the native window creation path.
  // Mark it here so deferred work can wait until the first visible shell exists.
  useEffect(() => {
    startupTrace.markPhase('app_effect_mounted');
    if (isTauriRuntime()) {
      mainWindowShownRef.current = true;
      startupTrace.markPhase('main_window_shown', { reason: 'startup-native' });
      window.dispatchEvent(new CustomEvent('openbitfun:main-window-shown', {
        detail: { reason: 'startup-native' },
      }));
      return;
    }
    void showMainWindow('startup-overlay');
  }, [showMainWindow]);

  useEffect(() => {
    if (appLayoutReady) {
      appLayoutReadyRef.current = true;
    }
    markInteractiveShellReadyIfReady('workspace-or-layout-state');
  }, [workspaceLoading, appLayoutReady, markInteractiveShellReadyIfReady]);

  // If the early reveal path fails, keep the old post-splash show as a retry.
  useEffect(() => {
    if (startupOverlayVisible) {
      return;
    }

    const timer = window.setTimeout(() => {
      void verifyMainWindowVisible('startup-complete');
    }, 50);

    return () => window.clearTimeout(timer);
  }, [startupOverlayVisible, verifyMainWindowVisible]);

  // Safety net: if startup gets stuck, reveal the window so the user can see errors.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void verifyMainWindowVisible('startup-watchdog');
    }, 10000);

    return () => window.clearTimeout(timer);
  }, [verifyMainWindowVisible]);

  // Register presentation routing as soon as the product surface is usable.
  // Native discovery, readback, and settings mutations are installed during
  // Desktop setup; only UI navigation/product actions require this handshake.
  useEffect(() => {
    if (
      !isTauriRuntime()
      || !shouldScheduleDeferredStartupSystems({ interactiveShellReady, startupOverlayVisible })
      || openBitFunControlStartupRef.current
    ) {
      return;
    }
    openBitFunControlStartupRef.current = true;
    void import('./global-search/openBitFunControlBridge')
      .then(({ initializeOpenBitFunControlBridge }) => initializeOpenBitFunControlBridge())
      .then(() => {
        startupTrace.markPhase('openbitfun_control_surface_ready');
        setOpenBitFunControlReady(true);
      })
      .catch(error => {
        openBitFunControlStartupRef.current = false;
        log.error('Failed to initialize the OpenBitFun control surface', error);
      });
  }, [interactiveShellReady, startupOverlayVisible]);

  // Non-critical systems are delayed until the shell is interactive and the
  // startup overlay has fully handed off to the app surface.
  useEffect(() => {
    if (!shouldScheduleDeferredStartupSystems({ interactiveShellReady, startupOverlayVisible })) {
      return;
    }

    log.info('Application visible and interactive, scheduling deferred systems');
    const startupSystemsHandle = scheduleDeferredStartupSystems();
    startupSystemsHandle.promise.catch(error => {
      if (!isBackgroundTaskCancelledError(error)) {
        log.warn('Deferred startup systems task failed', error);
      }
    });

    return () => startupSystemsHandle.cancel();
  }, [interactiveShellReady, startupOverlayVisible]);

  useEffect(() => {
    if (!interactiveShellReady || startupOverlayVisible) {
      return;
    }

    let disposed = false;
    let editorWarmupHandle: { promise: Promise<void>; cancel: () => void } | null = null;

    void import('@/tools/editor/services/MonacoStartupWarmup')
      .then(({ scheduleMonacoStartupWarmup }) => {
        if (disposed) {
          return;
        }
        editorWarmupHandle = scheduleMonacoStartupWarmup();
        editorWarmupHandle.promise.catch(error => {
          if (!disposed && !isBackgroundTaskCancelledError(error)) {
            log.warn('Editor startup warmup task failed', error);
          }
        });
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to schedule editor startup warmup', error);
        }
      });

    return () => {
      disposed = true;
      editorWarmupHandle?.cancel();
    };
  }, [interactiveShellReady, startupOverlayVisible]);

  useEffect(() => {
    if (!isTauriRuntime() || !interactiveShellReady || startupOverlayVisible) {
      return;
    }

    let disposed = false;
    let trayInitHandle: { promise: Promise<void>; cancel: () => void } | null = null;

    const timer = window.setTimeout(() => {
      void import('@/shared/utils/backgroundTaskScheduler')
        .then(({ backgroundTaskScheduler }) => {
          if (disposed) {
            return;
          }

          trayInitHandle = backgroundTaskScheduler.schedule(async signal => {
            if (signal.aborted || disposed) {
              return;
            }
            startupTrace.markPhase('desktop_tray_deferred_init_start');
            const { systemAPI } = await import('@/infrastructure/api/service-api/SystemAPI');
            if (signal.aborted || disposed) {
              return;
            }
            await systemAPI.initializeTrayAfterStartup();
            startupTrace.markPhase('desktop_tray_deferred_init_end');
          }, {
            idle: true,
            inFlightKey: 'desktop-tray:startup-init',
            priority: 'low',
          });

          trayInitHandle.promise.catch(error => {
            if (!disposed && !isBackgroundTaskCancelledError(error)) {
              log.warn('Deferred tray initialization failed', error);
            }
          });
        })
        .catch(error => {
          if (!disposed) {
            log.warn('Failed to schedule deferred tray initialization', error);
          }
        });
    }, DEFERRED_TRAY_INIT_DELAY_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      trayInitHandle?.cancel();
    };
  }, [interactiveShellReady, startupOverlayVisible]);

  useEffect(() => {
    if (!isTauriRuntime() || !interactiveShellReady) return;

    let disposed = false;
    let startupSyncHandle: { promise: Promise<void>; cancel: () => void } | null = null;
    let removeSettingsListener: (() => void) | null = null;
    let pendingActivityTimer: number | null = null;

    void (async () => {
      const [
        { aiExperienceConfigService },
        { syncAgentCompanionDesktopWindow },
        { buildAgentCompanionActivity },
        { emitAgentCompanionActivity },
        { backgroundTaskScheduler },
      ] = await Promise.all([
        import('@/infrastructure/config/services/AIExperienceConfigService'),
        import('@/infrastructure/config/services/AgentCompanionWindowService'),
        import('@/flow_chat/utils/agentCompanionActivity'),
        import('@/flow_chat/services/AgentCompanionActivityBridge'),
        import('@/shared/utils/backgroundTaskScheduler'),
      ]);

      if (disposed) {
        return;
      }

      let syncVersion = 0;
      const cancelPendingAgentCompanionStartupSync = () => {
        startupSyncHandle?.cancel();
        startupSyncHandle = null;
        if (pendingActivityTimer !== null) {
          window.clearTimeout(pendingActivityTimer);
          pendingActivityTimer = null;
        }
      };
      const emitCurrentAgentCompanionActivity = (version: number) => {
        if (disposed || version !== syncVersion) {
          return;
        }
        void emitAgentCompanionActivity(buildAgentCompanionActivity());
      };
      const scheduleFollowUpAgentCompanionActivity = (version: number) => {
        if (pendingActivityTimer !== null) {
          window.clearTimeout(pendingActivityTimer);
        }
        pendingActivityTimer = window.setTimeout(() => {
          pendingActivityTimer = null;
          emitCurrentAgentCompanionActivity(version);
        }, 250);
      };
      type AgentCompanionSettings = Awaited<ReturnType<typeof aiExperienceConfigService.getSettingsAsync>>;

      const runAgentCompanionSync = async (
        settings: AgentCompanionSettings,
        version: number,
        source: 'startup_idle' | 'settings_change',
        signal?: AbortSignal,
      ) => {
        if (signal?.aborted || disposed || version !== syncVersion) {
          return;
        }
        if (source === 'startup_idle') {
          startupTrace.markPhase('agent_companion_sync_start', {
            source,
          });
        }
        await syncAgentCompanionDesktopWindow(settings);
        if (signal?.aborted || disposed || version !== syncVersion) {
          return;
        }
        emitCurrentAgentCompanionActivity(version);
        scheduleFollowUpAgentCompanionActivity(version);
        if (source === 'startup_idle') {
          startupTrace.markPhase('agent_companion_sync_end', {
            source,
          });
        }
      };
      const syncAgentCompanionSettings = (
        settings: AgentCompanionSettings | null,
        source: 'startup_idle' | 'settings_change',
      ) => {
        const version = syncVersion += 1;
        cancelPendingAgentCompanionStartupSync();
        if (source === 'startup_idle') {
          startupTrace.markPhase('agent_companion_sync_scheduled', {
            source,
          });
          startupSyncHandle = backgroundTaskScheduler.schedule(
            async signal => {
              const latestSettings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true });
              await runAgentCompanionSync(latestSettings, version, source, signal);
            },
            {
              idle: true,
              inFlightKey: 'agent-companion:startup-sync',
              priority: 'low',
            },
          );

          startupSyncHandle.promise.catch(error => {
            if (!disposed && !isBackgroundTaskCancelledError(error)) {
              log.warn('Initial Agent companion sync task failed', error);
            }
          });
          return;
        }

        if (!settings) {
          return;
        }
        void runAgentCompanionSync(settings, version, source).catch(error => {
          if (!disposed) {
            log.warn('Agent companion settings sync failed', error);
          }
        });
      };

      syncAgentCompanionSettings(null, 'startup_idle');

      removeSettingsListener = aiExperienceConfigService.addChangeListener(settings => {
        syncAgentCompanionSettings(settings, 'settings_change');
      });
    })().catch(error => {
      if (!disposed) {
        log.warn('Failed to initialize Agent companion startup sync', error);
      }
    });

    return () => {
      disposed = true;
      startupSyncHandle?.cancel();
      if (pendingActivityTimer !== null) {
        window.clearTimeout(pendingActivityTimer);
      }
      removeSettingsListener?.();
    };
  }, [interactiveShellReady]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void import('@tauri-apps/api/event')
      .then(({ emit, listen }) => listen(
        'agent-companion://ready',
        async () => {
          try {
            const [
              { aiExperienceConfigService },
              { buildAgentCompanionActivity },
              { emitAgentCompanionActivity },
            ] = await Promise.all([
              import('@/infrastructure/config/services/AIExperienceConfigService'),
              import('@/flow_chat/utils/agentCompanionActivity'),
              import('@/flow_chat/services/AgentCompanionActivityBridge'),
            ]);
            const settings = await aiExperienceConfigService.getSettingsAsync({ forceRefresh: true });
            if (disposed) {
              return;
            }
            await emit('agent-companion://settings-updated', settings);
            if (disposed) {
              return;
            }
            await emitAgentCompanionActivity(buildAgentCompanionActivity());
          } catch (error) {
            if (!disposed) {
              log.warn('Failed to synchronize Agent companion after ready event', error);
            }
          }
        },
      ))
      .then(removeListener => {
        if (disposed) {
          removeListener();
          return;
        }
        unlisten = removeListener;
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to listen for Agent companion ready events', error);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    void Promise.all([
      import('@/flow_chat/utils/agentCompanionActivity'),
      import('@/flow_chat/services/AgentCompanionActivityBridge'),
    ])
      .then(([{ subscribeAgentCompanionActivity }, { emitAgentCompanionActivity }]) => {
        if (disposed) {
          return;
        }
        unsubscribe = subscribeAgentCompanionActivity(activity => {
          void emitAgentCompanionActivity(activity);
        });
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to subscribe Agent companion activity bridge', error);
        }
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ sessionId?: string }>(
        'agent-companion://open-session',
        async event => {
          if (disposed) return;
          const sessionId = event.payload?.sessionId;
          if (!sessionId) return;

          const { openAgentCompanionSession } = await import('./services/openAgentCompanionSession');
          await openAgentCompanionSession(sessionId);

          try {
            await api.invoke('show_main_window');
          } catch (error) {
            log.warn('Failed to show main window from Agent companion bubble', {
              sessionId,
              error,
            });
          }
        },
      ))
      .then(removeListener => {
        if (disposed) {
          removeListener();
          return;
        }
        unlisten = removeListener;
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to listen for Agent companion session open events', error);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<AgentCompanionPetCommand>(
        'agent-companion://pet-command',
        async event => {
          if (disposed) return;
          try {
            const { handleAgentCompanionPetCommand } = await import('./services/agentCompanionPetCommands');
            await handleAgentCompanionPetCommand(event.payload);
          } catch (error) {
            log.warn('Failed to handle Agent companion pet command', {
              commandType: event.payload?.type,
              error,
            });
          }
        },
      ))
      .then(removeListener => {
        if (disposed) {
          removeListener();
          return;
        }
        unlisten = removeListener;
      })
      .catch(error => {
        if (!disposed) {
          log.warn('Failed to listen for Agent companion pet commands', error);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Control typography and block browser-native find/print. Reload remains available while the
  // frontend runs in dev mode and is blocked in release builds. The desktop
  // host independently applies the matching Rust build-profile policy.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      handleBrowserShortcut(e, import.meta.env.DEV, delta => {
        void fontPreferenceService.adjustUiSize(delta);
      });
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // Top SceneBar: Mod+Alt+1..9 / Mod+Alt+PageUp/PageDown
  useGlobalSceneShortcuts();

  // Debug inspector shortcuts (desktop devtools only)
  useDebugInspector();

  useEffect(() => {
    if (!isTauriRuntime() || !interactiveShellReady) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { configAPI, workspaceAPI } = await import('@/infrastructure/api');
        const runtimeInfo = await configAPI.getRuntimeLoggingInfo();
        if (cancelled || !runtimeInfo.previousUnexpectedExit?.notifyOnStartup) {
          return;
        }
        const recoveryKey = `openbitfun:unexpected-exit-notice:${runtimeInfo.previousUnexpectedExit.sessionLogDir || 'unknown'}`;
        if (sessionStorage.getItem(recoveryKey) === 'shown') {
          return;
        }
        sessionStorage.setItem(recoveryKey, 'shown');

        notificationService.warning(t('logging.startupRecovery.message'), {
          title: t('logging.startupRecovery.title'),
          duration: 0,
          actions: [
            {
              label: t('logging.actions.exportDiagnostics'),
              variant: 'primary',
              onClick: () => {
                void (async () => {
                  try {
                    const result = await configAPI.exportDiagnosticsBundle();
                    notificationService.success(t('logging.messages.diagnosticsExported'), { duration: 3000 });
                    await workspaceAPI.revealInExplorer(result.bundlePath);
                  } catch (error) {
                    log.error('Failed to export diagnostics bundle from startup notification', error);
                    notificationService.error(t('logging.messages.diagnosticsExportFailed'), { duration: 5000 });
                  }
                })();
              },
            },
            {
              label: t('logging.actions.openLoggingSettings'),
              onClick: () => {
                void import('@/shared/services/ide-control').then(({ quickActions }) => {
                  quickActions.openSettings({ pageId: 'data.diagnostics' });
                });
              },
            },
          ],
          metadata: {
            source: 'startup-crash-diagnostics',
            sessionLogDir: runtimeInfo.previousUnexpectedExit.sessionLogDir,
            crashReportPath: runtimeInfo.previousUnexpectedExit.crashReportPath,
          },
        });
      } catch (error) {
        log.warn('Failed to check previous unexpected exit status', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [interactiveShellReady, t]);

  // Unified layout via a single AppLayout
  return (
    <ChatProvider>
        <ViewModeProvider defaultMode="coder">
          <SSHRemoteProvider>
            <RealtimeVoiceCallProvider>
              <ToolbarModeProvider>
              {/* One shell-owned command/search surface for every scene and nav mode. */}
              <Suspense fallback={null}>
                <LazyGlobalSearchRoot />
              </Suspense>

              {/* Unified app layout with startup/workspace modes */}
              <Suspense fallback={null}>
                <LazyAppLayout onReady={handleAppLayoutReady} />
              </Suspense>

              {/* Context menu renderer */}
              <ContextMenuRenderer />

              {/* Notification system */}
              <NotificationContainer><UpdateNotificationCard /></NotificationContainer>
              <NotificationCenter />

              {/* Confirm dialog */}
              <ConfirmDialogRenderer />

              {/* Session usage report. Mounted here rather than in a chat view:
                  the request runs below any component, and the report outlives
                  whichever session view is on screen. */}
              <SessionUsageModal />

              {/* Announcement / feature-demo / tips system */}
              <AnnouncementProvider ready={interactiveShellReady && !startupOverlayVisible} />

              {/* AskUserQuestion waiting-state aria-live announcer.
                  Mounted here (inside ToolbarModeProvider, outside LazyAppLayout)
                  so it persists across both normal and Toolbar Mode. */}
              <AskUserAnnouncer />
              </ToolbarModeProvider>
            </RealtimeVoiceCallProvider>
          </SSHRemoteProvider>
        </ViewModeProvider>
    </ChatProvider>
  );
}

export default App;
