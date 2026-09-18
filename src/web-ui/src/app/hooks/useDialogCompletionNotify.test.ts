import { describe, expect, it } from 'vitest';
import type { AgenticEvent } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '@/flow_chat/types/flow-chat';
import {
  buildDialogCompletionNotificationCopy,
  shouldSendDialogCompletionNotification,
} from './dialogCompletionNotifyPolicy';

const event = (overrides: Partial<AgenticEvent> = {}): AgenticEvent => ({
  sessionId: 'session-1',
  turnId: 'turn-1',
  ...overrides,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 'session-1',
  title: 'Session',
  titleStatus: 'generated',
  dialogTurns: [],
  status: 'idle',
  config: {
    modelName: 'gpt-test',
    agentType: 'Standard',
  },
  createdAt: 1000,
  lastActiveAt: 1000,
  error: null,
  todos: [],
  maxContextTokens: 128128,
  mode: 'Standard',
  workspacePath: '/workspace',
  parentSessionId: undefined,
  sessionKind: 'normal',
  btwThreads: [],
  btwOrigin: undefined,
  ...overrides,
});

describe('shouldSendDialogCompletionNotification', () => {
  it('suppresses notifications for individual subagent completions', () => {
    expect(
      shouldSendDialogCompletionNotification({
        event: event(),
        session: session({
          sessionKind: 'subagent',
          parentSessionId: 'parent-1',
        }),
        isBackground: true,
        notificationsEnabled: true,
      }),
    ).toBe(false);
  });

  it('suppresses standard review child session notifications', () => {
    expect(
      shouldSendDialogCompletionNotification({
        event: event(),
        session: session({
          sessionKind: 'review',
          parentSessionId: 'parent-1',
        }),
        isBackground: true,
        notificationsEnabled: true,
      }),
    ).toBe(false);
  });

  it('suppresses miniapp headless agent completions (LoopX turns notify only at owner gates)', () => {
    expect(
      shouldSendDialogCompletionNotification({
        event: event(),
        session: session({
          sessionKind: 'miniapp',
        }),
        isBackground: true,
        notificationsEnabled: true,
      }),
    ).toBe(false);
  });

  it('suppresses notifications when the session is not available locally', () => {
    expect(
      shouldSendDialogCompletionNotification({
        event: event(),
        session: undefined,
        isBackground: true,
        notificationsEnabled: true,
      }),
    ).toBe(false);
  });

  it('allows final deep review completion notifications only in the background', () => {
    const deepReviewSession = session({
      sessionKind: 'deep_review',
      parentSessionId: 'parent-1',
    });

    expect(
      shouldSendDialogCompletionNotification({
        event: event(),
        session: deepReviewSession,
        isBackground: false,
        notificationsEnabled: true,
      }),
    ).toBe(false);

    expect(
      shouldSendDialogCompletionNotification({
        event: event(),
        session: deepReviewSession,
        isBackground: true,
        notificationsEnabled: true,
      }),
    ).toBe(true);
  });

  it('allows failed completion notifications in the background', () => {
    expect(
      shouldSendDialogCompletionNotification({
        event: event({
          success: false,
          finishReason: 'empty_round',
        }),
        session: session(),
        isBackground: true,
        notificationsEnabled: true,
      }),
    ).toBe(true);
  });
});

describe('buildDialogCompletionNotificationCopy', () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    if (key === 'notify.dialogCompletedTitle') return 'OpenBitFun finished a task';
    if (key === 'notify.dialogCompletedWithSession') {
      return `${options?.sessionTitle} is ready.`;
    }
    if (key === 'notify.dialogFailedTitle') return 'OpenBitFun task stopped';
    if (key === 'notify.dialogFailedWithSession') {
      return `${options?.sessionTitle} stopped unexpectedly.`;
    }
    return 'A OpenBitFun session is ready.';
  };

  it('uses a product title and a session-aware body', () => {
    expect(
      buildDialogCompletionNotificationCopy({
        sessionTitle: 'Deep Review',
        t,
      }),
    ).toEqual({
      title: 'OpenBitFun finished a task',
      body: 'Deep Review is ready.',
    });
  });

  it('does not expose fallback session ids in the system notification title', () => {
    expect(
      buildDialogCompletionNotificationCopy({
        sessionTitle: '',
        t,
      }),
    ).toEqual({
      title: 'OpenBitFun finished a task',
      body: 'A OpenBitFun session is ready.',
    });
  });

  it('uses failure copy when the backend completed with an unsuccessful result', () => {
    expect(
      buildDialogCompletionNotificationCopy({
        sessionTitle: 'Browser control fix',
        success: false,
        finishReason: 'empty_round',
        t,
      }),
    ).toEqual({
      title: 'OpenBitFun task stopped',
      body: 'Browser control fix stopped unexpectedly.',
    });
  });
});
