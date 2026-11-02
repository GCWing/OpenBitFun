import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({ api: { invoke } }));
vi.mock('../errors/TauriCommandError', () => ({
  createTauriCommandError: (_command: string, error: unknown) => error,
}));

import { miniAppAPI } from './MiniAppAPI';

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
        imageContexts: [{ id: 'image-1', data_url: 'data:image/png;base64,YQ==', mime_type: 'image/png' }],
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
        imageContexts: [{ id: 'image-1', data_url: 'data:image/png;base64,YQ==', mime_type: 'image/png' }],
      }),
    });
  });
});
