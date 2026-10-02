import { beforeEach, describe, expect, it, vi } from 'vitest';

const configApiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getConfigs: vi.fn(),
  getRuntimeLoggingInfo: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  getLevel: vi.fn(),
  setLevel: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setIncludeSensitiveDiagnostics: vi.fn(),
  setFlowChatDiagnosticsEnabled: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: configApiMocks,
}));

vi.mock('@/shared/utils/logger', () => ({
  LogLevel: {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    NONE: 5,
  },
  logger: {
    getLevel: loggerMocks.getLevel,
    setLevel: loggerMocks.setLevel,
  },
  createLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  }),
  setIncludeSensitiveDiagnostics: loggerMocks.setIncludeSensitiveDiagnostics,
}));

vi.mock('@/infrastructure/diagnostics/flowChatDiagnostics', () => ({
  setFlowChatDiagnosticsEnabled: loggerMocks.setFlowChatDiagnosticsEnabled,
}));

const LOGGING_LEVEL_PATH = 'app.logging.level';
const LOGGING_INCLUDE_SENSITIVE_PATH = 'app.logging.include_sensitive_diagnostics';
const FLOW_CHAT_DIAGNOSTICS_PATH = 'app.logging.flow_chat_diagnostics';

async function importSyncModule() {
  vi.resetModules();
  return import('./FrontendLogLevelSync');
}

describe('FrontendLogLevelSync startup reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerMocks.getLevel.mockReturnValue(3);
    configApiMocks.getRuntimeLoggingInfo.mockResolvedValue({ effectiveLevel: 'warn' });
  });

  it('loads initial frontend logging settings through one batch config read', async () => {
    configApiMocks.getConfigs.mockResolvedValueOnce({
      [LOGGING_LEVEL_PATH]: 'debug',
      [LOGGING_INCLUDE_SENSITIVE_PATH]: false,
      [FLOW_CHAT_DIAGNOSTICS_PATH]: true,
    });

    const { initializeFrontendLogLevelSync } = await importSyncModule();
    await initializeFrontendLogLevelSync();

    expect(configApiMocks.getConfigs).toHaveBeenCalledTimes(1);
    expect(configApiMocks.getConfigs).toHaveBeenCalledWith([
      LOGGING_LEVEL_PATH,
      LOGGING_INCLUDE_SENSITIVE_PATH,
      FLOW_CHAT_DIAGNOSTICS_PATH,
    ]);
    expect(configApiMocks.getConfig).not.toHaveBeenCalled();
    expect(configApiMocks.getRuntimeLoggingInfo).toHaveBeenCalledTimes(1);
    expect(loggerMocks.setLevel).toHaveBeenCalledWith(1);
    expect(loggerMocks.setIncludeSensitiveDiagnostics).toHaveBeenCalledWith(false);
    expect(loggerMocks.setFlowChatDiagnosticsEnabled).toHaveBeenCalledWith(true);
  });

  it('falls back to the runtime log level when the saved frontend level is invalid', async () => {
    configApiMocks.getConfigs.mockResolvedValueOnce({
      [LOGGING_LEVEL_PATH]: 'verbose',
      [LOGGING_INCLUDE_SENSITIVE_PATH]: true,
      [FLOW_CHAT_DIAGNOSTICS_PATH]: false,
    });
    configApiMocks.getRuntimeLoggingInfo.mockResolvedValueOnce({ effectiveLevel: 'error' });

    const { initializeFrontendLogLevelSync } = await importSyncModule();
    await initializeFrontendLogLevelSync();

    expect(loggerMocks.setLevel).toHaveBeenCalledWith(4);
    expect(loggerMocks.setIncludeSensitiveDiagnostics).toHaveBeenCalledWith(true);
    expect(loggerMocks.setFlowChatDiagnosticsEnabled).toHaveBeenCalledWith(false);
  });

  it('defaults sensitive diagnostics to off when no saved preference exists (#3213)', async () => {
    configApiMocks.getConfigs.mockResolvedValueOnce({
      [LOGGING_LEVEL_PATH]: 'warn',
    });
    configApiMocks.getRuntimeLoggingInfo.mockResolvedValueOnce({ effectiveLevel: 'warn' });

    const { initializeFrontendLogLevelSync } = await importSyncModule();
    await initializeFrontendLogLevelSync();

    expect(loggerMocks.setIncludeSensitiveDiagnostics).toHaveBeenCalledWith(false);
  });

  it('falls back to runtime info with sensitive diagnostics off when no saved preference exists (#3213)', async () => {
    configApiMocks.getConfigs.mockResolvedValueOnce({});
    configApiMocks.getRuntimeLoggingInfo.mockResolvedValueOnce({ effectiveLevel: 'error' });

    const { initializeFrontendLogLevelSync } = await importSyncModule();
    await initializeFrontendLogLevelSync();

    expect(loggerMocks.setLevel).toHaveBeenCalledWith(4);
    expect(loggerMocks.setIncludeSensitiveDiagnostics).toHaveBeenCalledWith(false);
  });
});
