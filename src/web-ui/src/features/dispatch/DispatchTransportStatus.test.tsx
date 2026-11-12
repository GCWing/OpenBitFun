// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchJobStore } from './dispatchJobStore';
import { DispatchTransportStatus } from './DispatchTransportStatus';
import { resolveDispatchTransportStatus } from './useDispatchTransportStatus';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  cancelSessionTask: vi.fn(),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options ? `${key} ${JSON.stringify(options)}` : key
    ),
    formatRelativeTime: (value: number) => `at:${value}`,
  }),
}));

vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({ cancelSessionTask: mocks.cancelSessionTask }),
  },
}));

function registerJob(
  state: 'running' | 'submission_unknown' | 'succeeded' = 'running',
  pendingPermissions: Array<Record<string, unknown>> = [],
): void {
  dispatchJobStore.getState().registerJob({
    jobId: 'job-1',
    sessionId: 'session-1',
    targetRequest: { kind: 'ssh', connectionId: 'ssh-1', workspacePath: '/repo' },
    target: { kind: 'ssh', connectionId: 'ssh-1', workspacePath: '/repo', displayName: 'build-host' },
    title: 'Dispatch test',
    agentType: 'Standard',
    approvalPolicy: 'remote',
    cursor: 0,
    state,
    appliedEventIds: [],
    pendingPermissions,
    eventLogComplete: true,
    historyTruncated: false,
    omittedEventCount: 0,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe('dispatch transport status', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dispatchJobStore.getState().clear();
    mocks.cancelSessionTask.mockReset().mockResolvedValue(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says nothing while the target answers', () => {
    registerJob();
    dispatchJobStore.getState().setTransportState('job-1', 'reachable');
    expect(resolveDispatchTransportStatus('job-1')).toBeNull();
    expect(resolveDispatchTransportStatus(undefined)).toBeNull();
  });

  it('marks restored prompts as waiting for the target until a read confirms them', () => {
    registerJob('running', [{ requestId: 'approval-1' }]);
    expect(resolveDispatchTransportStatus('job-1')).toMatchObject({
      kind: 'awaitingConfirmation',
      unconfirmedPermissionCount: 1,
    });
    dispatchJobStore.getState().setTransportState('job-1', 'reachable');
    expect(resolveDispatchTransportStatus('job-1')).toBeNull();
    dispatchJobStore.getState().markPermissionsAnswered('job-1', ['approval-1']);
    expect(resolveDispatchTransportStatus('job-1')).toMatchObject({ kind: 'answerSent' });
  });

  it('distinguishes a job the target never received from an unreachable target', () => {
    registerJob('submission_unknown');
    dispatchJobStore.getState().setTransportState('job-1', 'notFound', '[dispatch_job_not_found]');
    expect(resolveDispatchTransportStatus('job-1')).toMatchObject({ kind: 'notDelivered' });
    dispatchJobStore.getState().updateProgress('job-1', { state: 'running' });
    expect(resolveDispatchTransportStatus('job-1')).toMatchObject({ kind: 'missingOnTarget' });
    dispatchJobStore.getState().setTransportState('job-1', 'unreachable', 'offline');
    expect(resolveDispatchTransportStatus('job-1')).toMatchObject({ kind: 'unreachable' });
  });

  it('renders the unreachable state with the time of the last update', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    registerJob();
    dispatchJobStore.getState().setTransportState('job-1', 'reachable');
    dispatchJobStore.getState().setTransportState('job-1', 'unreachable', 'SSH target is offline');
    act(() => root.render(<DispatchTransportStatus jobId="job-1" />));
    const pill = container.querySelector('[data-testid="dispatch-transport-status"]');
    expect(pill?.getAttribute('data-dispatch-transport')).toBe('unreachable');
    expect(pill?.textContent).toBe(
      'chatInput.dispatch.transport.unreachableSince {"time":"at:5000"}',
    );
    vi.restoreAllMocks();

    act(() => dispatchJobStore.getState().setTransportState('job-1', 'reachable'));
    expect(container.querySelector('[data-testid="dispatch-transport-status"]')).toBeNull();
  });

  it('shows an unconfirmed stop with a retry that goes through the session cancel path', async () => {
    registerJob();
    dispatchJobStore.getState().setTransportState('job-1', 'reachable');
    dispatchJobStore.getState().setCancelState('job-1', 'stopping');
    act(() => root.render(<DispatchTransportStatus jobId="job-1" />));
    expect(container.textContent).toContain('chatInput.dispatch.transport.stopping');

    act(() => dispatchJobStore.getState().setCancelState('job-1', 'unconfirmed'));
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="dispatch-transport-retry-stop"]',
    );
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.cancelSessionTask).toHaveBeenCalledWith('session-1');

    act(() => dispatchJobStore.getState().updateProgress('job-1', { state: 'cancelled' }));
    expect(container.querySelector('[data-testid="dispatch-transport-status"]')).toBeNull();
  });
});
