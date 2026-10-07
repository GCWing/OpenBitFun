/**
 * @vitest-environment jsdom
 */

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PendingQueuePanel } from './PendingQueuePanel';

const mocks = vi.hoisted(() => ({
  drainPendingQueueForSession: vi.fn(),
  insertSteeringItemIfAbsent: vi.fn(),
  promoteForExplicitDrain: vi.fn(() => true),
  queueRemove: vi.fn(),
  queueSetStatus: vi.fn(),
  steerDialogTurn: vi.fn(),
}));

vi.mock('../services/hostDialogQueue', () => ({ hostQueueSupported: () => false }));
vi.mock('./HostPendingQueuePanel', () => ({ HostPendingQueuePanel: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@openbitfun/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-openbitfun-component="icon" data-openbitfun-name={name} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  IconButton: ({ icon, loading: _loading, size: _size, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: ReactNode;
    loading?: boolean;
    size?: string;
    variant?: string;
  }) => <button {...props}>{icon}</button>,
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: { steerDialogTurn: mocks.steerDialogTurn },
}));

vi.mock('../state-machine', () => ({
  stateMachineManager: {
    get: () => ({
      getContext: () => ({ currentDialogTurnId: 'turn-1' }),
    }),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => ({
      getState: () => ({ sessions: new Map() }),
      subscribe: () => () => undefined,
    }),
  },
}));

vi.mock('../services/flow-chat-manager/PendingQueueModule', () => ({
  pendingQueueManager: {
    list: () => [
      {
        id: 'queued-1',
        sessionId: 'session-1',
        content: 'steer this turn',
        timestamp: 1,
        status: 'queued',
        retryCount: 0,
        imageContexts: [{ id: 'image-1' }, { id: 'image-2' }, { id: 'image-3' }],
        imageDisplayData: [{ id: 'image-1' }, { id: 'image-2' }, { id: 'image-3' }],
      },
    ],
    subscribe: () => () => undefined,
    setStatus: mocks.queueSetStatus,
    remove: mocks.queueRemove,
    promoteForExplicitDrain: mocks.promoteForExplicitDrain,
  },
}));

vi.mock('../services/FlowChatManager', () => ({
  FlowChatManager: {
    getInstance: () => ({
      drainPendingQueueForSession: mocks.drainPendingQueueForSession,
    }),
  },
}));

vi.mock('../services/interruptedTurnRecoveryGate', () => ({
  interruptedTurnRecoveryGate: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    isSessionInFlight: () => false,
  },
}));

vi.mock('../services/flow-chat-manager/EventHandlerModule', () => ({
  insertSteeringItemIfAbsent: mocks.insertSteeringItemIfAbsent,
}));

vi.mock('../../shared/notification-system', () => ({
  notificationService: {
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../utils/acpSession', () => ({
  isAcpFlowSession: () => false,
}));

describe('PendingQueuePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.drainPendingQueueForSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows the queue total separately from the current message attachment count', async () => {
    await act(async () => {
      root.render(
        <PendingQueuePanel
          sessionId="session-1"
          onRestoreToComposer={() => true}
        />,
      );
    });

    const title = container.querySelector('[data-openbitfun-part="title"]');
    const attachmentBadge = container.querySelector('[data-openbitfun-part="attachmentCount"]');

    expect(title?.textContent).toBe('pendingQueue.title1');
    expect(attachmentBadge?.textContent).toBe('3');
    expect(attachmentBadge?.getAttribute('aria-label')).toBe('pendingQueue.attachmentCount');
  });

  it('submits only one steering request while send-now is in flight', async () => {
    let resolveSteering: ((value: { success: boolean; steeringId: string }) => void) | undefined;
    mocks.steerDialogTurn.mockImplementation(
      () => new Promise(resolve => {
        resolveSteering = resolve;
      }),
    );

    await act(async () => {
      root.render(
        <PendingQueuePanel
          sessionId="session-1"
          onRestoreToComposer={() => true}
        />,
      );
    });
    const sendNowButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="pendingQueue.actions.sendNow"]',
    );
    expect(sendNowButton).not.toBeNull();

    act(() => {
      sendNowButton!.click();
      sendNowButton!.click();
    });

    expect(mocks.steerDialogTurn).toHaveBeenCalledTimes(1);
    expect(mocks.queueSetStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSteering?.({ success: true, steeringId: 'steering-1' });
      await Promise.resolve();
    });
  });

  it('keeps the message item display-only', async () => {
    const onRestoreToComposer = vi.fn(() => true);
    await act(async () => {
      root.render(
        <PendingQueuePanel
          sessionId="session-1"
          onRestoreToComposer={onRestoreToComposer}
        />,
      );
    });

    const preview = container.querySelector<HTMLElement>(
      '.openbitfun-pending-queue-panel__preview',
    );
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute('role')).toBeNull();
    expect(preview?.getAttribute('tabindex')).toBeNull();

    act(() => preview!.click());

    expect(onRestoreToComposer).not.toHaveBeenCalled();
    expect(mocks.queueRemove).not.toHaveBeenCalled();
  });

  it('restores from the edit action and removes only an accepted draft', async () => {
    const onRestoreToComposer = vi.fn(() => true);
    await act(async () => {
      root.render(
        <PendingQueuePanel
          sessionId="session-1"
          onRestoreToComposer={onRestoreToComposer}
        />,
      );
    });

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="pendingQueue.actions.edit"]',
    );
    expect(editButton).not.toBeNull();

    act(() => editButton!.click());

    expect(onRestoreToComposer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'queued-1',
      content: 'steer this turn',
    }));
    expect(mocks.queueRemove).toHaveBeenCalledWith('session-1', 'queued-1');
  });

  it('keeps the queued item when ChatInput rejects restoration', async () => {
    const onRestoreToComposer = vi.fn(() => false);
    await act(async () => {
      root.render(
        <PendingQueuePanel
          sessionId="session-1"
          onRestoreToComposer={onRestoreToComposer}
        />,
      );
    });

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="pendingQueue.actions.edit"]',
    );
    act(() => editButton!.click());

    expect(onRestoreToComposer).toHaveBeenCalledTimes(1);
    expect(mocks.queueRemove).not.toHaveBeenCalled();
  });
});
