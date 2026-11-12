/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchJobStore } from '@/features/dispatch/dispatchJobStore';

const mocks = vi.hoisted(() => ({
  answerPermission: vi.fn(),
  cancel: vi.fn(),
  requestRefresh: vi.fn(),
}));

vi.mock('@/features/dispatch/dispatchApi', () => ({
  dispatchApi: {
    answerPermission: mocks.answerPermission,
    cancel: mocks.cancel,
  },
}));

vi.mock('@/features/dispatch/DispatchJobObserver', () => ({
  requestDispatchJobRefresh: mocks.requestRefresh,
}));

import {
  actionableDispatchPermissions,
  cancelDispatchJob,
  DISPATCH_CANCEL_RETRY_DELAYS_MS,
  dispatchSessionDriver,
} from './DispatchSessionDriver';

const PERMISSION = {
  requestId: 'approval-1',
  sessionId: 'session-1',
  toolName: 'Bash',
};

function registerJob(pendingPermissions: Array<Record<string, unknown>> = [PERMISSION]): void {
  dispatchJobStore.getState().registerJob({
    jobId: 'job-1',
    sessionId: 'session-1',
    targetRequest: { kind: 'ssh', connectionId: 'ssh-1', workspacePath: '/repo' },
    target: { kind: 'ssh', connectionId: 'ssh-1', workspacePath: '/repo', displayName: 'build-host' },
    sourceWorkspacePath: '/source',
    title: 'Dispatch test',
    agentType: 'Standard',
    approvalPolicy: 'remote',
    cursor: 0,
    state: 'running',
    appliedEventIds: [],
    pendingPermissions,
    eventLogComplete: true,
    historyTruncated: false,
    omittedEventCount: 0,
    createdAt: 1,
    updatedAt: 1,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DispatchSessionDriver', () => {
  beforeEach(() => {
    dispatchJobStore.getState().clear();
    mocks.answerPermission.mockReset().mockResolvedValue({ resolved: true });
    mocks.cancel.mockReset();
    mocks.requestRefresh.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('permission prompts', () => {
    it('keeps persisted prompts stale until a status read confirms them', async () => {
      registerJob();
      // Restored from disk: transport state is unknown until the first poll.
      expect(actionableDispatchPermissions('session-1')).toEqual([]);
      await expect(
        dispatchSessionDriver.respondPermission('session-1', 'approval-1', 'once'),
      ).rejects.toThrow();
      expect(mocks.answerPermission).not.toHaveBeenCalled();

      dispatchJobStore.getState().setTransportState('job-1', 'reachable');
      expect(actionableDispatchPermissions('session-1')).toEqual([PERMISSION]);
      // Stable reference for useSyncExternalStore while nothing changed.
      expect(actionableDispatchPermissions('session-1'))
        .toBe(actionableDispatchPermissions('session-1'));

      dispatchJobStore.getState().setTransportState('job-1', 'unreachable', 'offline');
      expect(actionableDispatchPermissions('session-1')).toEqual([]);
      await expect(
        dispatchSessionDriver.respondPermission('session-1', 'approval-1', 'once'),
      ).rejects.toThrow();
      expect(mocks.answerPermission).not.toHaveBeenCalled();
    });

    it('removes an answered prompt at once and restores it when delivery fails', async () => {
      registerJob();
      dispatchJobStore.getState().setTransportState('job-1', 'reachable');
      const answer = createDeferred<{ resolved: boolean }>();
      mocks.answerPermission.mockReturnValueOnce(answer.promise);

      const pending = dispatchSessionDriver.respondPermission('session-1', 'approval-1', 'once');
      expect(actionableDispatchPermissions('session-1')).toEqual([]);
      expect(dispatchJobStore.getState().answeredPermissionIdsByJobId['job-1']).toEqual(['approval-1']);
      answer.reject(new Error('SSH channel closed'));
      await expect(pending).rejects.toThrow('SSH channel closed');
      expect(actionableDispatchPermissions('session-1')).toEqual([PERMISSION]);

      await dispatchSessionDriver.respondPermission('session-1', 'approval-1', 'once');
      expect(actionableDispatchPermissions('session-1')).toEqual([]);
      expect(mocks.requestRefresh).toHaveBeenCalledWith('job-1');
      // The target still lists it until it processes the answer: stay hidden.
      dispatchJobStore.getState().updateProgress('job-1', { pendingPermissions: [PERMISSION] });
      expect(actionableDispatchPermissions('session-1')).toEqual([]);
      // Once the target drops it, the optimistic marker is released.
      dispatchJobStore.getState().updateProgress('job-1', { pendingPermissions: [] });
      expect(dispatchJobStore.getState().answeredPermissionIdsByJobId['job-1']).toBeUndefined();
    });
  });

  describe('cancel', () => {
    it('retries a stop request across transport failures and reports stopping', async () => {
      vi.useFakeTimers();
      registerJob([]);
      mocks.cancel
        .mockRejectedValueOnce(new Error('dispatch cancel timed out'))
        .mockRejectedValueOnce(new Error('dispatch cancel timed out'))
        .mockResolvedValueOnce({ cancelled: true });

      const result = cancelDispatchJob('job-1');
      expect(dispatchJobStore.getState().cancelStateByJobId['job-1']).toBe('stopping');
      await vi.advanceTimersByTimeAsync(
        DISPATCH_CANCEL_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0),
      );
      await expect(result).resolves.toBe(true);
      expect(mocks.cancel).toHaveBeenCalledTimes(3);
      expect(dispatchJobStore.getState().cancelStateByJobId['job-1']).toBe('stopping');

      // The target's terminal state ends the stopping window.
      dispatchJobStore.getState().updateProgress('job-1', { state: 'cancelled' });
      expect(dispatchJobStore.getState().cancelStateByJobId['job-1']).toBeUndefined();
    });

    it('reports an unconfirmed stop when every attempt fails', async () => {
      vi.useFakeTimers();
      registerJob([]);
      mocks.cancel.mockRejectedValue(new Error('SSH target is offline'));

      const result = cancelDispatchJob('job-1');
      const settled = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(
        DISPATCH_CANCEL_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0),
      );
      await settled;
      expect(mocks.cancel).toHaveBeenCalledTimes(DISPATCH_CANCEL_RETRY_DELAYS_MS.length + 1);
      expect(dispatchJobStore.getState().cancelStateByJobId['job-1']).toBe('unconfirmed');

      // A later successful attempt (the retry action) replaces the outcome.
      mocks.cancel.mockResolvedValueOnce({ cancelled: true });
      await expect(cancelDispatchJob('job-1')).resolves.toBe(true);
      expect(dispatchJobStore.getState().cancelStateByJobId['job-1']).toBe('stopping');
    });

    it('does not retry once the job is already terminal', async () => {
      registerJob([]);
      dispatchJobStore.getState().updateProgress('job-1', { state: 'succeeded' });
      await expect(cancelDispatchJob('job-1')).resolves.toBe(false);
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(dispatchJobStore.getState().cancelStateByJobId['job-1']).toBeUndefined();
    });
  });
});
