import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionUsageReport,
} from '@/infrastructure/api/service-api/SessionAPI';
import type { FlowChatState, Session } from '../types/flow-chat';
import { flowChatStore } from '../store/FlowChatStore';
import {
  closeSessionUsageModal,
  getSessionUsageModalState,
} from '../components/usage/sessionUsageModalState';

const sessionApiMocks = vi.hoisted(() => ({
  getSessionUsageReport: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: sessionApiMocks,
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

const createSession = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 'session-1',
  title: 'Session 1',
  dialogTurns: [],
  status: 'idle',
  config: { agentType: 'Standard' },
  createdAt: 1,
  lastActiveAt: 1,
  error: null,
  isHistorical: false,
  todos: [],
  maxContextTokens: 128128,
  mode: 'Standard',
  workspaceId: 'workspace-1',
  workspacePath: 'D:/workspace/OpenBitFun',
  isTransient: false,
  ...overrides,
});

const usageReport = (overrides: Partial<SessionUsageReport> = {}): SessionUsageReport => ({
  schemaVersion: 1,
  reportId: 'usage-report-1',
  sessionId: 'session-1',
  generatedAt: 100,
  workspace: {
    kind: 'local',
    pathLabel: 'D:/workspace/OpenBitFun',
  },
  scope: {
    kind: 'entire_session',
    turnCount: 1,
    includesSubagents: false,
  },
  coverage: {
    level: 'complete',
    available: [],
    missing: [],
    notes: [],
  },
  time: {
    accounting: 'approximate',
    denominator: 'session_wall_time',
    wallTimeMs: 1000,
  },
  tokens: {
    source: 'token_usage_records',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheCoverage: 'unavailable',
  },
  models: [],
  tools: [],
  files: {
    scope: 'unavailable',
    files: [],
  },
  compression: {
    compactionCount: 0,
    manualCompactionCount: 0,
    automaticCompactionCount: 0,
  },
  errors: {
    totalErrors: 0,
    toolErrors: 0,
    modelErrors: 0,
    examples: [],
  },
  slowest: [],
  privacy: {
    promptContentIncluded: false,
    toolInputsIncluded: false,
    commandOutputsIncluded: false,
    fileContentsIncluded: false,
    redactedFields: [],
  },
  ...overrides,
});

const uiParams = {
  isProcessing: false,
  busyMessage: 'busy',
  noWorkspaceMessage: 'missing workspace',
  failedTitle: 'failed',
  unknownErrorMessage: 'unknown',
};

const transcriptOf = (sessionId = 'session-1') => (
  flowChatStore.getState().sessions.get(sessionId)?.dialogTurns ?? []
);

describe('runUsageReportCommand', () => {
  beforeEach(() => {
    flowChatStore.setState((): FlowChatState => ({
      sessions: new Map([['session-1', createSession()]]),
      activeSessionId: 'session-1',
    }));
    sessionApiMocks.getSessionUsageReport.mockReset();
  });

  afterEach(() => {
    closeSessionUsageModal();
    flowChatStore.setState((): FlowChatState => ({
      sessions: new Map(),
      activeSessionId: null,
    }));
  });

  it('shows the waiting state immediately and replaces it with the report', async () => {
    let resolveReport: (report: SessionUsageReport) => void = () => {};
    sessionApiMocks.getSessionUsageReport.mockReturnValue(new Promise<SessionUsageReport>(resolve => {
      resolveReport = resolve;
    }));
    const { runUsageReportCommand } = await import('./usageReportService');

    const pending = runUsageReportCommand({ session: createSession(), ...uiParams });

    // Open before the request resolves. The wait is the whole reason the report
    // used to be inserted as a turn in two stages.
    expect(getSessionUsageModalState()).toMatchObject({
      open: true,
      isLoading: true,
      sessionId: 'session-1',
    });
    expect(getSessionUsageModalState().report).toBeUndefined();

    resolveReport(usageReport());
    const result = await pending;

    expect(result.shown).toBe(true);
    const state = getSessionUsageModalState();
    expect(state).toMatchObject({ open: true, isLoading: false });
    expect(state.report?.reportId).toBe('usage-report-1');
    expect(state.markdown).toContain('# Session Usage Report');
    expect(state.markdown).toContain('Session span');
    expect(state.markdown).toContain('not reported');
    expect(state.markdown).not.toContain('Wall time');
    expect(state.markdown).not.toContain('Cached | unavailable');
    expect(sessionApiMocks.getSessionUsageReport).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      includeHiddenSubagents: true,
    });
  });

  it('leaves the transcript alone, which is the point of it', async () => {
    /*
     * A report about a session is not an event in it. As a turn it grew
     * `dialogTurns` and moved `at(-1)`, which is what follow-output reads as a
     * Turn arriving, so a report pinned itself to the top of the viewport; and
     * once persisted it took a numbered slot in the Turn rail.
     */
    sessionApiMocks.getSessionUsageReport.mockResolvedValue(usageReport());
    const { runUsageReportCommand } = await import('./usageReportService');

    await runUsageReportCommand({ session: createSession(), ...uiParams });

    expect(transcriptOf()).toEqual([]);
  });

  it('closes the waiting state when the report cannot be produced', async () => {
    sessionApiMocks.getSessionUsageReport.mockRejectedValueOnce(new Error('report failed'));
    const { runUsageReportCommand } = await import('./usageReportService');

    await expect(runUsageReportCommand({ session: createSession(), ...uiParams }))
      .rejects.toThrow('report failed');

    // Left open it would wait forever: no second request is coming.
    expect(getSessionUsageModalState().open).toBe(false);
    expect(transcriptOf()).toEqual([]);
  });

  it('does not open at all when there is no workspace to report on', async () => {
    const { runUsageReportCommand } = await import('./usageReportService');

    const result = await runUsageReportCommand({
      session: createSession({ workspaceId: undefined }),
      ...uiParams,
    });

    expect(result).toMatchObject({ shown: false, reason: 'missing_workspace' });
    expect(getSessionUsageModalState().open).toBe(false);
  });

  it('infers legacy model rows from the session model without showing raw missing-model copy', async () => {
    const session = createSession({
      config: { agentType: 'Standard', modelName: 'gpt-5.4' },
    });
    sessionApiMocks.getSessionUsageReport.mockResolvedValue(usageReport({
      models: [{
        modelId: 'unknown_model',
        callCount: 2,
        durationMs: 420,
      }],
      slowest: [{
        label: 'unknown_model',
        kind: 'model',
        durationMs: 420,
        redacted: false,
      }],
    }));
    const { runUsageReportCommand } = await import('./usageReportService');

    const result = await runUsageReportCommand({ session, ...uiParams });

    expect(result.report?.models[0]).toMatchObject({
      modelId: 'gpt-5.4',
      modelIdSource: 'inferred_session_model',
    });
    expect(result.report?.slowest[0]).toMatchObject({
      label: 'gpt-5.4',
      modelIdSource: 'inferred_session_model',
    });
    expect(result.report?.slowest[0].label).not.toBe('unknown_model');

    const state = getSessionUsageModalState();
    expect(state.report?.models[0]).toMatchObject({
      modelId: 'gpt-5.4',
      modelIdSource: 'inferred_session_model',
    });
    expect(state.markdown).toContain('gpt-5.4 (inferred)');
    expect(state.markdown).not.toContain('Model not recorded');
  });

  it('does not infer legacy model rows from opaque session model identifiers', async () => {
    const { runUsageReportCommand } = await import('./usageReportService');

    for (const opaqueModelId of [
      '019e0c07-c7bc-73f1-b1d6-5260ed215fe0',
      'model_1780555920188_0',
    ]) {
      const session = createSession({
        config: { agentType: 'Standard', modelName: opaqueModelId },
      });
      sessionApiMocks.getSessionUsageReport.mockResolvedValueOnce(usageReport({
        models: [{
          modelId: 'unknown_model',
          callCount: 1,
          durationMs: 120,
        }],
        slowest: [{
          label: 'unknown_model',
          kind: 'model',
          durationMs: 120,
          redacted: false,
        }],
      }));

      const result = await runUsageReportCommand({ session, ...uiParams });

      expect(result.report?.models[0]).toMatchObject({
        modelId: 'unknown_model',
        modelIdSource: 'legacy_missing',
      });
      expect(result.report?.slowest[0]).toMatchObject({
        label: 'unknown_model',
        modelIdSource: 'legacy_missing',
      });

      const { markdown } = getSessionUsageModalState();
      expect(markdown).toContain('Legacy model not tracked');
      expect(markdown).not.toContain(opaqueModelId);
      expect(markdown).not.toContain('(inferred)');
      closeSessionUsageModal();
    }
  });

  it('treats legacy model round placeholders as missing model identity', async () => {
    const session = createSession({
      config: { agentType: 'Standard', modelName: '019e0c07-c7bc-73f1-b1d6-5260ed215fe0' },
    });
    sessionApiMocks.getSessionUsageReport.mockResolvedValue(usageReport({
      models: [{
        modelId: 'model round 0',
        callCount: 1,
        durationMs: 120,
      }],
      slowest: [{
        label: 'model round 0',
        kind: 'model',
        durationMs: 120,
        redacted: false,
      }],
    }));
    const { runUsageReportCommand } = await import('./usageReportService');

    const result = await runUsageReportCommand({ session, ...uiParams });

    expect(result.report?.models[0]).toMatchObject({
      modelId: 'unknown_model',
      modelIdSource: 'legacy_missing',
    });
    expect(result.report?.slowest[0]).toMatchObject({
      label: 'unknown_model',
      modelIdSource: 'legacy_missing',
    });

    const { markdown } = getSessionUsageModalState();
    expect(markdown).toContain('Legacy model not tracked');
    expect(markdown).not.toContain('model round');
  });
});
