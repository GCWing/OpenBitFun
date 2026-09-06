import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({ api: { invoke } }));
vi.mock('../errors/TauriCommandError', () => ({
  createTauriCommandError: (_command: string, error: unknown) => error,
}));

import { miniAppAPI } from './MiniAppAPI';
import { loopxAPI } from './LoopxAPI';

describe('MiniAppAPI agent bridge', () => {
  beforeEach(() => invoke.mockReset());

  it('keeps the user-facing request separate from the internal agent prompt', async () => {
    invoke.mockResolvedValue({
      sessionId: 'session-1',
      turnId: 'turn-1',
      actionRunId: 'turn-1',
      status: 'started',
    });

    await miniAppAPI.agentRun(
      'builtin-ppt-live',
      'internal structured prompt',
      '/tmp/workspace',
      {
        sessionId: 'session-1',
        displayText: '随便做几页测试页',
        appDataWorkspace: 'chat',
        contextFiles: [{ name: 'stocks.ndjson', content: '{"code":"688256"}\n' }],
      },
    );

    expect(invoke).toHaveBeenCalledWith('miniapp_agent_run', {
      request: expect.objectContaining({
        appId: 'builtin-ppt-live',
        prompt: 'internal structured prompt',
        displayText: '随便做几页测试页',
        sessionId: 'session-1',
        workspacePath: '/tmp/workspace',
        appDataWorkspace: 'chat',
        contextFiles: [{ name: 'stocks.ndjson', content: '{"code":"688256"}\n' }],
      }),
    });
  });
});

describe('LoopxAPI private built-in bridge', () => {
  beforeEach(() => invoke.mockReset());

  it('uses structured requests for attach and replay', async () => {
    invoke.mockResolvedValue({});

    await loopxAPI.attach('builtin-bitfun-loopx', {
      knownStreamId: 'stream-1',
      afterCursor: 7,
      resumeDetected: true,
    });
    await loopxAPI.eventsSince('builtin-bitfun-loopx', {
      streamId: 'stream-1',
      afterCursor: 7,
      limit: 100,
    });
    await loopxAPI.turnOutputSince('builtin-bitfun-loopx', {
      taskId: 'task-1',
      turnId: 'turn-1',
      streamId: 'stream-1',
      afterCursor: 12,
      limit: 50,
    });

    expect(invoke).toHaveBeenNthCalledWith(1, 'miniapp_loopx_attach', {
      request: {
        appId: 'builtin-bitfun-loopx',
        knownStreamId: 'stream-1',
        afterCursor: 7,
        resumeDetected: true,
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'miniapp_loopx_events_since', {
      request: {
        appId: 'builtin-bitfun-loopx',
        streamId: 'stream-1',
        afterCursor: 7,
        limit: 100,
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'miniapp_loopx_turn_output_since', {
      request: {
        appId: 'builtin-bitfun-loopx',
        taskId: 'task-1',
        turnId: 'turn-1',
        streamId: 'stream-1',
        afterCursor: 12,
        limit: 50,
      },
    });
  });

  it('keeps intake and task creation on typed controller commands', async () => {
    invoke.mockResolvedValue({});
    const item = {
      repository: { host: 'github.com', owner: 'GCWing', repository: 'BitFun' },
      kind: 'issue' as const,
      number: 2382,
    };

    await loopxAPI.resolveIntake('builtin-bitfun-loopx', {
      input: 'https://github.com/GCWing/BitFun/issues/2382',
      modelId: 'primary',
    });
    await loopxAPI.createTask('builtin-bitfun-loopx', {
      clientRequestId: 'request-1',
      previewFingerprint: 'preview-1',
      selectedItems: [item],
      modelId: 'primary',
      grantedScopes: ['workspace_read', 'workspace_write', 'agent_execution'],
      retryTerminal: false,
    });

    expect(invoke).toHaveBeenNthCalledWith(1, 'miniapp_loopx_resolve_intake', {
      request: {
        appId: 'builtin-bitfun-loopx',
        input: 'https://github.com/GCWing/BitFun/issues/2382',
        modelId: 'primary',
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'miniapp_loopx_create_task', {
      request: {
        appId: 'builtin-bitfun-loopx',
        clientRequestId: 'request-1',
        previewFingerprint: 'preview-1',
        selectedItems: [item],
        modelId: 'primary',
        grantedScopes: ['workspace_read', 'workspace_write', 'agent_execution'],
        retryTerminal: false,
      },
    });
  });

  it('forwards only the typed action envelope', async () => {
    invoke.mockResolvedValue({});

    await loopxAPI.action('builtin-bitfun-loopx', {
      taskId: 'task-1',
      action: 'approve',
      clientRequestId: 'request-2',
      expectedRevision: 9,
      gateId: 'gate-1',
      note: 'Approved after review',
    });

    expect(invoke).toHaveBeenCalledWith('miniapp_loopx_action', {
      request: {
        appId: 'builtin-bitfun-loopx',
        taskId: 'task-1',
        action: 'approve',
        clientRequestId: 'request-2',
        expectedRevision: 9,
        gateId: 'gate-1',
        note: 'Approved after review',
      },
    });
  });
});
