// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PermissionRequestEvent,
  PermissionRequest,
} from '@/infrastructure/api/service-api/AgentAPI';
import { dispatchJobStore } from '@/features/dispatch/dispatchJobStore';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import {
  liveSessionInteractionStore,
  resetLiveSessionInteractionStoreForTest,
} from '../../services/liveSessionInteractionStore';
import { usePermissionRequests } from './usePermissionRequests';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agentApiMock = vi.hoisted(() => ({
  listener: null as ((event: PermissionRequestEvent) => void) | null,
  unlisten: vi.fn(),
  subscribePermissionRequests: vi.fn(() => Promise.resolve()),
  listPendingPermissionRequests: vi.fn(() => Promise.resolve([] as PermissionRequest[])),
  respondPermission: vi.fn(() => Promise.resolve()),
  respondPermissionBatch: vi.fn(() => Promise.resolve([] as string[])),
}));
const dispatchApiMock = vi.hoisted(() => ({
  answerPermission: vi.fn(() => Promise.resolve({ resolved: true })),
  requestRefresh: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    onPermissionRequestEvent: (listener: (event: PermissionRequestEvent) => void) => {
      agentApiMock.listener = listener;
      return agentApiMock.unlisten;
    },
    subscribePermissionRequests: agentApiMock.subscribePermissionRequests,
    listPendingPermissionRequests: agentApiMock.listPendingPermissionRequests,
    respondPermission: agentApiMock.respondPermission,
    respondPermissionBatch: agentApiMock.respondPermissionBatch,
  },
}));
vi.mock('@/features/dispatch/dispatchApi', () => ({
  dispatchApi: {
    answerPermission: dispatchApiMock.answerPermission,
  },
}));
vi.mock('@/features/dispatch/DispatchJobObserver', () => ({
  requestDispatchJobRefresh: dispatchApiMock.requestRefresh,
}));

type PermissionController = ReturnType<typeof usePermissionRequests>;

function request(
  requestId: string,
  sessionId: string,
  parentSessionId?: string,
): PermissionRequest {
  return {
    requestId,
    roundId: parentSessionId ? 'round-child' : 'round-parent',
    order: requestId.endsWith('b') ? 1 : 0,
    sessionId,
    toolCallId: `${requestId}-tool`,
    projectId: 'project-1',
    agentId: parentSessionId ? 'Explore' : 'Standard',
    action: 'edit',
    resources: ['src/main.rs'],
    source: { kind: 'tool_call', identity: 'Write' },
    delegation: parentSessionId
      ? {
          parentSessionId,
          parentDialogTurnId: 'parent-turn',
          parentToolCallId: `${requestId}-parent-task`,
          subagentType: 'Explore',
        }
      : undefined,
  };
}

function Harness({
  sessionId,
  dispatchJobId,
  onController,
}: {
  sessionId?: string;
  dispatchJobId?: string;
  onController: (controller: PermissionController) => void;
}) {
  const controller = usePermissionRequests(sessionId, dispatchJobId);
  onController(controller);
  return <div data-request-count={controller.requests.length} />;
}

async function renderHarness(
  root: Root,
  sessionId: string | undefined,
  onController: (controller: PermissionController) => void,
  dispatchJobId?: string,
) {
  await act(async () => {
    root.render(
      <Harness
        sessionId={sessionId}
        dispatchJobId={dispatchJobId}
        onController={onController}
      />,
    );
    await Promise.resolve();
  });
}

function emit(event: PermissionRequestEvent) {
  act(() => {
    liveSessionInteractionStore.applyPermissionEvent(getActiveSurfaceId(), event);
  });
}

describe('usePermissionRequests', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: PermissionController | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    controller = null;
    agentApiMock.listener = null;
    agentApiMock.unlisten.mockReset();
    agentApiMock.subscribePermissionRequests.mockReset();
    agentApiMock.subscribePermissionRequests.mockResolvedValue(undefined);
    agentApiMock.listPendingPermissionRequests.mockReset();
    agentApiMock.listPendingPermissionRequests.mockResolvedValue([]);
    agentApiMock.respondPermission.mockReset();
    agentApiMock.respondPermission.mockResolvedValue(undefined);
    agentApiMock.respondPermissionBatch.mockReset();
    agentApiMock.respondPermissionBatch.mockResolvedValue([]);
    dispatchApiMock.answerPermission.mockReset();
    dispatchApiMock.answerPermission.mockResolvedValue({ resolved: true });
    dispatchApiMock.requestRefresh.mockReset();
    dispatchJobStore.getState().clear();
    resetLiveSessionInteractionStoreForTest();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('routes parallel child requests to the parent and isolates session switches', async () => {
    await renderHarness(root, 'parent-session', (next) => {
      controller = next;
    });

    const childA = request('child-a', 'child-session-a', 'parent-session');
    const childB = request('child-b', 'child-session-b', 'parent-session');
    const unrelated = request('unrelated', 'other-session');
    emit({ event: 'asked', request: childA });
    emit({ event: 'asked', request: childB });
    emit({ event: 'asked', request: unrelated });

    expect(controller?.requests.map((item) => item.requestId)).toEqual(['child-a', 'child-b']);
    expect(controller?.ownedRequests.map((item) => item.requestId)).toEqual(['child-a', 'child-b']);

    emit({ event: 'asked', request: { ...childA, resources: ['src/lib.rs'] } });
    expect(controller?.requests).toHaveLength(2);
    expect(controller?.requests[0].resources).toEqual(['src/lib.rs']);

    await renderHarness(root, 'other-session', (next) => {
      controller = next;
    });
    expect(controller?.requests.map((item) => item.requestId)).toEqual(['unrelated']);

    await renderHarness(root, 'parent-session', (next) => {
      controller = next;
    });
    emit({
      event: 'replied',
      requestId: childA.requestId,
      reply: { reply: 'once' },
      source: 'user',
    });
    emit({ event: 'cancelled', requestId: childB.requestId, reason: 'parent cancelled' });
    expect(controller?.requests).toEqual([]);
  });

  it('keeps delegated requests actionable only from the parent surface', async () => {
    const child = request('delegated-child', 'child-session', 'parent-session');

    await renderHarness(root, 'child-session', (next) => {
      controller = next;
    });
    emit({ event: 'asked', request: child });

    expect(controller?.requests.map((item) => item.requestId)).toEqual(['delegated-child']);
    expect(controller?.ownedRequests).toEqual([]);
    expect(controller?.ownedActiveBatch).toBeUndefined();

    await renderHarness(root, 'parent-session', (next) => {
      controller = next;
    });
    expect(controller?.ownedRequests.map((item) => item.requestId)).toEqual(['delegated-child']);
    expect(controller?.ownedActiveBatch?.requests.map((item) => item.requestId)).toEqual([
      'delegated-child',
    ]);
  });

  it('removes a request only after a successful explicit response', async () => {
    await renderHarness(root, 'session-1', (next) => {
      controller = next;
    });
    const direct = request('direct', 'session-1');
    emit({ event: 'asked', request: direct });

    await act(async () => {
      await controller?.respond(direct.requestId, 'reject', 'Use a read-only path');
    });

    expect(agentApiMock.respondPermission).toHaveBeenCalledWith(
      direct.requestId,
      'reject',
      'Use a read-only path',
    );
    expect(controller?.requests).toEqual([]);
  });

  it('does not restore a resolved request from a stale pending snapshot', async () => {
    let resolvePending: (requests: PermissionRequest[]) => void = () => undefined;
    agentApiMock.listPendingPermissionRequests.mockImplementation(
      () => new Promise((resolve) => {
        resolvePending = resolve;
      }),
    );

    await renderHarness(root, 'parent-session', (next) => {
      controller = next;
    });
    const child = request('auto-resolved', 'child-session', 'parent-session');
    emit({
      event: 'replied',
      requestId: child.requestId,
      reply: { reply: 'once' },
      source: 'auto_approve',
    });

    await act(async () => {
      resolvePending([child]);
      await Promise.resolve();
    });

    expect(controller?.requests).toEqual([]);
  });

  it('removes all backend-resolved requests after one batch response', async () => {
    await renderHarness(root, 'session-1', (next) => {
      controller = next;
    });
    const first = request('first', 'session-1');
    const second = { ...request('second', 'session-1'), order: 1 };
    const later = { ...request('later', 'session-1'), roundId: 'later-round' };
    emit({ event: 'asked', request: first });
    emit({ event: 'asked', request: second });
    emit({ event: 'asked', request: later });
    agentApiMock.respondPermissionBatch.mockResolvedValue(['first', 'second']);

    await act(async () => {
      await controller?.respondBatch('first', 'once');
    });

    expect(agentApiMock.respondPermissionBatch).toHaveBeenCalledWith('first', 'once', undefined);
    expect(controller?.requests.map((item) => item.requestId)).toEqual(['later']);
  });

  it('keeps pending requests when a batch response fails', async () => {
    await renderHarness(root, 'session-1', (next) => {
      controller = next;
    });
    const first = request('first', 'session-1');
    emit({ event: 'asked', request: first });
    agentApiMock.respondPermissionBatch.mockRejectedValue(new Error('offline'));

    await act(async () => {
      await expect(controller?.respondBatch('first', 'reject')).rejects.toThrow('offline');
    });

    expect(controller?.requests.map((item) => item.requestId)).toEqual(['first']);
  });

  it('answers every request in the active remote dispatch batch', async () => {
    const first = request('first', 'session-1');
    const second = { ...request('second', 'session-1'), order: 1 };
    const later = { ...request('later', 'session-1'), roundId: 'later-round' };
    dispatchJobStore.getState().registerJob({
      jobId: 'job-1',
      sessionId: 'session-1',
      targetRequest: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/repo',
      },
      target: {
        kind: 'ssh',
        connectionId: 'ssh-1',
        workspacePath: '/repo',
        displayName: 'build-host',
      },
      title: 'Remote task',
      agentType: 'Standard',
      approvalPolicy: 'remote',
      cursor: 0,
      state: 'running',
      appliedEventIds: [],
      pendingPermissions: [first, second, later] as unknown as Array<Record<string, unknown>>,
      eventLogComplete: true,
      historyTruncated: false,
      omittedEventCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    // Prompts are actionable only after a status read confirms them.
    dispatchJobStore.getState().setTransportState('job-1', 'reachable');
    await renderHarness(root, 'session-1', (next) => {
      controller = next;
    }, 'job-1');

    await act(async () => {
      await controller?.respondBatch('first', 'once');
    });

    expect(dispatchApiMock.answerPermission.mock.calls).toEqual([
      ['job-1', 'first', 'once', undefined],
      ['job-1', 'second', 'once', undefined],
    ]);
    expect(dispatchApiMock.requestRefresh).toHaveBeenCalledWith('job-1');
  });
});
