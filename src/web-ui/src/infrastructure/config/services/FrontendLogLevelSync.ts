import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import {
  LogLevel,
  createLogger,
  logger,
  setIncludeSensitiveDiagnostics,
} from '@/shared/utils/logger';
import type { BackendLogLevel } from '../types';
import { setFlowChatDiagnosticsEnabled } from '@/infrastructure/diagnostics/flowChatDiagnostics';

const log = createLogger('FrontendLogLevelSync');
const LOGGING_LEVEL_PATH = 'app.logging.level';
const LOGGING_INCLUDE_SENSITIVE_PATH = 'app.logging.include_sensitive_diagnostics';
const FLOW_CHAT_DIAGNOSTICS_PATH = 'app.logging.flow_chat_diagnostics';

let initialSettingsLoaded = false;
let configWatcherInstalled = false;

interface InitialLoggingSettings {
  level?: string;
  includeSensitiveDiagnostics: boolean;
  flowChatDiagnostics: boolean;
}

function toFrontendLogLevel(level: string | null | undefined): LogLevel | null {
  switch (level?.trim().toLowerCase()) {
    case 'trace':
      return LogLevel.TRACE;
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    case 'off':
      return LogLevel.NONE;
    default:
      return null;
  }
}

function toBackendLogLevel(level: LogLevel): BackendLogLevel {
  switch (level) {
    case LogLevel.TRACE:
      return 'trace';
    case LogLevel.DEBUG:
      return 'debug';
    case LogLevel.INFO:
      return 'info';
    case LogLevel.WARN:
      return 'warn';
    case LogLevel.ERROR:
      return 'error';
    case LogLevel.NONE:
      return 'off';
  }
}

function applyFrontendLogLevel(level: string | null | undefined, source: string): void {
  const nextLevel = toFrontendLogLevel(level);
  if (nextLevel === null) {
    if (level) {
      log.warn('Ignoring invalid frontend log level', { level, source });
    }
    return;
  }

  const previousLevel = logger.getLevel();
  if (previousLevel === nextLevel) {
    return;
  }

  logger.setLevel(nextLevel);
  log.info('Frontend log level updated', {
    oldLevel: toBackendLogLevel(previousLevel),
    newLevel: toBackendLogLevel(nextLevel),
    source,
  });
}

async function resolveInitialLoggingSettings(): Promise<InitialLoggingSettings> {
  const [configResult, runtimeInfoResult] = await Promise.allSettled([
    configAPI.getConfigs([
      LOGGING_LEVEL_PATH,
      LOGGING_INCLUDE_SENSITIVE_PATH,
      FLOW_CHAT_DIAGNOSTICS_PATH,
    ]),
    configAPI.getRuntimeLoggingInfo(),
  ]);

  const configs = configResult.status === 'fulfilled' ? configResult.value : {};
  if (configResult.status === 'rejected') {
    log.warn('Failed to load frontend logging configs in batch', configResult.reason);
  }

  const savedLevel = configs[LOGGING_LEVEL_PATH];
  if (typeof savedLevel === 'string' && toFrontendLogLevel(savedLevel) !== null) {
    return {
      level: savedLevel,
      includeSensitiveDiagnostics:
        typeof configs[LOGGING_INCLUDE_SENSITIVE_PATH] === 'boolean'
          ? configs[LOGGING_INCLUDE_SENSITIVE_PATH]
          : false,
      flowChatDiagnostics: configs[FLOW_CHAT_DIAGNOSTICS_PATH] === true,
    };
  }

  if (runtimeInfoResult.status === 'fulfilled') {
    const runtimeLevel = runtimeInfoResult.value?.effectiveLevel;
    if (toFrontendLogLevel(runtimeLevel) !== null) {
      return {
        level: runtimeLevel,
        includeSensitiveDiagnostics:
          typeof configs[LOGGING_INCLUDE_SENSITIVE_PATH] === 'boolean'
            ? configs[LOGGING_INCLUDE_SENSITIVE_PATH]
            : false,
        flowChatDiagnostics: configs[FLOW_CHAT_DIAGNOSTICS_PATH] === true,
      };
    }
  }

  return {
    includeSensitiveDiagnostics:
      typeof configs[LOGGING_INCLUDE_SENSITIVE_PATH] === 'boolean'
        ? configs[LOGGING_INCLUDE_SENSITIVE_PATH]
        : false,
    flowChatDiagnostics: configs[FLOW_CHAT_DIAGNOSTICS_PATH] === true,
  };
}

export async function initializeFrontendLogLevelSync(): Promise<void> {
  if (initialSettingsLoaded) {
    return;
  }

  initialSettingsLoaded = true;

  try {
    const initialSettings = await resolveInitialLoggingSettings();
    applyFrontendLogLevel(initialSettings.level, 'startup');
    setIncludeSensitiveDiagnostics(initialSettings.includeSensitiveDiagnostics);
    setFlowChatDiagnosticsEnabled(initialSettings.flowChatDiagnostics);
  } catch (error) {
    log.error('Failed to initialize frontend log level sync', error);
  }
}

export async function installFrontendLogLevelConfigWatcher(): Promise<void> {
  if (configWatcherInstalled) {
    return;
  }

  configWatcherInstalled = true;

  try {
    const { configManager } = await import('./ConfigManager');
    configManager.onConfigChange((path, _oldValue, newValue) => {
      if (path === LOGGING_LEVEL_PATH) {
        applyFrontendLogLevel(typeof newValue === 'string' ? newValue : undefined, 'config_change');
        return;
      }

      if (path === LOGGING_INCLUDE_SENSITIVE_PATH) {
        setIncludeSensitiveDiagnostics(typeof newValue === 'boolean' ? newValue : true);
        return;
      }

      if (path === FLOW_CHAT_DIAGNOSTICS_PATH) {
        setFlowChatDiagnosticsEnabled(newValue === true);
      }
    });
  } catch (error) {
    configWatcherInstalled = false;
    log.error('Failed to install frontend log level config watcher', error);
  }
}
