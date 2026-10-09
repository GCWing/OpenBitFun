// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/infrastructure/api';
import { computeCronJobCounts } from './cronJobCountsStore';
import { notifyScheduledJobsChanged, SCHEDULED_JOBS_CHANGED_EVENT } from './scheduledJobDraft';

const { listJobs, onJobsChanged } = vi.hoisted(() => ({
  listJobs: vi.fn(),
  onJobsChanged: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({ cronAPI: { listJobs, onJobsChanged } }));

function sessionJob(id: string, sessionId: string, workspaceId: string, enabled = true): CronJob {
  return {
    id,
    name: id,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { text: 'hello' },
    enabled,
    target: {
      kind: 'session',
      sessionId,
      workspace: { workspaceId, workspacePath: '/tmp/workspace' },
    },
    createdAtMs: 0,
    configUpdatedAtMs: 0,
    updatedAtMs: 0,
    state: { consecutiveFailures: 0, coalescedRunCount: 0 },
  };
}

function workspaceJob(id: string, workspaceId: string): CronJob {
  return {
    id,
    name: id,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { text: 'hello' },
    enabled: true,
    target: {
      kind: 'workspace',
      workspace: { workspaceId, workspacePath: '/tmp/workspace' },
      launch: { agentType: 'Standard' },
    },
    createdAtMs: 0,
    configUpdatedAtMs: 0,
    updatedAtMs: 0,
    state: { consecutiveFailures: 0, coalescedRunCount: 0 },
  };
}

describe('computeCronJobCounts', () => {
  it('counts a session job towards its workspace and its session', () => {
    const counts = computeCronJobCounts([
      sessionJob('cron_a', 'session_1', 'ws_1'),
      sessionJob('cron_b', 'session_1', 'ws_1'),
      sessionJob('cron_c', 'session_2', 'ws_1'),
    ]);

    expect(counts.byWorkspaceId.get('ws_1')).toBe(3);
    expect(counts.bySessionId.get('session_1')).toBe(2);
    expect(counts.bySessionId.get('session_2')).toBe(1);
  });

  it('counts a workspace job without attributing it to a session', () => {
    const counts = computeCronJobCounts([workspaceJob('cron_d', 'ws_1')]);

    expect(counts.byWorkspaceId.get('ws_1')).toBe(1);
    expect(counts.bySessionId.size).toBe(0);
  });

  it('counts only enabled jobs when a session also has paused schedules', () => {
    const counts = computeCronJobCounts([
      sessionJob('cron_e', 'session_1', 'ws_1', false),
      sessionJob('cron_f', 'session_1', 'ws_1'),
    ]);

    expect(counts.byWorkspaceId.get('ws_1')).toBe(1);
    expect(counts.bySessionId.get('session_1')).toBe(1);
  });

  it('clears clock counts when every schedule is paused', () => {
    const pausedWorkspaceJob = { ...workspaceJob('cron_workspace', 'ws_1'), enabled: false };
    const counts = computeCronJobCounts([
      sessionJob('cron_e', 'session_1', 'ws_1', false),
      pausedWorkspaceJob,
    ]);

    expect(counts.byWorkspaceId.size).toBe(0);
    expect(counts.bySessionId.size).toBe(0);
  });

  it('ignores jobs whose workspace has no id', () => {
    const job = sessionJob('cron_g', 'session_1', 'ws_1');
    job.target.workspace = { workspacePath: '/tmp/workspace' };

    const counts = computeCronJobCounts([job]);

    expect(counts.byWorkspaceId.size).toBe(0);
    expect(counts.bySessionId.get('session_1')).toBe(1);
  });
});

describe('scheduled-job badge updates', () => {
  let store: typeof import('./cronJobCountsStore');
  let backendChanged: () => void;
  let addEventListener: ReturnType<typeof vi.spyOn<typeof window, 'addEventListener'>>;

  beforeEach(async () => {
    vi.resetModules();
    listJobs.mockReset().mockResolvedValue([]);
    onJobsChanged.mockReset().mockImplementation((callback: () => void) => {
      backendChanged = callback;
      return () => {};
    });
    addEventListener = vi.spyOn(window, 'addEventListener');
    store = await import('./cronJobCountsStore');
  });

  afterEach(() => {
    for (const [type, listener, options] of addEventListener.mock.calls) {
      window.removeEventListener(type, listener, options);
    }
    vi.restoreAllMocks();
  });

  it('publishes pause, resume and deletion from local and backend changes', async () => {
    const job = sessionJob('cron_a', 'session_1', 'ws_1');
    listJobs.mockResolvedValue([job]);
    const notify = vi.fn();
    store.subscribeCronJobCounts(notify);
    store.ensureCronJobCountsListener();
    store.ensureCronJobCountsListener();

    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.get('session_1')).toBe(1));
    expect(onJobsChanged).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls.filter(([type]) => type === SCHEDULED_JOBS_CHANGED_EVENT)).toHaveLength(1);

    listJobs.mockResolvedValue([{ ...job, enabled: false }]);
    notifyScheduledJobsChanged('todos');
    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.size).toBe(0));

    listJobs.mockResolvedValue([job]);
    backendChanged();
    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.get('session_1')).toBe(1));

    listJobs.mockResolvedValue([]);
    backendChanged();
    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.size).toBe(0));
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it('refreshes again when a pause arrives while an older read is in flight', async () => {
    const job = sessionJob('cron_a', 'session_1', 'ws_1');
    listJobs.mockResolvedValueOnce([job]);
    store.ensureCronJobCountsListener();
    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.get('session_1')).toBe(1));

    let finishRead!: (jobs: CronJob[]) => void;
    listJobs.mockReturnValueOnce(new Promise<CronJob[]>(resolve => { finishRead = resolve; }));
    listJobs.mockResolvedValueOnce([{ ...job, enabled: false }]);
    backendChanged();
    notifyScheduledJobsChanged('todos');
    backendChanged();
    expect(listJobs).toHaveBeenCalledTimes(2);

    finishRead([job]);
    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.size).toBe(0));
    expect(listJobs).toHaveBeenCalledTimes(3);
  });

  it('drains a pending change even when the in-flight read fails', async () => {
    let failRead!: (error: Error) => void;
    listJobs.mockReturnValueOnce(new Promise<CronJob[]>((_resolve, reject) => { failRead = reject; }));
    listJobs.mockResolvedValueOnce([sessionJob('cron_a', 'session_1', 'ws_1')]);
    store.ensureCronJobCountsListener();
    backendChanged();
    failRead(new Error('Host temporarily unavailable'));

    await vi.waitFor(() => expect(store.getCronJobCountsSnapshot().bySessionId.get('session_1')).toBe(1));
    expect(listJobs).toHaveBeenCalledTimes(2);
  });
});
