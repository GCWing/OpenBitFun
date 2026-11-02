import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configApiMocks = vi.hoisted(() => ({
  getConfigs: vi.fn(),
  getRuntimeLoggingInfo: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: configApiMocks,
}));

vi.mock('@tauri-apps/plugin-log', () => ({
  trace: vi.fn(async () => {}),
  debug: vi.fn(async () => {}),
  info: vi.fn(async () => {}),
  warn: vi.fn(async () => {}),
  error: vi.fn(async () => {}),
}));

vi.mock('@/infrastructure/diagnostics/flowChatDiagnostics', () => ({
  setFlowChatDiagnosticsEnabled: vi.fn(),
}));

describe('FrontendLogLevelSync startup privacy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubGlobal('__OPENBITFUN_BOOTSTRAP_LOG_LEVEL__', 'trace');
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([undefined, false, true])(
    'redacts startup trace logs until saved preference %s is loaded',
    async (savedPreference) => {
      const traceOutput = vi.spyOn(console, 'debug').mockImplementation(() => {});
      configApiMocks.getConfigs.mockResolvedValue({
        'app.logging.level': 'trace',
        ...(savedPreference === undefined
          ? {}
          : { 'app.logging.include_sensitive_diagnostics': savedPreference }),
      });
      let finishRuntimeRead!: (value: { effectiveLevel: string }) => void;
      configApiMocks.getRuntimeLoggingInfo.mockReturnValue(new Promise((resolve) => {
        finishRuntimeRead = resolve;
      }));

      const { initializeFrontendLogLevelSync } = await import('./FrontendLogLevelSync');
      const { EventBatcher } = await import('@/flow_chat/services/EventBatcher');
      const initialization = initializeFrontendLogLevelSync();
      const batcher = new EventBatcher({ onFlush: vi.fn() });
      const flushToolEvent = () => {
        batcher.add('tool:params:session:call:none', {
          toolEvent: {
            event_type: 'ParamsPartial',
            params: 'private-source-content',
          },
        });
        batcher.flushNow();
      };

      try {
        flushToolEvent();
        expect(traceOutput).toHaveBeenCalled();
        expect(JSON.stringify(traceOutput.mock.calls)).not.toContain('private-source-content');

        finishRuntimeRead({ effectiveLevel: 'trace' });
        await initialization;
        traceOutput.mockClear();
        flushToolEvent();
        expect(traceOutput).toHaveBeenCalled();
        const output = JSON.stringify(traceOutput.mock.calls);
        if (savedPreference === true) {
          expect(output).toContain('private-source-content');
        } else {
          expect(output).not.toContain('private-source-content');
        }
      } finally {
        finishRuntimeRead({ effectiveLevel: 'trace' });
        await initialization;
        batcher.destroy();
      }
    },
  );
});
