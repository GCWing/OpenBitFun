import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskToolDisplay } from './TaskToolDisplay';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import flowChatEn from '../../locales/en-US/flow-chat.json';

const mocks = vi.hoisted(() => ({
  openBtwSessionInAuxPane: vi.fn(),
  loadBtwSessionHistory: vi.fn(() => Promise.resolve()),
  cancelSession: vi.fn(),
  notificationError: vi.fn(),
  flowChatListeners: new Set<() => void>(),
  childParentToolCallId: undefined as string | undefined,
  dynamicReviewTurn: {
    status: 'processing',
    startTime: 1000,
    endTime: undefined as number | undefined,
    error: undefined as string | undefined,
  },
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    if (key.startsWith('subagentIdentity.names.')) {
      return flowChatEn.subagentIdentity.names[key.split('.').at(-1) as keyof typeof flowChatEn.subagentIdentity.names];
    }
    if (key === 'toolCards.taskTool.headerLine') {
      return `${options?.agentType} agent: ${options?.description}`;
    }
    if (key === 'toolCards.taskTool.headerLinePrefix') {
      return `${options?.agentType} agent`;
    }
    if (key === 'toolCards.taskTool.headerLineSuffix') {
      return `: ${options?.description}`;
    }
    if (key === 'toolCards.taskTool.defaultAgentKind') {
      return 'Sub-agent';
    }
    if (key === 'toolCards.taskTool.reviewCoverageLabel') {
      return 'Additional check';
    }
    if (key === 'toolCards.taskTool.reviewCoverageDescription') {
      return 'Checking review coverage';
    }
    if (key === 'toolCards.taskTool.reviewFocusedDescription') {
      return 'Checking a specific concern';
    }
    if (key === 'toolCards.taskTool.reviewCheckUnavailable') {
      return 'This check could not be completed. The main review can continue.';
    }
    if (key === 'toolCards.taskTool.reviewPartialTimeout') {
      return 'Timed out after returning partial details';
    }
    if (key === 'toolCards.taskTool.reviewTimedOut') {
      return 'Timed out';
    }
    if (key === 'toolCards.taskTool.reviewStopped') {
      return 'Stopped';
    }
    if (key === 'toolCards.taskTool.cancelSession') {
      return `Cancel session: ${options?.sessionId}`;
    }
    if (key.startsWith('reviewTeams.') && typeof options?.defaultValue === 'string') {
      return options.defaultValue;
    }
    return key;
  };
  return {
    useI18n: () => ({ t }),
  };
});

vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/shared/services/reviewTeamService', () => ({
  getReviewerContextBySubagentId: () => null,
}));

vi.mock('./ToolTimeoutIndicator', () => ({
  ToolTimeoutIndicator: ({
    isRunning,
    completedStatus,
    completedDurationMs,
    completedFailureReason,
  }: {
    isRunning?: boolean;
    completedStatus?: string;
    completedDurationMs?: number;
    completedFailureReason?: string;
  }) => (
    <span
      data-testid="tool-timeout-indicator"
      data-is-running={String(Boolean(isRunning))}
      data-completed-status={completedStatus}
      data-completed-duration={completedDurationMs}
      data-completed-failure-reason={completedFailureReason}
    />
  ),
}));

vi.mock('../services/btwSessionPane', () => ({
  openBtwSessionInAuxPane: (...args: unknown[]) => mocks.openBtwSessionInAuxPane(...args),
  loadBtwSessionHistory: (...args: unknown[]) => mocks.loadBtwSessionHistory(...args),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    cancelSession: (...args: unknown[]) => mocks.cancelSession(...args),
  },
}));

vi.mock('@/shared/notification-system/services/NotificationService', () => ({
  notificationService: {
    error: (...args: unknown[]) => mocks.notificationError(...args),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    subscribe: (listener: () => void) => {
      mocks.flowChatListeners.add(listener);
      return () => mocks.flowChatListeners.delete(listener);
    },
    getState: () => ({
      sessions: new Map([
        ['parent-session', {
          sessionId: 'parent-session',
          workspacePath: 'D:\\workspace\\repo',
          remoteConnectionId: 'remote-1',
          remoteSshHost: 'host-1',
          config: { agentType: 'Standard' },
        }],
        ['deep-review-parent-session', {
          sessionId: 'deep-review-parent-session',
          workspacePath: 'D:\\workspace\\repo',
          remoteConnectionId: 'remote-1',
          remoteSshHost: 'host-1',
          config: { agentType: 'DeepReview' },
        }],
        ['subagent-session-1', {
          sessionId: 'subagent-session-1',
          sessionKind: 'subagent',
          parentSessionId: 'parent-session',
          parentToolCallId: mocks.childParentToolCallId,
          createdAt: 1000,
          status: 'completed',
          mode: 'Explore',
          config: { agentType: 'Explore', modelName: 'fast' },
          dialogTurns: [],
        }],
        ['review-session-running', {
          sessionId: 'review-session-running',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          dialogTurns: [{
            id: 'review-turn',
            status: 'processing',
            startTime: 1000,
          }],
        }],
        ['review-session-focused', {
          sessionId: 'review-session-focused',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          focusedReviewDisplayLabel: 'Authentication boundary',
          dialogTurns: [{
            id: 'review-turn-focused',
            status: 'processing',
            startTime: 1000,
          }],
        }],
        ['review-session-unsafe-label', {
          sessionId: 'review-session-unsafe-label',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          dialogTurns: [{
            id: 'review-turn-unsafe-label',
            status: 'processing',
            startTime: 1000,
          }],
        }],
        ['review-session-error', {
          sessionId: 'review-session-error',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          dialogTurns: [{
            id: 'review-turn-error',
            status: 'error',
            startTime: 1000,
            endTime: 2400,
            error: 'Review worker failed.',
          }],
        }],
        ['review-session-cancelled', {
          sessionId: 'review-session-cancelled',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          dialogTurns: [{
            id: 'review-turn-cancelled',
            status: 'cancelled',
            startTime: 1000,
            endTime: 1800,
          }],
        }],
        ['review-session-completed', {
          sessionId: 'review-session-completed',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          dialogTurns: [{
            id: 'review-turn-completed',
            status: 'completed',
            startTime: 1000,
            endTime: 1800,
          }],
        }],
        ['review-session-dynamic', {
          sessionId: 'review-session-dynamic',
          mode: 'CodeReview',
          config: { agentType: 'CodeReview', modelName: 'fast' },
          dialogTurns: [{
            id: 'review-turn-dynamic',
            modelRounds: [],
            ...mocks.dynamicReviewTurn,
          }],
        }],
      ]),
    }),
  },
}));

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

const config: ToolCardConfig = {
  toolName: 'Task',
  displayName: 'Task',
  icon: 'task',
  requiresConfirmation: false,
  resultDisplayType: 'summary',
};

function failedTaskItem(): FlowToolItem {
  return {
    id: 'task-tool-1',
    type: 'tool',
    toolName: 'Task',
    timestamp: Date.now(),
    status: 'error',
    toolCall: {
      id: 'task-call-1',
      input: {
        description: 'Review frontend',
        prompt: 'Review frontend code',
        subagent_type: 'ReviewFrontend',
      },
    },
    toolResult: {
      success: false,
      result: null,
      error: 'Subagent failed before finishing.',
    },
  };
}

function reviewTaskItem(
  status: FlowToolItem['status'],
  subagentType = 'ReviewFrontend',
  description = `Review frontend [packet reviewer:${subagentType}:group-1-of-1]`,
): FlowToolItem {
  return {
    id: 'task-tool-1',
    type: 'tool',
    toolName: 'Task',
    timestamp: Date.now(),
    status,
    toolCall: {
      id: 'task-call-1',
      input: {
        description,
        prompt: 'Review frontend code',
        subagent_type: subagentType,
      },
    },
    toolResult:
      status === 'completed'
        ? {
            success: true,
            result: {
              duration: 1000,
            },
          }
        : undefined,
  };
}

describeWithJsdom('TaskToolDisplay', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  async function previewText(): Promise<string> {
    const trigger = container.querySelector('[data-agent-capsule-trigger]');
    if (trigger && !document.querySelector('[data-openbitfun-part="agentPreview"]')) {
      vi.useFakeTimers();
      try {
        await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
        await act(async () => { vi.advanceTimersByTime(500); });
        await act(async () => { vi.advanceTimersByTime(30); });
      } finally {
        vi.useRealTimers();
      }
    }
    return `${container.textContent ?? ''}${document.querySelector('[data-openbitfun-part="agentPreview"]')?.textContent ?? ''}`;
  }

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('CustomEvent', window.CustomEvent);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mocks.flowChatListeners.clear();
    mocks.childParentToolCallId = undefined;
    mocks.dynamicReviewTurn.status = 'processing';
    mocks.dynamicReviewTurn.startTime = 1000;
    mocks.dynamicReviewTurn.endTime = undefined;
    mocks.dynamicReviewTurn.error = undefined;
  });

  it.each([false, true])('opens the linked child from relationship metadata without a tool session ID, late=%s', async late => {
    const item = failedTaskItem();
    item.status = 'completed';
    item.toolCall.input = {};
    item.toolResult = { success: true, result: { agent_id: 'frontend-hotpaths', status: 'completed' } };
    if (!late) mocks.childParentToolCallId = item.toolCall.id;
    const onOpenInPanel = vi.fn();
    await act(async () => root.render(
      <TaskToolDisplay toolItem={item} config={config} sessionId="parent-session" onOpenInPanel={onOpenInPanel} />,
    ));
    if (late) {
      await act(async () => {
        mocks.childParentToolCallId = item.toolCall.id;
        mocks.flowChatListeners.forEach(listener => listener());
      });
    }
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!.click());
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({
      childSessionId: 'subagent-session-1',
      parentSessionId: 'parent-session',
      parentToolCallId: 'task-call-1',
    }));
    expect(onOpenInPanel).not.toHaveBeenCalled();
  });

  it('opens failed task details on the right without an inline disclosure', async () => {
    const onOpenInPanel = vi.fn();
    await act(async () => root.render(
      <TaskToolDisplay toolItem={failedTaskItem()} config={config} sessionId="parent-session" onOpenInPanel={onOpenInPanel} />,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!;
    expect(trigger.hasAttribute('aria-expanded')).toBe(false);
    expect(container.querySelector('[data-openbitfun-part="expandedCollapse"]')).toBeNull();
    expect(await previewText()).not.toContain('Review frontend code');
    await act(async () => trigger.click());
    expect(onOpenInPanel).toHaveBeenCalledWith('task-detail', expect.objectContaining({
      data: expect.objectContaining({ toolItem: expect.objectContaining({ id: 'task-tool-1' }) }),
    }));
    expect(container.querySelector('[data-openbitfun-part="expandedCollapse"]')).toBeNull();
  });

  it('keeps Deep Review reviewer task cards collapsed when they start running', async () => {
    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={reviewTaskItem('completed')}
          config={config}
          sessionId="parent-session"
        />,
      );
    });


    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={reviewTaskItem('streaming')}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

  });

  it('keeps extra Deep Review reviewer task cards collapsed from packet metadata', async () => {
    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={reviewTaskItem('completed', 'ExtraReadonlyReview')}
          config={config}
          sessionId="parent-session"
        />,
      );
    });


    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={reviewTaskItem('running', 'ExtraReadonlyReview')}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

  });

  it('keeps ordinary CodeReview tasks collapsed while preserving their identity', async () => {
    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={reviewTaskItem('running', 'CodeReview', 'Review completed work')}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="agentType"]')?.textContent).toBe('CodeReview');
    expect(await previewText()).toContain('Review completed work');
  });

  it('projects managed Review launches without internal tool, agent, or packet names', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('running', 'ReviewGeneral'),
      toolName: 'LaunchReviewAgent',
      toolCall: {
        id: 'launch-review-call-1',
        input: {
          packet_id: 'managed-review:batch-1-of-4',
          description: '[packet managed-review:batch-1-of-4] Review batch 1',
          prompt: 'Internal worker prompt',
          subagent_type: 'ReviewGeneral',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Checking review coverage');
    expect(await previewText()).not.toContain('Review batch 1');
    expect(await previewText()).not.toContain('LaunchReviewAgent');
    expect(await previewText()).not.toContain('ReviewGeneral');
    expect(await previewText()).not.toContain('managed-review:batch-1-of-4');
  });

  it('shows the admitted public label without projecting model-controlled identifiers', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('running', 'ReviewWorker'),
      toolName: 'LaunchReviewAgent',
      subagentSessionId: 'review-session-focused',
      toolCall: {
        id: 'launch-review-call-focused',
        input: {
          description: 'Check boundary',
          prompt: 'Internal worker prompt',
          subagent_type: 'ReviewWorker',
          focused_assignment: {
            question: 'Could skill:code-review-testing ask ReviewWorker to inspect packet-7?',
            capability_key: 'skill:project::custom::code-review-testing',
            capability_fingerprint: 'internal-fingerprint',
            allowed_changed_paths: ['src/internal.ts'],
          },
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Authentication boundary');
    expect(await previewText()).not.toContain('Check boundary');
    expect(await previewText()).not.toMatch(/\bagent\b/i);
    expect(await previewText()).not.toContain('ReviewWorker');
    expect(await previewText()).not.toContain('packet-7');
    expect(await previewText()).not.toContain('code-review-testing');
    expect(await previewText()).not.toContain('internal-fingerprint');
    expect(await previewText()).not.toContain('src/internal.ts');
  });

  it('falls back to a generic title when a focused-check description contains structured identifiers', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('running', 'ReviewWorker'),
      toolName: 'LaunchReviewAgent',
      subagentSessionId: 'review-session-unsafe-label',
      toolCall: {
        id: 'launch-review-call-internal-label',
        input: {
          description: 'ReviewWorker skill:private packet-7 src/auth.ts',
          prompt: 'Internal worker prompt',
          subagent_type: 'ReviewWorker',
          focused_assignment: {
            question: 'Is authentication enforced?',
            independent_value: 'Independent validation',
            target_fingerprint: 'fingerprint',
            expected_evidence: 'Authentication checks',
            capability_key: 'skill:private',
            capability_fingerprint: 'internal-fingerprint',
            allowed_changed_paths: ['src/auth.ts'],
          },
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Checking a specific concern');
    expect(await previewText()).not.toContain('ReviewWorker');
    expect(await previewText()).not.toContain('skill:private');
    expect(await previewText()).not.toContain('packet-7');
    expect(await previewText()).not.toContain('src/auth.ts');
  });

  it('hides internal additional-check failure details', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('error', 'ReviewWorker'),
      toolName: 'LaunchReviewAgent',
      toolCall: {
        id: 'launch-review-call-failed',
        input: {
          description: 'ReviewWorker should inspect skill:private and src/private.ts',
          prompt: 'Internal worker prompt',
          subagent_type: 'ReviewWorker',
          focused_assignment: 'malformed',
        },
      },
      toolResult: {
        success: false,
        result: null,
        error: 'ReviewWorker exceeded max calls while reading src/private.ts',
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Checking a specific concern');
    expect(await previewText()).not.toContain('skill:private');
    expect(await previewText()).not.toContain('src/private.ts');
  });

  it('shows partial-timeout Review results without exposing partial output', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewWorker'),
      toolName: 'LaunchReviewAgent',
      toolResult: {
        success: true,
        result: {
          duration: 31_000,
          status: 'partial_timeout',
          partial_output: 'private partial findings from src/private.ts',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Timed out after returning partial details');
    expect(await previewText()).not.toContain('private partial findings');
    expect(await previewText()).not.toContain('src/private.ts');
    expect(await previewText()).toContain('Timed out after returning partial details');
  });

  it('shows a safe timeout outcome for a Review check', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('error', 'ReviewWorker'),
      toolName: 'LaunchReviewAgent',
      toolResult: {
        success: false,
        result: null,
        error: 'provider timeout while reading src/private.ts',
        duration_ms: 30_000,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Timed out');
    expect(await previewText()).not.toContain('provider timeout');
    expect(await previewText()).not.toContain('src/private.ts');

    expect(await previewText()).toContain('Timed out');
  });

  it('shows a stopped outcome for a cancelled Review check', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewWorker'),
      toolName: 'LaunchReviewAgent',
      toolResult: {
        success: true,
        result: {
          duration: 2_000,
          status: 'cancelled',
          reason: 'private cancellation detail',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('Stopped');
    expect(await previewText()).not.toContain('private cancellation detail');
    expect(await previewText()).toContain('Stopped');
  });

  it.each([
    { status: 'partial_timeout', label: 'Timed out after returning partial details' },
    { status: 'timed_out', label: 'Timed out' },
    { status: 'cancelled', label: 'Stopped' },
  ])('prefers a live child over a stale parent $status outcome', async ({ status, label }) => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewWorker', 'Check authentication'),
      toolName: 'LaunchReviewAgent',
      subagentSessionId: 'review-session-running',
      toolCall: {
        id: 'launch-review-live-child',
        input: {
          description: 'Check authentication',
          prompt: 'Internal worker prompt',
          subagent_type: 'ReviewWorker',
          focused_assignment: { question: 'Is authentication enforced?' },
        },
      },
      toolResult: {
        success: status === 'partial_timeout',
        result: { status, duration: 30_000 },
        error: status === 'timed_out' ? 'request timed out' : undefined,
        duration_ms: 30_000,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(container.querySelector('[data-openbitfun-tool-card="agent-control"][data-openbitfun-status="running"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="preparing"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="streaming"]')).toBeTruthy();
    expect(container.querySelector('[data-openbitfun-part="interruptAgentButton"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="agentStatus"]')?.getAttribute('data-status')).toBe('running');
    expect(await previewText()).not.toContain(label);

  });

  it.each([
    { childSessionId: 'review-session-completed' },
    { childSessionId: 'review-session-error' },
    { childSessionId: 'review-session-cancelled' },
  ])('does not keep running controls after child $childSessionId is terminal', async ({ childSessionId }) => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('running', 'ReviewWorker', 'Check authentication'),
      subagentSessionId: childSessionId,
      toolCall: {
        id: `task-${childSessionId}`,
        input: {
          description: 'Check authentication',
          prompt: 'Internal worker prompt',
          subagent_type: 'ReviewWorker',
          packet_id: 'reviewer:security:group-1-of-1',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="processing"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="interruptAgentButton"]')).toBeNull();

  });

  it('shows a background review as running while its child session is still processing', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'CodeReview', 'Review CLI app layer diff'),
      subagentSessionId: 'review-session-running',
      toolCall: {
        id: 'task-call-1',
        input: {
          action: 'spawn',
          agent_id: 'cli-review',
          prompt: 'Review CLI app layer diff',
          run_in_background: true,
          subagent_type: 'CodeReview',
        },
      },
      toolResult: {
        success: true,
        result: {
          status: 'started',
          run_in_background: true,
          session_id: 'review-session-running',
        },
        duration_ms: 79,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-tool-card="agent-control"][data-openbitfun-status="running"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="preparing"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="streaming"]')).toBeTruthy();
    expect(await previewText()).toContain('Review CLI app layer diff');
  });

  it('projects a failed background child instead of the successful spawn acknowledgement', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'CodeReview', 'Review failed area'),
      subagentSessionId: 'review-session-error',
      toolCall: {
        id: 'task-call-error',
        input: {
          action: 'spawn',
          agent_id: 'failed-area-review',
          prompt: 'Review failed area',
          run_in_background: true,
          subagent_type: 'CodeReview',
        },
      },
      toolResult: {
        success: true,
        result: { status: 'started', session_id: 'review-session-error' },
        duration_ms: 79,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).toContain('toolCards.taskTool.failed');


  });

  it('projects a cancelled background child instead of the successful spawn acknowledgement', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'CodeReview', 'Review cancelled area'),
      subagentSessionId: 'review-session-cancelled',
      toolCall: {
        id: 'task-call-cancelled',
        input: {
          action: 'spawn',
          agent_id: 'cancelled-area-review',
          prompt: 'Review cancelled area',
          run_in_background: true,
          subagent_type: 'CodeReview',
        },
      },
      toolResult: {
        success: true,
        result: { status: 'started', session_id: 'review-session-cancelled' },
        duration_ms: 79,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).not.toContain('toolCards.taskTool.failed');


  });

  it('reacts when a running background child transitions to error', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'CodeReview', 'Review dynamic area'),
      subagentSessionId: 'review-session-dynamic',
      toolCall: {
        id: 'task-call-dynamic-error',
        input: {
          action: 'spawn',
          agent_id: 'dynamic-area-review',
          prompt: 'Review dynamic area',
          run_in_background: true,
          subagent_type: 'CodeReview',
        },
      },
      toolResult: {
        success: true,
        result: { status: 'started', session_id: 'review-session-dynamic' },
        duration_ms: 79,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });
    expect(container.querySelector('[data-openbitfun-tool-card="agent-control"][data-openbitfun-status="running"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="preparing"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="streaming"]')).toBeTruthy();

    await act(async () => {
      mocks.dynamicReviewTurn.status = 'error';
      mocks.dynamicReviewTurn.endTime = 2500;
      mocks.dynamicReviewTurn.error = 'Review worker failed.';
      mocks.flowChatListeners.forEach((listener) => listener());
    });

    expect(container.querySelector('[data-openbitfun-part="processing"]')).toBeFalsy();
    expect(await previewText()).toContain('toolCards.taskTool.failed');

  });

  it('reacts when a running background child transitions to cancelled', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'CodeReview', 'Review dynamic area'),
      subagentSessionId: 'review-session-dynamic',
      toolCall: {
        id: 'task-call-dynamic-cancelled',
        input: {
          action: 'spawn',
          agent_id: 'dynamic-area-review',
          prompt: 'Review dynamic area',
          run_in_background: true,
          subagent_type: 'CodeReview',
        },
      },
      toolResult: {
        success: true,
        result: { status: 'started', session_id: 'review-session-dynamic' },
        duration_ms: 79,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });
    expect(container.querySelector('[data-openbitfun-tool-card="agent-control"][data-openbitfun-status="running"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="preparing"], [data-openbitfun-tool-card="agent-control"][data-openbitfun-status="streaming"]')).toBeTruthy();

    await act(async () => {
      mocks.dynamicReviewTurn.status = 'cancelled';
      mocks.dynamicReviewTurn.endTime = 1900;
      mocks.flowChatListeners.forEach((listener) => listener());
    });

    expect(container.querySelector('[data-openbitfun-part="processing"]')).toBeFalsy();

  });

  it('does not treat Review-prefixed remediation agents as read-only coverage tasks', async () => {
    const completedItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewFixer', 'Fix reviewed issues'),
      subagentSessionId: 'review-fixer-session',
    };
    const runningItem: FlowToolItem = {
      ...reviewTaskItem('running', 'ReviewFixer', 'Fix reviewed issues'),
      subagentSessionId: 'review-fixer-session',
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={completedItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={runningItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    expect(await previewText()).toContain('Fix reviewed issues');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]')!.click());
    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'ReviewFixer' }));
    expect(mocks.openBtwSessionInAuxPane.mock.calls.at(-1)?.[0]).not.toHaveProperty('viewKind');
    expect(container.querySelector('[data-openbitfun-part="interruptAgentButton"]')).toBeNull();
  });

  it('opens the real subagent session in the aux pane when the task card rail is clicked', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'Explore', 'Investigate task card behavior'),
      subagentSessionId: 'subagent-session-1',
      toolResult: {
        success: true,
        result: { duration: 1000, agent_id: 'repo-investigator' },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]');
    expect(openButton).toBeTruthy();
    expect(container.querySelector('[data-openbitfun-component="subagent-avatar"][data-openbitfun-avatar-id]'))
      .toBeTruthy();
    expect(await previewText()).not.toContain('repo-investigator');
    expect(container.querySelector('[data-openbitfun-part="subagentName"]')).toBeNull();

    await act(async () => {
      openButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith({
      childSessionId: 'subagent-session-1',
      parentSessionId: 'parent-session',
      workspacePath: 'D:\\workspace\\repo',
      sessionKind: 'subagent',
      sessionTitle: expect.any(String),
      agentType: 'Explore',
      parentToolCallId: 'task-call-1',
      subagentType: 'Explore',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
      includeInternal: true,
    });
  });

  it('does not show the caller-selected agent id before the spawn result arrives', async () => {
    const toolItem: FlowToolItem = {
      id: 'task-tool-pending-spawn',
      type: 'tool',
      toolName: 'Task',
      timestamp: Date.now(),
      status: 'running',
      toolCall: {
        id: 'task-call-pending-spawn',
        input: {
          action: 'spawn',
          agent_id: 'repo-investigator',
          prompt: 'Investigate the failing repository path.',
          subagent_type: 'Explore',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay toolItem={toolItem} config={config} sessionId="parent-session" />,
      );
    });

    expect(await previewText()).not.toContain('repo-investigator');
    expect(container.querySelector('[data-openbitfun-part="subagentName"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase')).toBe('incubating');
    await act(async () => root.render(
      <TaskToolDisplay toolItem={{ ...toolItem, status: 'cancelled' }} config={config} sessionId="parent-session" />,
    ));
    expect(container.querySelector('[data-openbitfun-component="subagent-hatch"]')?.getAttribute('data-phase')).toBe('stopped');
  });

  it('opens an ordinary CodeReview subagent instead of treating it as Deep Review coverage', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'CodeReview', 'Review completed work'),
      subagentSessionId: 'code-review-session-1',
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]');
    expect(openButton).toBeTruthy();

    await act(async () => {
      openButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'code-review-session-1',
        parentSessionId: 'parent-session',
        agentType: 'CodeReview',
        subagentType: 'CodeReview',
        includeInternal: true,
      }),
    );
  });

  it('opens historical fixed-reviewer details in the real child session', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewSecurity', 'Review authentication changes'),
      subagentSessionId: 'legacy-review-security-session',
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="deep-review-parent-session"
        />,
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]');
    expect(openButton).toBeTruthy();

    await act(async () => {
      openButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'legacy-review-security-session',
        parentSessionId: 'deep-review-parent-session',
        sessionKind: 'subagent',
        agentType: 'ReviewSecurity',
        subagentType: 'ReviewSecurity',
        viewKind: 'review-check',
        includeInternal: true,
      }),
    );
  });

  it('opens a historical packetless ReviewJudge in the real child session', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewJudge', 'Validate disputed findings'),
      subagentSessionId: 'legacy-review-judge-session',
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="deep-review-parent-session"
        />,
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]');
    await act(async () => {
      openButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'legacy-review-judge-session',
        parentSessionId: 'deep-review-parent-session',
        sessionKind: 'subagent',
        agentType: 'ReviewJudge',
        subagentType: 'ReviewJudge',
        viewKind: 'review-check',
        includeInternal: true,
      }),
    );
  });

  it('does not apply the historical reviewer fallback outside Deep Review', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('completed', 'ReviewSecurity', 'Run a custom security task'),
      subagentSessionId: 'custom-review-security-session',
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>('[data-agent-capsule-trigger]');
    await act(async () => {
      openButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.openBtwSessionInAuxPane).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: 'custom-review-security-session',
        parentSessionId: 'parent-session',
      }),
    );
  });

  it('renders spawn task cards from the result subagent session metadata', async () => {
    const toolItem: FlowToolItem = {
      id: 'task-tool-spawn',
      type: 'tool',
      toolName: 'Task',
      timestamp: Date.now(),
      status: 'completed',
      toolCall: {
        id: 'task-call-spawn',
        input: {
          action: 'spawn',
          agent_id: 'isolated-context',
          fork_context: true,
          prompt: 'Explore isolated context by investigating the isolated path',
        },
      },
      toolResult: {
        success: true,
        result: {
          action: 'spawn',
          session_id: 'subagent-session-1',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    const summary = container.querySelector<HTMLElement>('[data-openbitfun-tool-card="agent-control"]');
    expect(summary?.textContent).not.toContain('Explore agent');
    expect(summary?.querySelector('[data-openbitfun-part="agentType"]')?.textContent).toBe('Explore');
    expect(summary?.querySelector('[data-openbitfun-part="agentModel"]')?.textContent).toBe('fast');
    expect(await previewText()).toContain('Explore isolated context');
  });

  it('renders historical send_input tasks as messages to the linked subagent', async () => {
    const toolItem: FlowToolItem = {
      id: 'task-tool-send-input',
      type: 'tool',
      toolName: 'Task',
      timestamp: Date.now(),
      status: 'running',
      subagentSessionId: 'subagent-session-1',
      toolCall: {
        id: 'task-call-send-input',
        input: {
          action: 'send_input',
          agent_id: 'repo-investigator',
          prompt: 'Continue investigation by checking the failing path',
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    const summary = container.querySelector<HTMLElement>('[data-openbitfun-tool-card="session-message"]')!;
    expect(summary.getAttribute('data-operation')).toBe('send');
    expect(summary.querySelector('[data-openbitfun-part="target"] [data-overflow-content]')?.textContent).toBe('Bubble Bandit');
    expect(summary.textContent).not.toContain('Continue investigation');
    await act(async () => summary.querySelector<HTMLButtonElement>('[data-openbitfun-part="result"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Continue investigation');
  });

  it('renders cancelled foreground subagent results as cancelled instead of failed', async () => {
    const toolItem: FlowToolItem = {
      ...reviewTaskItem('error', 'Explore', 'Investigate cancellable task'),
      subagentSessionId: 'subagent-session-1',
      toolResult: {
        success: false,
        result: null,
        error: 'Subagent task has been cancelled',
        duration_ms: 1200,
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    expect(container.querySelector('[data-openbitfun-part="agentStatus"]')).toBeTruthy();
    expect(container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-status="cancelled"]',
    )).toBeTruthy();
    expect(await previewText()).not.toContain('Failed');
  });

  it('keeps historical cancel tasks compact with their actual interruption result available', async () => {

    const toolItem: FlowToolItem = {
      id: 'task-tool-cancel',
      type: 'tool',
      toolName: 'Task',
      timestamp: Date.now(),
      status: 'completed',
      toolCall: {
        id: 'task-call-cancel',
        input: {
          action: 'cancel',
          agent_id: 'repo-investigator',
        },
      },
      toolResult: {
        success: true,
        result: {
          action: 'cancel',
          status: 'cancelled',
          session_id: 'subagent-session-1',
          cancelled_background_tasks: 1,
        },
      },
    };

    await act(async () => {
      root.render(
        <TaskToolDisplay
          toolItem={toolItem}
          config={config}
          sessionId="parent-session"
        />,
      );
    });

    expect(container.querySelector('[data-agent-capsule-trigger]')).toBeNull();
    const summary = container.querySelector<HTMLElement>('[data-openbitfun-tool-card="session-message"]')!;
    expect(summary.getAttribute('data-operation')).toBe('interrupt');
    expect(summary.getAttribute('data-openbitfun-status')).toBe('completed');
    expect(summary.querySelector('[data-openbitfun-part="result"]')?.textContent).toContain('toolCards.interaction.interruptedRuns');
    await act(async () => summary.querySelector<HTMLButtonElement>('[data-openbitfun-part="result"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('toolCards.interaction.interruptedRuns');

  });
});
