// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { BtwSessionPanel } from './BtwSessionPanel';
import { useReviewActionBarStore } from '../../store/deepReviewActionBarStore';
import { loadPersistedReviewState } from '../../services/ReviewActionBarPersistenceService';
import type { FlowChatState, Session } from '../../types/flow-chat';
import type { PermissionRequest } from '@/infrastructure/api/service-api/AgentAPI';

const panelMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(),
  cancelSessionTask: vi.fn(),
  hydrateSessionHistoryForDetail: vi.fn(),
  notificationError: vi.fn(),
  permissionRequests: [] as PermissionRequest[],
  ownedPermissionRequests: [] as PermissionRequest[],
  ownedActivePermissionBatch: undefined as {
    sessionId: string;
    roundId: string;
    requests: PermissionRequest[];
  } | undefined,
  respondPermission: vi.fn(() => Promise.resolve()),
  respondPermissionBatch: vi.fn(() => Promise.resolve()),
  virtualItems: [] as unknown[],
  flowChatSubscriber: null as ((state: FlowChatState) => void) | null,
  flowChatSelectorSubscribers: new Set<(state: FlowChatState) => void>(),
}));

let flowChatState: FlowChatState;
const translate = (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
  options?.defaultValue ?? _key
);

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: translate,
  }),
}));

vi.mock('../modern/VirtualItemRenderer', async () => {
  const ReactModule = await import('react');
  const { useFlowChatContext } = await import('../modern/FlowChatContext');
  return {
    VirtualItemRenderer: () => {
      const { allowTranscriptExport } = useFlowChatContext();
      return ReactModule.createElement('div', {
        'data-testid': 'virtual-item-renderer',
        'data-allow-transcript-export': String(allowTranscriptExport),
      });
    },
  };
});

// Action-bar tests exercise context and review behavior independently of DOM
// viewport geometry. The real windowing contract has its own integration test.
vi.mock('./BtwVirtualSessionList', async () => {
  const { VirtualItemRenderer } = await import('../modern/VirtualItemRenderer');
  return {
    BtwVirtualSessionList: ({ items }: { items: import('../../store/modernFlowChatStore').VirtualItem[] }) => (
      <>{items.map((item, index) => <VirtualItemRenderer key={index} item={item} index={index} />)}</>
    ),
  };
});

vi.mock('../modern/useExploreGroupState', () => ({
  useExploreGroupState: () => ({
    exploreGroupStates: {},
    onExploreGroupToggle: vi.fn(),
    onExpandGroup: vi.fn(),
    onExpandAllInTurn: vi.fn(),
    onCollapseGroup: vi.fn(),
  }),
}));

vi.mock('../modern/usePermissionRequests', () => ({
  usePermissionRequests: () => ({
    requests: panelMocks.permissionRequests,
    activeBatch: undefined,
    ownedRequests: panelMocks.ownedPermissionRequests,
    ownedActiveBatch: panelMocks.ownedActivePermissionBatch,
    respond: panelMocks.respondPermission,
    respondBatch: panelMocks.respondPermissionBatch,
  }),
}));

vi.mock('../ChatInputApprovalBand', () => ({
  ChatInputApprovalBand: ({
    requests,
    totalPendingCount,
    onRespond,
  }: {
    requests: PermissionRequest[];
    totalPendingCount: number;
    onRespond: (requestId: string, reply: 'once') => Promise<void>;
  }) => (
    <button
      type="button"
      data-testid="child-permission-approval"
      data-request-ids={requests.map((request) => request.requestId).join(',')}
      data-total-pending={totalPendingCount}
      onClick={() => void onRespond(requests[0].requestId, 'once')}
    />
  ),
}));

vi.mock('@/flow_chat', () => ({
  ScrollToBottomButton: () => <div />,
}));

vi.mock('./DeepReviewActionBar', () => ({
  ReviewActionBar: () => <div data-testid="review-action-bar" />,
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  IconButton: ({
    children,
    onClick,
    disabled,
    className,
    icon,
    'data-testid': testId,
    'aria-label': ariaLabel,
  }: {
    children?: React.ReactNode;
    icon?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
    'data-testid'?: string;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {icon}
      {children}
    </button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/shared/services/FileTabManager', () => ({
  fileTabManager: {
    openFile: vi.fn(),
  },
}));

vi.mock('@/shared/utils/tabUtils', () => ({
  createTab: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({
  agentAPI: {
    cancelSession: (...args: unknown[]) => panelMocks.cancelSession(...args),
  },
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: {
    emit: vi.fn(),
  },
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    error: (...args: unknown[]) => panelMocks.notificationError(...args),
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../../store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => ({
      getState: () => flowChatState,
      subscribe: () => () => {},
    }),
  },
  flowChatStore: {
    getState: () => flowChatState,
    subscribeSelector: <T,>(select: (state: FlowChatState) => T, notify: (selected: T) => void) => {
      let previous = select(flowChatState);
      const listener = (state: FlowChatState) => {
        const next = select(state);
        if (Object.is(previous, next)) return;
        previous = next;
        notify(next);
      };
      panelMocks.flowChatSelectorSubscribers.add(listener);
      panelMocks.flowChatSubscriber = state => {
        panelMocks.flowChatSelectorSubscribers.forEach(subscriber => subscriber(state));
      };
      return () => { panelMocks.flowChatSelectorSubscribers.delete(listener); };
    },
    subscribe: (listener: (state: FlowChatState) => void) => {
      panelMocks.flowChatSubscriber = listener;
      return () => {
        if (panelMocks.flowChatSubscriber === listener) {
          panelMocks.flowChatSubscriber = null;
        }
      };
    },
  },
}));

vi.mock('../../services/FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({
      cancelSessionTask: (...args: unknown[]) => panelMocks.cancelSessionTask(...args),
    }),
  },
  flowChatManager: {
    hydrateSessionHistoryForDetail: (...args: unknown[]) =>
      panelMocks.hydrateSessionHistoryForDetail(...args),
  },
}));

vi.mock('../../store/modernFlowChatStore', () => ({
  sessionToVirtualItems: () => panelMocks.virtualItems,
}));

vi.mock('../../services/ReviewActionBarPersistenceService', () => ({
  loadPersistedReviewState: vi.fn(() => Promise.resolve(null)),
  persistReviewActionState: vi.fn(() => Promise.resolve()),
}));

function createReviewSession(): Session {
  return {
    sessionId: 'deep-review-child',
    title: 'Deep review',
    dialogTurns: [{
      id: 'turn-1',
      sessionId: 'deep-review-child',
      userMessage: { id: 'user-1', content: 'review', timestamp: 1 },
      modelRounds: [{
        id: 'round-1',
        index: 0,
        isStreaming: false,
        isComplete: true,
        status: 'completed',
        startTime: 1,
        items: [{
          id: 'review-result',
          type: 'tool',
          timestamp: 2,
          status: 'completed',
          toolName: 'submit_code_review',
          toolCall: { id: 'tool-1', input: {} },
          toolResult: {
            success: true,
            result: JSON.stringify({
              summary: {
                overall_assessment: 'Looks safe.',
                risk_level: 'low',
                recommended_action: 'approve',
              },
              issues: [],
              positive_points: ['No risky changes found.'],
              review_mode: 'deep',
              remediation_plan: [],
            }),
          },
        }],
      }],
      status: 'completed',
      startTime: 1,
    }],
    status: 'idle',
    workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    sessionKind: 'deep_review',
    parentSessionId: 'parent-session',
    workspacePath: 'D:/workspace/project',
  } as Session;
}

function createEmptyReviewCheckSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'review-check-child',
    title: 'Internal reviewer title',
    dialogTurns: [],
    status: 'idle',
    workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    sessionKind: 'subagent',
    parentSessionId: 'parent-session',
    workspacePath: 'D:/workspace/project',
    historyState: 'ready',
    ...overrides,
  } as Session;
}

function createCompletedDeepReviewWithoutResult(): Session {
  const childSession = createReviewSession();
  return {
    ...childSession,
    dialogTurns: childSession.dialogTurns.map((turn) => ({
      ...turn,
      modelRounds: turn.modelRounds.map((round) => ({
        ...round,
        items: [{
          id: 'reviewer-task',
          type: 'tool',
          timestamp: 2,
          status: 'completed',
          toolName: 'Task',
          toolCall: {
            id: 'task-security',
            input: { subagent_type: 'ReviewSecurity' },
          },
          toolResult: {
            success: true,
            result: {
              summary: {
                overall_assessment: 'Security reviewer found no blockers.',
              },
            },
          },
        }],
      })),
    })),
  } as Session;
}

function createInterruptedDeepReviewWithoutResult(): Session {
  const childSession = createCompletedDeepReviewWithoutResult();
  return {
    ...childSession,
    status: 'error',
    error: 'previous execution failed',
    dialogTurns: childSession.dialogTurns.map((turn) => ({
      ...turn,
      status: 'error',
      error: 'previous execution failed',
    })),
  } as Session;
}

function createTerminalStandardReviewWithoutResult(status: 'error' | 'cancelled'): Session {
  const childSession = createCompletedDeepReviewWithoutResult();
  return {
    ...childSession,
    title: 'Review',
    sessionKind: 'review',
    status: status === 'error' ? 'error' : 'idle',
    error: status === 'error' ? 'provider failed' : null,
    dialogTurns: childSession.dialogTurns.map((turn) => ({
      ...turn,
      status,
      error: status === 'error' ? 'provider failed' : undefined,
      modelRounds: turn.modelRounds.map((round) => ({
        ...round,
        items: [],
      })),
    })),
  } as Session;
}

function createRunningDeepReviewSession(): Session {
  const childSession = createCompletedDeepReviewWithoutResult();
  return {
    ...childSession,
    status: 'running',
    dialogTurns: childSession.dialogTurns.map((turn) => ({
      ...turn,
      status: 'processing',
      modelRounds: turn.modelRounds.map((round) => ({
        ...round,
        isStreaming: true,
        isComplete: false,
        status: 'streaming',
      })),
    })),
  } as Session;
}

function createPendingDeepReviewSession(): Session {
  const childSession = createRunningDeepReviewSession();
  return {
    ...childSession,
    dialogTurns: childSession.dialogTurns.map((turn) => ({
      ...turn,
      status: 'pending',
    })),
  } as Session;
}

function createRunningBtwSession(): Session {
  return {
    sessionId: 'btw-child',
    title: 'Side question',
    dialogTurns: [{
      id: 'btw-turn-1',
      sessionId: 'btw-child',
      userMessage: { id: 'btw-user-1', content: 'question', timestamp: 1 },
      modelRounds: [],
      status: 'processing',
      startTime: 1,
    }],
    status: 'running',
    workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    sessionKind: 'btw',
    parentSessionId: 'parent-session',
    workspacePath: 'D:/workspace/project',
  } as Session;
}

function createParentSessionWithId(sessionId: string): Session {
  return {
    sessionId,
    title: sessionId,
    dialogTurns: [],
    status: 'idle',
    workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
  } as Session;
}

function cloneReviewSessionWithId(
  session: Session,
  sessionId: string,
  parentSessionId: string,
): Session {
  return {
    ...session,
    sessionId,
    parentSessionId,
    title: sessionId,
    dialogTurns: session.dialogTurns.map((turn, turnIndex) => ({
      ...turn,
      id: `${sessionId}-turn-${turnIndex + 1}`,
      sessionId,
      userMessage: turn.userMessage
        ? {
            ...turn.userMessage,
            id: `${sessionId}-user-${turnIndex + 1}`,
          }
        : undefined,
      modelRounds: turn.modelRounds.map((round, roundIndex) => ({
        ...round,
        id: `${sessionId}-round-${turnIndex + 1}-${roundIndex + 1}`,
        items: round.items.map((item, itemIndex) => ({
          ...item,
          id: `${sessionId}-item-${turnIndex + 1}-${roundIndex + 1}-${itemIndex + 1}`,
        })),
      })),
    })),
  } as Session;
}

function createCancelledResumeDeepReview(): Session {
  const childSession = createInterruptedDeepReviewWithoutResult();
  return {
    ...childSession,
    status: 'idle',
    error: null,
    dialogTurns: [
      ...childSession.dialogTurns,
      {
        id: 'turn-2',
        sessionId: 'deep-review-child',
        userMessage: {
          id: 'user-2',
          content: 'Continue interrupted Deep Review',
          timestamp: 2,
        },
        modelRounds: [],
        status: 'cancelled',
        startTime: 2,
        timestamp: 2,
      },
    ],
  } as Session;
}

function createCompletedResumeDeepReview(): Session {
  const childSession = createReviewSession();
  return {
    ...childSession,
    dialogTurns: [
      createInterruptedDeepReviewWithoutResult().dialogTurns[0],
      {
        ...childSession.dialogTurns[0],
        id: 'turn-2',
        userMessage: {
          id: 'user-2',
          content: 'Continue interrupted Deep Review',
          timestamp: 2,
        },
        startTime: 2,
        timestamp: 2,
      },
    ],
  } as Session;
}

function createCancelledFixDeepReview(): Session {
  const childSession = createReviewSession();
  return {
    ...childSession,
    status: 'idle',
    error: null,
    dialogTurns: [
      ...childSession.dialogTurns,
      {
        id: 'fix-turn-1',
        sessionId: 'deep-review-child',
        userMessage: {
          id: 'fix-user-1',
          content: 'Fix review findings',
          timestamp: 3,
        },
        modelRounds: [],
        status: 'cancelled',
        startTime: 3,
        timestamp: 3,
      },
    ],
  } as Session;
}

describe('BtwSessionPanel review action bar integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useReviewActionBarStore.getState().reset();
    panelMocks.cancelSession.mockReset();
    panelMocks.cancelSessionTask.mockReset();
    panelMocks.cancelSessionTask.mockResolvedValue(true);
    panelMocks.hydrateSessionHistoryForDetail.mockReset();
    panelMocks.hydrateSessionHistoryForDetail.mockResolvedValue(undefined);
    panelMocks.notificationError.mockReset();
    panelMocks.permissionRequests = [];
    panelMocks.ownedPermissionRequests = [];
    panelMocks.ownedActivePermissionBatch = undefined;
    panelMocks.respondPermission.mockReset();
    panelMocks.respondPermission.mockResolvedValue(undefined);
    panelMocks.respondPermissionBatch.mockReset();
    panelMocks.respondPermissionBatch.mockResolvedValue(undefined);
    panelMocks.virtualItems = [];
    panelMocks.flowChatSubscriber = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const childSession = createReviewSession();
    flowChatState = {
      sessions: new Map([
        ['deep-review-child', childSession],
        ['parent-session', {
          sessionId: 'parent-session',
          title: 'Parent',
          dialogTurns: [],
          status: 'idle',
          workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
          createdAt: 1,
          lastActiveAt: 1,
          error: null,
        } as Session],
      ]),
      activeSessionId: 'deep-review-child',
    } as FlowChatState;

    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useReviewActionBarStore.getState().reset();
    vi.useRealTimers();
  });

  it('unmounts hidden content and subscriptions without cancelling the task', async () => {
    const render = async (isActive: boolean) => {
      await act(async () => {
        root.render(<BtwSessionPanel childSessionId="deep-review-child" parentSessionId="parent-session" isActive={isActive} />);
      });
    };
    await render(true);
    expect(container.querySelector('.btw-session-panel')).not.toBeNull();
    expect(panelMocks.flowChatSelectorSubscribers.size).toBeGreaterThan(0);
    await render(false);
    expect(container.childElementCount).toBe(0);
    expect(panelMocks.flowChatSelectorSubscribers.size).toBe(0);
    const child = flowChatState.sessions.get('deep-review-child')!;
    flowChatState = {
      ...flowChatState,
      sessions: new Map(flowChatState.sessions).set(child.sessionId, { ...child, title: 'Updated while hidden' }),
    };
    await render(true);
    expect(container.textContent).toContain('Updated while hidden');
    expect(panelMocks.flowChatSelectorSubscribers.size).toBeGreaterThan(0);
    expect(panelMocks.cancelSession).not.toHaveBeenCalled();
    expect(panelMocks.cancelSessionTask).not.toHaveBeenCalled();
  });

  it('does not restore stale persisted review state again after tab switching', async () => {
    vi.mocked(loadPersistedReviewState).mockClear();
    vi.mocked(loadPersistedReviewState).mockResolvedValue(null);
    await act(async () => {
      root.render(<BtwSessionPanel childSessionId="deep-review-child" parentSessionId="parent-session" />);
    });
    expect(loadPersistedReviewState).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(<BtwSessionPanel childSessionId="deep-review-child" parentSessionId="parent-session" isActive={false} />);
    });
    await act(async () => {
      root.render(<BtwSessionPanel childSessionId="deep-review-child" parentSessionId="parent-session" />);
    });
    expect(loadPersistedReviewState).toHaveBeenCalledTimes(1);
  });

  it('cancels a running side question with Escape inside its panel', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['btw-child', createRunningBtwSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
      activeSessionId: 'parent-session',
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="btw-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    const panelBody = container.querySelector<HTMLElement>('.btw-session-panel__body');
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      panelBody?.dispatchEvent(escape);
      await Promise.resolve();
    });

    expect(escape.defaultPrevented).toBe(true);
    expect(panelMocks.cancelSessionTask).toHaveBeenCalledTimes(1);
    expect(panelMocks.cancelSessionTask).toHaveBeenCalledWith('btw-child');
    expect(panelMocks.cancelSession).not.toHaveBeenCalled();
  });

  it('keeps Escape with the IME inside a running side-question panel', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['btw-child', createRunningBtwSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
      activeSessionId: 'parent-session',
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="btw-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    const panelBody = container.querySelector<HTMLElement>('.btw-session-panel__body');
    const imeEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      panelBody?.dispatchEvent(imeEscape);
      await Promise.resolve();
    });

    expect(imeEscape.defaultPrevented).toBe(false);
    expect(panelMocks.cancelSessionTask).not.toHaveBeenCalled();
  });

  it('answers direct child permissions in the embedded panel without claiming delegated ones', async () => {
    const directRequest = {
      requestId: 'direct-child-request',
      roundId: 'direct-child-round',
      order: 0,
      sessionId: 'deep-review-child',
      toolCallId: 'direct-child-tool',
      projectId: 'project-1',
      agentId: 'Standard',
      action: 'edit',
      resources: ['src/main.rs'],
      source: { kind: 'tool_call', identity: 'Write' },
    } as PermissionRequest;
    panelMocks.permissionRequests = [directRequest];
    panelMocks.ownedPermissionRequests = [directRequest];
    panelMocks.ownedActivePermissionBatch = {
      sessionId: directRequest.sessionId,
      roundId: directRequest.roundId,
      requests: [directRequest],
    };

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    const approval = container.querySelector<HTMLButtonElement>(
      '[data-testid="child-permission-approval"]',
    );
    expect(approval?.dataset.requestIds).toBe('direct-child-request');
    expect(approval?.dataset.totalPending).toBe('1');

    await act(async () => {
      approval?.click();
      await Promise.resolve();
    });
    expect(panelMocks.respondPermission).toHaveBeenCalledWith('direct-child-request', 'once');

    panelMocks.permissionRequests = [{
      ...directRequest,
      requestId: 'delegated-child-request',
      delegation: {
        parentSessionId: 'parent-session',
        parentDialogTurnId: 'parent-turn',
        parentToolCallId: 'parent-task',
        subagentType: 'Explore',
      },
    }];
    panelMocks.ownedPermissionRequests = [];
    panelMocks.ownedActivePermissionBatch = undefined;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(container.querySelector('[data-testid="child-permission-approval"]')).toBeNull();
  });

  it('shows the session-mapped subagent avatar in the side-thread header', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;
    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    const avatar = container.querySelector<HTMLElement>(
      '[data-openbitfun-component="subagent-avatar"][data-openbitfun-avatar-id]',
    );
    expect(avatar).toBeTruthy();
    expect(avatar?.hasAttribute('data-openbitfun-name-id')).toBe(false);
    expect(container.querySelector('[data-openbitfun-part="subagentName"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="badge"]')?.textContent).toBe('Agent');
  });

  it('shows a Review-check loading state instead of an empty thread', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          isHistorical: true,
          historyState: 'metadata-only',
        })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    expect(container.textContent).toContain('toolCards.taskTool.reviewCoverageLabel');
    expect(container.textContent).toContain('childSession.reviewDetail.loading');
    expect(container.textContent).not.toContain('session.empty');
  });

  it('does not start a second Review-check history load while hydration is in progress', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          isHistorical: true,
          historyState: 'hydrating',
        })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    expect(panelMocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
    expect(container.textContent).toContain('childSession.reviewDetail.loading');
  });

  it('offers a load-only retry after Review-check history hydration fails', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          isHistorical: true,
          historyState: 'failed',
        })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });
    panelMocks.hydrateSessionHistoryForDetail.mockClear();

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('childSession.reviewDetail.retryLoad'));
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('review-check-child');
    expect(panelMocks.cancelSession).not.toHaveBeenCalled();
  });

  it('uses the child workspace ID when retrying without a path projection', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          workspacePath: undefined,
          isHistorical: true,
          historyState: 'failed',
        })],
        ['parent-session', {
          ...flowChatState.sessions.get('parent-session')!,
          workspacePath: 'D:/workspace/parent',
          remoteConnectionId: 'remote-current',
          remoteSshHost: 'host-current',
        }],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          viewKind="review-check"
        />,
      );
    });

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('childSession.reviewDetail.retryLoad'));
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('review-check-child');
  });

  it('offers a load-only retry when legacy Review-check details are unavailable', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({ historyState: 'ready' })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    expect(container.textContent).toContain('childSession.reviewDetail.unavailable');
    expect(container.textContent).toContain('childSession.reviewDetail.retryLoad');
    expect(panelMocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
  });

  it('uses the parent Task partial-timeout outcome for empty Review-check details', async () => {
    const reviewCheck = createEmptyReviewCheckSession({
      parentToolCallId: 'review-task-call',
      dialogTurns: [{
        id: 'turn-completed',
        sessionId: 'review-check-child',
        userMessage: { id: 'user-completed', content: 'internal launch prompt', timestamp: 1 },
        modelRounds: [],
        status: 'completed',
        startTime: 1,
      }],
    });
    const parentSession = {
      ...flowChatState.sessions.get('parent-session')!,
      dialogTurns: [{
        id: 'parent-turn',
        sessionId: 'parent-session',
        userMessage: { id: 'parent-user', content: 'review', timestamp: 1 },
        modelRounds: [{
          id: 'parent-round',
          index: 0,
          isStreaming: false,
          isComplete: true,
          status: 'completed',
          startTime: 1,
          items: [{
            id: 'review-task',
            type: 'tool',
            timestamp: 1,
            status: 'completed',
            toolName: 'LaunchReviewAgent',
            toolCall: { id: 'review-task-call', input: {} },
            toolResult: {
              success: true,
              result: { status: 'partial_timeout', partial_output: 'private details' },
            },
          }],
        }],
        status: 'completed',
        startTime: 1,
      }],
    } as Session;
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', reviewCheck],
        ['parent-session', parentSession],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
          displayTitle="Checking a specific concern"
        />,
      );
    });

    expect(container.textContent).toContain('childSession.reviewDetail.partialTimedOut');
    expect(container.textContent).toContain('Checking a specific concern');
    expect(container.textContent).not.toContain('Internal reviewer title');
    expect(container.querySelector('[data-testid="btw-session-panel-origin-button"]')).toBeTruthy();
  });

  it('disables transcript export actions for the filtered Review-check projection', async () => {
    panelMocks.virtualItems = [{ type: 'model-round', turnId: 'turn-1' }];
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          dialogTurns: [{
            id: 'turn-1',
            sessionId: 'review-check-child',
            userMessage: { id: 'internal-user', content: 'internal launch prompt', timestamp: 1 },
            modelRounds: [],
            status: 'completed',
            startTime: 1,
          }],
        })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    expect(container.querySelector('[data-testid="virtual-item-renderer"]')
      ?.getAttribute('data-allow-transcript-export')).toBe('false');
  });

  it.each([
    {
      name: 'stopped',
      session: createEmptyReviewCheckSession({
        dialogTurns: [{
          id: 'turn-stopped',
          sessionId: 'review-check-child',
          userMessage: { id: 'user-stopped', content: 'review', timestamp: 1 },
          modelRounds: [],
          status: 'cancelled',
          startTime: 1,
        }],
      }),
      expectedKey: 'childSession.reviewDetail.stopped',
    },
    {
      name: 'interrupted',
      session: createEmptyReviewCheckSession({
        dialogTurns: [{
          id: 'turn-interrupted',
          sessionId: 'review-check-child',
          userMessage: { id: 'user-interrupted', content: 'review', timestamp: 1 },
          modelRounds: [{
            id: 'round-interrupted',
            index: 0,
            isStreaming: false,
            isComplete: true,
            status: 'cancelled',
            startTime: 1,
            items: [{
              id: 'tool-interrupted',
              type: 'tool',
              toolName: 'read_file',
              timestamp: 1,
              status: 'cancelled',
              interruptionReason: 'app_restart',
            }],
          }],
          status: 'cancelled',
          startTime: 1,
        }],
      }),
      expectedKey: 'childSession.reviewDetail.interrupted',
    },
    {
      name: 'timed out',
      session: createEmptyReviewCheckSession({
        dialogTurns: [{
          id: 'turn-timeout',
          sessionId: 'review-check-child',
          userMessage: { id: 'user-timeout', content: 'review', timestamp: 1 },
          modelRounds: [],
          status: 'error',
          startTime: 1,
          errorDetail: { category: 'timeout', rawMessage: 'private timeout detail' },
        }],
      }),
      expectedKey: 'childSession.reviewDetail.timedOut',
    },
    {
      name: 'model access failed',
      session: createEmptyReviewCheckSession({
        dialogTurns: [{
          id: 'turn-failed',
          sessionId: 'review-check-child',
          userMessage: { id: 'user-failed', content: 'review', timestamp: 1 },
          modelRounds: [],
          status: 'error',
          startTime: 1,
          error: 'private provider error',
        }],
      }),
      expectedKey: 'childSession.reviewDetail.failed',
    },
  ])('shows a safe empty state when a Review check is $name', async ({ session, expectedKey }) => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', session],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    expect(container.textContent).toContain(expectedKey);
    expect(container.textContent).not.toContain('private provider error');
    expect(container.textContent).not.toContain('private timeout detail');
    expect(container.textContent).not.toContain('session.empty');
  });

  it('refreshes a stopped Review check only after cancellation is confirmed', async () => {
    let resolveCancel!: (result: { cancelled: boolean; dialogTurnId?: string }) => void;
    const cancelRequest = new Promise<{ cancelled: boolean; dialogTurnId?: string }>((resolve) => {
      resolveCancel = resolve;
    });
    panelMocks.cancelSession.mockReturnValueOnce(cancelRequest);
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          status: 'running',
          dialogTurns: [{
            id: 'turn-running',
            sessionId: 'review-check-child',
            userMessage: { id: 'user-running', content: 'review', timestamp: 1 },
            modelRounds: [],
            status: 'processing',
            startTime: 1,
          }],
        })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    const stopButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="btw-session-panel-stop-review"]',
    );
    expect(stopButton).toBeTruthy();
    expect(stopButton?.getAttribute('aria-label')).toBe('toolCards.taskDetailPanel.stopReviewWork');

    await act(async () => {
      stopButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(panelMocks.cancelSession).toHaveBeenCalledWith('review-check-child');
    expect(panelMocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="btw-session-panel-stop-spinner"]')).toBeTruthy();

    await act(async () => {
      resolveCancel({ cancelled: true, dialogTurnId: 'turn-running' });
      await cancelRequest;
    });

    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('review-check-child');
  });

  it('keeps a Review check running locally when cancellation cannot be confirmed', async () => {
    panelMocks.cancelSession.mockResolvedValueOnce({ cancelled: false, dialogTurnId: null });
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', createEmptyReviewCheckSession({
          status: 'running',
          dialogTurns: [{
            id: 'turn-running',
            sessionId: 'review-check-child',
            userMessage: { id: 'user-running', content: 'review', timestamp: 1 },
            modelRounds: [],
            status: 'processing',
            startTime: 1,
          }],
        })],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    const stopButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="btw-session-panel-stop-review"]',
    );
    expect(stopButton).toBeTruthy();

    await act(async () => {
      stopButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(panelMocks.notificationError).toHaveBeenCalledWith(
      'toolCards.taskDetailPanel.stopReviewWorkFailed',
    );
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('review-check-child');
  });

  it('does not report a stop failure when the check completed before cancellation arrived', async () => {
    panelMocks.cancelSession.mockResolvedValueOnce({ cancelled: false, dialogTurnId: null });
    const runningChild = createEmptyReviewCheckSession({
      status: 'running',
      dialogTurns: [{
        id: 'turn-running',
        sessionId: 'review-check-child',
        userMessage: { id: 'user-running', content: 'review', timestamp: 1 },
        modelRounds: [],
        status: 'processing',
        startTime: 1,
      }],
    });
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['review-check-child', runningChild],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;
    panelMocks.hydrateSessionHistoryForDetail.mockImplementationOnce(async () => {
      flowChatState = {
        ...flowChatState,
        sessions: new Map(flowChatState.sessions).set('review-check-child', {
          ...runningChild,
          dialogTurns: [{
            ...runningChild.dialogTurns[0],
            status: 'completed',
            endTime: 2,
          }],
        }),
      } as FlowChatState;
    });

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="review-check-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
          viewKind="review-check"
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="btw-session-panel-stop-review"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('review-check-child');
    expect(panelMocks.notificationError).not.toHaveBeenCalled();
  });

  it('shows the completed Deep Review action bar even when the report has no remediation items', async () => {
    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_completed',
    });
    expect(useReviewActionBarStore.getState().remediationItems).toEqual([]);
  });

  it('shows the running review action as minimized while Deep Review is still processing', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createRunningDeepReviewSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_running',
      minimized: true,
    });
  });

  it('shows the running review action as minimized while Deep Review is pending', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createPendingDeepReviewSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_running',
      minimized: true,
    });
  });

  it.each(['error', 'cancelled'] as const)(
    'settles a standard Review action when the turn ends as %s without a report',
    async (status) => {
      const store = useReviewActionBarStore.getState();
      store.showRunningActionBar({
        childSessionId: 'deep-review-child',
        parentSessionId: 'parent-session',
        reviewMode: 'standard',
      });
      flowChatState = {
        ...flowChatState,
        sessions: new Map([
          ['deep-review-child', createTerminalStandardReviewWithoutResult(status)],
          ['parent-session', flowChatState.sessions.get('parent-session')!],
        ]),
      } as FlowChatState;

      await act(async () => {
        root.render(
          <BtwSessionPanel
            childSessionId="deep-review-child"
            parentSessionId="parent-session"
            workspacePath="D:/workspace/project"
          />,
        );
      });

      expect(useReviewActionBarStore.getState()).toMatchObject({
        childSessionId: 'deep-review-child',
        phase: 'review_error',
        minimized: false,
      });
    },
  );

  it('keeps minimized running review action bars isolated across simultaneous reviews', async () => {
    const firstParent = createParentSessionWithId('parent-session-1');
    const secondParent = createParentSessionWithId('parent-session-2');
    const firstChild = cloneReviewSessionWithId(
      createRunningDeepReviewSession(),
      'deep-review-child-1',
      firstParent.sessionId,
    );
    const secondChild = cloneReviewSessionWithId(
      createRunningDeepReviewSession(),
      'deep-review-child-2',
      secondParent.sessionId,
    );

    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        [firstParent.sessionId, firstParent],
        [secondParent.sessionId, secondParent],
        [firstChild.sessionId, firstChild],
        [secondChild.sessionId, secondChild],
      ]),
      activeSessionId: firstChild.sessionId,
    } as FlowChatState;

    await act(async () => {
      root.render(
        <>
          <BtwSessionPanel
            childSessionId={firstChild.sessionId}
            parentSessionId={firstParent.sessionId}
            workspacePath="D:/workspace/project"
          />
          <BtwSessionPanel
            childSessionId={secondChild.sessionId}
            parentSessionId={secondParent.sessionId}
            workspacePath="D:/workspace/project"
          />
        </>,
      );
    });

    expect(container.querySelectorAll('.btw-session-panel__minimized-button')).toHaveLength(2);
  });

  it('keeps bottom breathing room when the review action is minimized', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createRunningDeepReviewSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    const body = container.querySelector<HTMLElement>('.btw-session-panel__body');
    expect(body?.style.paddingBottom).toBe('96px');
  });

  it('retains action-bar layout through exit and cancels release when reopened', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 80,
      height: 80,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });
    await act(async () => {
      useReviewActionBarStore.getState().showCapacityQueueBar({
        childSessionId: 'deep-review-child',
        parentSessionId: 'parent-session',
        capacityQueueState: {
          toolId: 'task-security',
          subagentType: 'ReviewSecurity',
          status: 'queued_for_capacity',
          queuedReviewerCount: 1,
          waitingReviewers: [{
            toolId: 'task-security',
            subagentType: 'ReviewSecurity',
            status: 'queued_for_capacity',
          }],
        },
      });
    });

    const panel = container.querySelector<HTMLElement>('.btw-session-panel');
    const body = container.querySelector<HTMLElement>('.btw-session-panel__body');
    expect(panel?.classList.contains('btw-session-panel--has-action-bar')).toBe(true);
    expect(body?.style.paddingBottom).toBe('176px');

    act(() => useReviewActionBarStore.getState().minimize('deep-review-child'));
    expect(panel?.classList.contains('btw-session-panel--has-action-bar')).toBe(true);
    expect(body?.style.paddingBottom).toBe('176px');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(panel?.classList.contains('btw-session-panel--has-action-bar')).toBe(true);

    act(() => useReviewActionBarStore.getState().restore('deep-review-child'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(panel?.classList.contains('btw-session-panel--has-action-bar')).toBe(true);
    expect(body?.style.paddingBottom).toBe('176px');

    act(() => useReviewActionBarStore.getState().minimize('deep-review-child'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(panel?.classList.contains('btw-session-panel--has-action-bar')).toBe(false);
    expect(body?.style.paddingBottom).toBe('96px');
  });

  it('restores the minimized running action when capacity waiting ends before the review finishes', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createRunningDeepReviewSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    await act(async () => {
      useReviewActionBarStore.getState().showCapacityQueueBar({
        childSessionId: 'deep-review-child',
        parentSessionId: 'parent-session',
        capacityQueueState: {
          toolId: 'task-security',
          subagentType: 'ReviewSecurity',
          status: 'queued_for_capacity',
          queuedReviewerCount: 1,
          waitingReviewers: [{
            toolId: 'task-security',
            subagentType: 'ReviewSecurity',
            status: 'queued_for_capacity',
          }],
        },
      });
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_waiting_capacity',
      minimized: false,
    });

    await act(async () => {
      useReviewActionBarStore.getState().applyCapacityQueueState({
        toolId: 'task-security',
        subagentType: 'ReviewSecurity',
        status: 'running',
        queuedReviewerCount: 0,
        waitingReviewers: [],
      });
      await Promise.resolve();
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_running',
      minimized: true,
    });
    expect(container.querySelector('.btw-session-panel__minimized-button')).toBeTruthy();
  });

  it('lets persisted action state replace the running review placeholder', async () => {
    vi.mocked(loadPersistedReviewState).mockResolvedValueOnce({
      version: 1,
      phase: 'fix_running',
      completedRemediationIds: [],
      minimized: true,
      customInstructions: 'Keep the fix focused.',
      persistedAt: 2,
    });
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createRunningDeepReviewSession()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
      await Promise.resolve();
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'fix_running',
      minimized: true,
      customInstructions: 'Keep the fix focused.',
    });
  });

  it('does not reapply stale persisted minimize state after a local restore during streaming', async () => {
    vi.mocked(loadPersistedReviewState).mockClear();
    vi.mocked(loadPersistedReviewState).mockResolvedValueOnce({
      version: 1,
      phase: 'review_running',
      completedRemediationIds: [],
      minimized: true,
      customInstructions: '',
      persistedAt: 2,
    });
    const runningSession = createRunningDeepReviewSession();
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', runningSession],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
      await Promise.resolve();
    });

    const restoreButton = container.querySelector<HTMLButtonElement>(
      '.btw-session-panel__minimized-button',
    );
    expect(restoreButton).toBeTruthy();
    await act(async () => {
      restoreButton?.click();
    });
    expect(useReviewActionBarStore.getState().getSessionState('deep-review-child')?.minimized)
      .toBe(false);

    const streamedSession = {
      ...runningSession,
      lastActiveAt: runningSession.lastActiveAt + 1,
    };
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', streamedSession],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      panelMocks.flowChatSubscriber?.(flowChatState);
      await Promise.resolve();
    });

    expect(loadPersistedReviewState).toHaveBeenCalledTimes(1);
    expect(useReviewActionBarStore.getState().getSessionState('deep-review-child')?.minimized)
      .toBe(false);
  });

  it('restores persisted follow-up and review scope only when the child still exists', async () => {
    vi.mocked(loadPersistedReviewState).mockResolvedValueOnce({
      version: 1,
      phase: 'fix_completed',
      completedRemediationIds: [],
      minimized: false,
      customInstructions: '',
      followUpReviewSessionId: 'follow-up-review',
      reviewTargetFilePaths: ['src/original.ts'],
      remediationModifiedFilePaths: ['src/helper.ts'],
      remediationScopeRequiresWorkspaceFallback: true,
      persistedAt: 2,
    });
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createRunningDeepReviewSession()],
        ['follow-up-review', { ...createReviewSession(), sessionId: 'follow-up-review' }],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
      await Promise.resolve();
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      followUpReviewSessionId: 'follow-up-review',
      reviewTargetFilePaths: ['src/original.ts'],
      remediationModifiedFilePaths: ['src/helper.ts'],
      remediationScopeRequiresWorkspaceFallback: true,
    });
  });

  it('reconciles a persisted follow-up reservation through the child request id', async () => {
    vi.mocked(loadPersistedReviewState).mockResolvedValueOnce({
      version: 1,
      phase: 'fix_completed',
      completedRemediationIds: [],
      minimized: false,
      customInstructions: '',
      followUpReviewSessionId: '__pending_follow_up_review__:review-operation-1',
      persistedAt: 2,
    });
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createRunningDeepReviewSession()],
        ['follow-up-review', {
          ...createReviewSession(),
          sessionId: 'follow-up-review',
          sessionKind: 'review',
          btwOrigin: {
            requestId: 'review-operation-1',
            parentSessionId: 'parent-session',
          },
        }],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
      await Promise.resolve();
    });

    expect(useReviewActionBarStore.getState().getSessionState('deep-review-child')
      ?.followUpReviewSessionId).toBe('follow-up-review');
  });

  it('keeps a persisted follow-up reservation retryable when no child was created', async () => {
    vi.mocked(loadPersistedReviewState).mockResolvedValueOnce({
      version: 1,
      phase: 'fix_completed',
      completedRemediationIds: [],
      minimized: false,
      customInstructions: '',
      followUpReviewSessionId: '__pending_follow_up_review__:missing-operation',
      persistedAt: 2,
    });

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
      await Promise.resolve();
    });

    expect(useReviewActionBarStore.getState().getSessionState('deep-review-child')
      ?.followUpReviewSessionId).toBe('__pending_follow_up_review__:missing-operation');
  });

  it('restores only unfinished items from an interrupted persisted fix run', async () => {
    const reviewSession = createCancelledFixDeepReview();
    reviewSession.status = 'running';
    reviewSession.dialogTurns[0].modelRounds[0].items[0].toolResult = {
      success: true,
      result: JSON.stringify({
        summary: {
          overall_assessment: 'Two fixes remain.',
          risk_level: 'medium',
          recommended_action: 'request_changes',
        },
        issues: [],
        positive_points: [],
        review_mode: 'deep',
        remediation_plan: ['Fix issue 1', 'Fix issue 2'],
      }),
    };
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', reviewSession],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    const completedId = 'remediation-0';
    const unfinishedId = 'remediation-1';
    vi.mocked(loadPersistedReviewState).mockResolvedValueOnce({
      version: 1,
      phase: 'fix_running',
      completedRemediationIds: [completedId],
      fixingRemediationIds: [completedId, unfinishedId],
      minimized: true,
      customInstructions: '',
      fixingBaselineTurnId: 'turn-1',
      persistedAt: 2,
    });

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
      await Promise.resolve();
    });

    expect(useReviewActionBarStore.getState().getSessionState('deep-review-child')).toMatchObject({
      phase: 'fix_interrupted',
      remainingFixIds: [unfinishedId],
    });
  });

  it('shows a resumable Deep Review action bar when the run completed without a structured report', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createCompletedDeepReviewWithoutResult()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_interrupted',
      interruption: expect.objectContaining({
        canResume: true,
        resultRecoveryReason: 'missing_submit_code_review',
      }),
    });
  });

  it('does not restore a stale interruption while a resume request is starting', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createInterruptedDeepReviewWithoutResult()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    const store = useReviewActionBarStore.getState();
    store.showInterruptedActionBar({
      childSessionId: 'deep-review-child',
      parentSessionId: 'parent-session',
      interruption: {
        phase: 'review_interrupted',
        childSessionId: 'deep-review-child',
        parentSessionId: 'parent-session',
        originalTarget: '/DeepReview review latest commit',
        errorDetail: { category: 'unknown', rawMessage: 'previous execution failed' },
        canResume: true,
        recommendedActions: [],
        reviewers: [],
      },
    });
    store.setActiveAction('resume', { baselineTurnId: 'turn-1' });
    store.updatePhase('resume_running');
    store.minimize();

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'resume_running',
      minimized: true,
    });
  });

  it('expands the action bar when a resumed Deep Review completes successfully', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createCompletedResumeDeepReview()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    const store = useReviewActionBarStore.getState();
    store.showInterruptedActionBar({
      childSessionId: 'deep-review-child',
      parentSessionId: 'parent-session',
      interruption: {
        phase: 'review_interrupted',
        childSessionId: 'deep-review-child',
        parentSessionId: 'parent-session',
        originalTarget: '/DeepReview review latest commit',
        errorDetail: { category: 'unknown', rawMessage: 'previous execution failed' },
        canResume: true,
        recommendedActions: [],
        reviewers: [],
      },
    });
    store.setActiveAction('resume', { baselineTurnId: 'turn-1' });
    store.updatePhase('resume_running');
    store.minimize();

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_completed',
      minimized: false,
    });
  });

  it('marks a stopped fix run as interrupted and restores the action bar state', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createCancelledFixDeepReview()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    const store = useReviewActionBarStore.getState();
    store.showActionBar({
      childSessionId: 'deep-review-child',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      reviewMode: 'deep',
      phase: 'review_completed',
    });
    const itemId = useReviewActionBarStore.getState().remediationItems[0]?.id;
    expect(itemId).toBeTruthy();
    store.setSelectedRemediationIds(new Set([itemId!]));
    store.setActiveAction('fix', { baselineTurnId: 'turn-1' });
    store.updatePhase('fix_running');
    store.minimize();

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'fix_interrupted',
      minimized: false,
      remainingFixIds: [itemId],
    });
  });

  it('restores the interrupted action bar when a resumed Deep Review is cancelled by the user', async () => {
    flowChatState = {
      ...flowChatState,
      sessions: new Map([
        ['deep-review-child', createCancelledResumeDeepReview()],
        ['parent-session', flowChatState.sessions.get('parent-session')!],
      ]),
    } as FlowChatState;

    const store = useReviewActionBarStore.getState();
    store.showInterruptedActionBar({
      childSessionId: 'deep-review-child',
      parentSessionId: 'parent-session',
      interruption: {
        phase: 'review_interrupted',
        childSessionId: 'deep-review-child',
        parentSessionId: 'parent-session',
        originalTarget: '/DeepReview review latest commit',
        errorDetail: { category: 'unknown', rawMessage: 'previous execution failed' },
        canResume: true,
        recommendedActions: [],
        reviewers: [],
      },
    });
    store.setActiveAction('resume', { baselineTurnId: 'turn-1' });
    store.updatePhase('resume_running');
    store.minimize();

    await act(async () => {
      root.render(
        <BtwSessionPanel
          childSessionId="deep-review-child"
          parentSessionId="parent-session"
          workspacePath="D:/workspace/project"
        />,
      );
    });

    expect(useReviewActionBarStore.getState()).toMatchObject({
      childSessionId: 'deep-review-child',
      phase: 'review_interrupted',
      minimized: false,
      interruption: expect.objectContaining({
        interruptionReason: 'manual_cancelled',
      }),
    });
  });
});
