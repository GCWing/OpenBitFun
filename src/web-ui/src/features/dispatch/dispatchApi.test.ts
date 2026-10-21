import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchApi } from './dispatchApi';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    invoke: mocks.invoke,
  },
}));

describe('dispatchApi', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue([]);
  });

  it('wraps the target list command in the structured Tauri request contract', async () => {
    await dispatchApi.listTargets();

    expect(mocks.invoke).toHaveBeenCalledWith('dispatch_list_targets', {
      request: {},
    });
  });

  it('forwards force compaction to the target without changing ordinary compact requests', async () => {
    await dispatchApi.continueJob('job-1', 'turn-1', '', undefined, { kind: 'compact', force: true });
    expect(mocks.invoke).toHaveBeenLastCalledWith('dispatch_continue', {
      request: expect.objectContaining({ jobId: 'job-1', kind: 'compact', force: true }),
    });
    await dispatchApi.continueJob('job-1', 'turn-2', '', undefined, { kind: 'compact' });
    expect(mocks.invoke.mock.calls.at(-1)![1].request).not.toHaveProperty('force');
  });

  it('carries the selected reasoning preset when submitting a job', async () => {
    await dispatchApi.submit({
      target: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/repo',
      },
      includeUncommitted: false,
      jobId: 'job-1',
      sessionId: 'session-1',
      agentType: 'Standard',
      prompt: 'Inspect the repository',
      approvalPolicy: 'reject-and-report',
      model: 'target-model',
      reasoningPreset: 'high',
    });

    expect(mocks.invoke).toHaveBeenCalledWith('dispatch_submit', {
      request: expect.objectContaining({
        model: 'target-model',
        reasoningPreset: 'high',
      }),
    });
  });

  it('carries Auto when continuing a job to clear the target override', async () => {
    await dispatchApi.continueJob(
      'job-1',
      'turn-2',
      'Continue',
      undefined,
      { model: 'target-model', reasoningPreset: 'auto' },
    );

    expect(mocks.invoke).toHaveBeenCalledWith('dispatch_continue', {
      request: expect.objectContaining({
        jobId: 'job-1',
        turnId: 'turn-2',
        model: 'target-model',
        reasoningPreset: 'auto',
      }),
    });
  });
});
