import ReactDOM from "react-dom/client";
// Register the design-system layer order before any product module can import
// component CSS. CSS layers keep their first-seen order for the document.
import "@openbitfun/ui/styles.css";
import AppErrorBoundary from "./app/components/AppErrorBoundary";
import { STARTUP_OVERLAY_HIDDEN_EVENT } from "./app/startup/startupSignals";
import { I18nProvider } from "./infrastructure/i18n/providers/I18nProvider";
import { OpenBitFunDesignSystemProvider } from "./infrastructure/design-system";
import "./app/styles/index.scss";

// The build-selected font profile is linked from index.html before first paint.
// Apple uses system faces; non-Apple bundles HarmonyOS Sans and Fira Code.

import { bootstrapLogger, createLogger, initLogger } from './shared/utils/logger';
import { elapsedMs, logElapsed, measureAsyncAndLog, nowMs } from './shared/utils/timing';
import { startupTrace } from './shared/utils/startupTrace';
import { scheduleAfterStartupSignal } from './shared/utils/startupTaskScheduling';
import { installInteractionModalityTracking } from './shared/utils/motionPreference';
import {
  buildReactCrashLogPayload,
  isMinifiedReactErrorMessage,
} from './shared/utils/reactProductionError';

// Install console forwarding before app startup so early console output is persisted too.
bootstrapLogger();

const log = createLogger('App');
startupTrace.markPhase('first_script_eval', {
  viteMode: import.meta.env.MODE,
  isDev: import.meta.env.DEV,
});

async function traceStartupStep<T>(
  phase: string,
  step: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = nowMs();
  startupTrace.markPhase(`${phase}_start`, { step });
  try {
    const value = await run();
    startupTrace.markPhase(`${phase}_end`, {
      step,
      durationMs: elapsedMs(startedAt),
    });
    return value;
  } catch (error) {
    startupTrace.markPhase(`${phase}_failed`, {
      step,
      durationMs: elapsedMs(startedAt),
    });
    throw error;
  }
}

/** Dedupe only for white-screen heuristic (empty #root), not for Error Boundary logs. */
const WHITE_SCREEN_LOGGED_FLAG = '__openbitfun_white_screen_crash_logged__';
function hasLoggedWhiteScreenCrash(): boolean {
  return Boolean((window as any)[WHITE_SCREEN_LOGGED_FLAG]);
}
function markWhiteScreenCrashLogged(): void {
  (window as any)[WHITE_SCREEN_LOGGED_FLAG] = true;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { value: String(err) };
}

function isRootEmpty(): boolean {
  const root = document.getElementById('root');
  if (!root) {
    return true;
  }
  return root.childElementCount === 0;
}

function registerGlobalErrorHandlers() {
  const flag = '__openbitfun_global_error_handlers_registered__';
  const w = window as any;
  if (w[flag]) {
    return;
  }
  w[flag] = true;

  const scheduleCrashLog = (payload: { location: string; message: string; data?: Record<string, unknown> }) => {
    // Always persist uncaught errors so they appear in webview.log for diagnostics.
    // Mark white-screen crashes separately to allow callers to deduplicate.
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const isWhiteScreen = isRootEmpty();
          const crashType = isWhiteScreen ? 'white-screen' : 'page-error';
          // Deduplicate only white-screen crashes to avoid duplicate startup logs.
          if (isWhiteScreen && hasLoggedWhiteScreenCrash()) {
            return;
          }
          if (isWhiteScreen) {
            markWhiteScreenCrashLogged();
          }
          log.error(`[CRASH:${crashType}] Uncaught error`, {
            location: payload.location,
            message: payload.message,
            ...payload.data,
          });
        });
      });
    });
  };

  window.addEventListener(
    'error',
    (event: Event) => {
      if (event instanceof ErrorEvent) {
        const msg = event.message || '';
        // Minified React errors often reach window.error even when #root is not empty;
        // always persist so production builds get react.dev/errors/{code} in webview.log.
        if (isMinifiedReactErrorMessage(msg)) {
          const err =
            event.error instanceof Error ? event.error : new Error(msg);
          log.error('[CRASH] window:error (minified React)', {
            location: 'window:error',
            ...buildReactCrashLogPayload(err),
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          });
        }
        scheduleCrashLog({
          location: 'window:error',
          message: msg || 'window error',
          data: {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: serializeError(event.error),
          },
        });
        return;
      }

    // Resource load errors rarely cause a white screen; log only if root is empty.
      const target = event.target as any;
      scheduleCrashLog({
        location: 'window:resource-error',
        message: 'resource load error',
        data: {
          tagName: target?.tagName,
          src: target?.src,
          href: target?.href,
        },
      });
    },
    true
  );

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : '';
    if (isMinifiedReactErrorMessage(msg)) {
      const err = reason instanceof Error ? reason : new Error(msg);
      log.error('[CRASH] unhandledrejection (minified React)', {
        location: 'window:unhandledrejection',
        ...buildReactCrashLogPayload(err),
      });
    }
    scheduleCrashLog({
      location: 'window:unhandledrejection',
      message: 'unhandled rejection',
      data: {
        reason: serializeError(event.reason),
      },
    });
  });
}

registerGlobalErrorHandlers();
installInteractionModalityTracking();

// Disable Tab-key focus traversal globally (IDE-style chrome).
// Allow Tab where it has semantic meaning: Monaco, xterm, and modal/dialog forms
// (SSH connect, account login, settings dialogs, etc. — Modal focus trap keeps focus inside).
document.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const target = e.target as Element | null;
    if (
      target?.closest(
        '.monaco-editor, .xterm, [role="dialog"], [aria-modal="true"]'
      )
    ) {
      return;
    }
    e.preventDefault();
  },
  true
);

/** Logger, appearance, and minimal deps must finish before the first React paint. */
async function initializeBeforeRender(): Promise<void> {
  const phaseStartedAt = nowMs();
  startupTrace.markPhase('before_render_start');
  await traceStartupStep('before_render_step', 'init_logger', async () => {
    await measureAsyncAndLog(log, 'Startup step completed', () => initLogger(), {
      data: { step: 'initLogger' },
    });
  });

  log.info('Initializing OpenBitFun');

  await traceStartupStep('before_render_step', 'appearance_initialize', async () => {
    await measureAsyncAndLog(log, 'Startup step completed', async () => {
      const { appearanceService } = await import('./infrastructure/appearance');
      await appearanceService.initialize();
    }, {
      data: { step: 'appearanceService.initialize' },
    });
  });
  log.info('Theme system initialized');
  logElapsed(log, 'Startup phase completed', phaseStartedAt, {
    data: { phase: 'initializeBeforeRender' },
  });
  startupTrace.markPhase('before_render_end', {
    durationMs: elapsedMs(phaseStartedAt),
  });
}

/** Rest of startup runs after the shell is interactive so first-screen latency stays reasonable. */
async function initializeAfterRender(): Promise<void> {
  const phaseStartedAt = nowMs();
  startupTrace.markPhase('after_render_start');
  const { fontPreferenceService } = await import('./infrastructure/font-preference');
  await fontPreferenceService.initialize();
  log.info('Font preference initialized at startup');

  const initResults = await Promise.allSettled([
    (async () => {
      const { backgroundTaskScheduler } = await import('./shared/utils/backgroundTaskScheduler');
      backgroundTaskScheduler.schedule(async () => {
        const { configManager } = await import('./infrastructure/config/services/ConfigManager');
        await configManager.getConfig('editor');
        log.info('Editor configuration preloaded');
      }, {
        idle: true,
        inFlightKey: 'startup:editor-config-preload',
        priority: 'low',
      });
    })(),
    (async () => {
      const {
        initializeFrontendLogLevelSync,
        installFrontendLogLevelConfigWatcher,
      } = await import('./infrastructure/config/services/FrontendLogLevelSync');
      await initializeFrontendLogLevelSync();
      await installFrontendLogLevelConfigWatcher();
    })(),
    (async () => {
      const { ensureSettingsAppliedListener } = await import(
        './infrastructure/account/settingsAppliedListener'
      );
      ensureSettingsAppliedListener();
    })(),
    (async () => {
      const { registerDefaultContextTypes } = await import('./shared/context-system/core/registerDefaultTypes');
      registerDefaultContextTypes();
    })(),
    (async () => {
      const { initRecommendationProviders } = await import('./flow_chat/components/smart-recommendations');
      initRecommendationProviders();
    })(),
    (async () => {
      const { initializeAllTools } = await import('./tools/initializeTools');
      await initializeAllTools();
    })(),
    (async () => {
      const { initContextMenuSystem } = await import('./shared/context-menu-system');
      initContextMenuSystem({
        registerBuiltinCommands: true,
        registerBuiltinProviders: true,
        debug: false,
      });

      const { registerNotificationContextMenu } = await import('./shared/notification-system');
      registerNotificationContextMenu();
    })(),
  ]);

  initResults.forEach((result, index) => {
    const names = [
      'EditorConfigPreload',
      'LogLevelConfigWatcher',
      'SettingsAppliedListener',
      'DefaultContextTypes',
      'RecommendationProviders',
      'Tools',
      'ContextMenu',
    ];
    if (result.status === 'rejected') {
      log.warn('Initialization failed', { module: names[index], error: result.reason });
    }
  });

  log.info('OpenBitFun core systems initialized successfully');
  logElapsed(log, 'Startup phase completed', phaseStartedAt, {
    data: { phase: 'initializeAfterRender' },
  });
  startupTrace.markPhase('after_render_end', {
    durationMs: elapsedMs(phaseStartedAt),
  });
}

async function startApplication(): Promise<void> {
  const appStartedAt = nowMs();
  startupTrace.markPhase('start_application_start');
  const isAgentCompanionWindow = new URLSearchParams(window.location.search)
    .get('openbitfunWindow') === 'agent-companion';
  // Select the dependency graph before importing either window. Start loading
  // alongside appearance initialization, avoiding another startup waterfall.
  // Keep separate import statements: a conditional import expression can be
  // folded into one Vite preload call carrying dependencies from both windows.
  let windowModule;
  if (isAgentCompanionWindow) {
    windowModule = import('./app/components/AgentCompanionDesktopPet/AgentCompanionDesktopPet');
  } else {
    windowModule = import('./app/startup/MainApplicationRoot');
  }
  void windowModule.catch(() => {}); // Observed below after pre-render initialization.
  try {
    await initializeBeforeRender();
  } catch (error) {
    log.error('Failed to initialize OpenBitFun (pre-render)', error);
  }

  startupTrace.markPhase('startup_step_start', { step: 'load_i18n_provider', mode: 'static' });
  startupTrace.markPhase('startup_step_end', {
    step: 'load_i18n_provider',
    durationMs: 0,
    mode: 'static',
  });
  const { default: WindowContent } = await windowModule;
  const renderStartedAt = nowMs();
  if (isAgentCompanionWindow) {
    ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
      <AppErrorBoundary>
        <I18nProvider>
          <OpenBitFunDesignSystemProvider>
            <WindowContent />
          </OpenBitFunDesignSystemProvider>
        </I18nProvider>
      </AppErrorBoundary>
    );
    logElapsed(log, 'Startup step completed', renderStartedAt, {
      data: {
        step: 'scheduleAgentCompanionRender',
        sinceStartupMs: elapsedMs(appStartedAt),
      },
    });
    startupTrace.markPhase('agent_companion_render_scheduled', {
      sinceStartupMs: elapsedMs(appStartedAt),
    });
    startupTrace.flushSummary('agent_companion_render_scheduled');
    return;
  }

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary>
      <I18nProvider>
        <OpenBitFunDesignSystemProvider>
          <WindowContent />
        </OpenBitFunDesignSystemProvider>
      </I18nProvider>
    </AppErrorBoundary>
  );
  logElapsed(log, 'Startup step completed', renderStartedAt, {
    data: {
      step: 'scheduleInitialRender',
      sinceStartupMs: elapsedMs(appStartedAt),
    },
  });
  startupTrace.markPhase('react_render_scheduled', {
    sinceStartupMs: elapsedMs(appStartedAt),
  });

  startupTrace.markPhase('non_critical_init_scheduled', {
    signalName: STARTUP_OVERLAY_HIDDEN_EVENT,
    fallbackTimeoutMs: 10000,
    frameCount: 1,
  });
  scheduleAfterStartupSignal(async () => {
    const nonCriticalStartedAt = nowMs();
    try {
      await initializeAfterRender();
      startupTrace.markPhase('non_critical_init_done', {
        durationMs: elapsedMs(nonCriticalStartedAt),
      });
      startupTrace.flushSummary('non_critical_init_completed');
    } catch (error) {
      log.error('Failed to complete post-render initialization', error);
      startupTrace.markPhase('non_critical_init_failed', {
        durationMs: elapsedMs(nonCriticalStartedAt),
      });
    }
  }, {
    signalName: STARTUP_OVERLAY_HIDDEN_EVENT,
    fallbackTimeoutMs: 10000,
    frameCount: 1,
    onError: error => {
      log.error('Failed to schedule post-render initialization', error);
    },
  });

  logElapsed(log, 'Startup phase completed', appStartedAt, {
    data: { phase: 'startApplication' },
  });
  startupTrace.markPhase('start_application_end', {
    durationMs: elapsedMs(appStartedAt),
  });
  startupTrace.flushSummary('start_application_completed');
}

void startApplication();
