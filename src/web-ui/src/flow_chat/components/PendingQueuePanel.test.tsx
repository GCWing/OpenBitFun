/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
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
  items: [] as Array<Record<string, unknown>>,
}));

const queuedItem = {
  id: 'queued-1',
  sessionId: 'session-1',
  content: 'steer this turn',
  timestamp: 1,
  status: 'queued',
  retryCount: 0,
  imageContexts: [{ id: 'image-1' }, { id: 'image-2' }, { id: 'image-3' }],
  imageDisplayData: [{ id: 'image-1' }, { id: 'image-2' }, { id: 'image-3' }],
};

vi.mock('../services/hostDialogQueue', () => ({ hostQueueSupported: () => false }));
vi.mock('./HostPendingQueuePanel', () => ({ HostPendingQueuePanel: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

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
    list: () => mocks.items,
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

async function selectQueueMenuAction(container: HTMLElement, action: 'edit' | 'collapse') {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="pendingQueue.actions.more"]')!.click());
  const item = document.querySelector<HTMLButtonElement>(`[role="menu"]:not([aria-hidden="true"]) [data-menu-id="${action}"]`);
  expect(item).not.toBeNull();
  await act(async () => item!.click());
}

describe('PendingQueuePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.drainPendingQueueForSession.mockResolvedValue(undefined);
    mocks.items = [queuedItem];
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

    expect(container.querySelector('[data-openbitfun-part="header"]')).toBeNull();
    expect(container.querySelector('[data-queue-handle]')?.getAttribute('title')).toBeNull();
    const attachmentBadge = container.querySelector('[data-openbitfun-part="attachmentCount"]');

    expect(attachmentBadge?.textContent).toBe('3');
    const messageLine = attachmentBadge?.closest('[data-openbitfun-part="message"]');
    expect(messageLine?.querySelector('[data-openbitfun-product-part="preview"]')?.textContent).toBe('steer this turn');
    expect(attachmentBadge?.previousElementSibling?.getAttribute('data-openbitfun-product-part')).toBe('preview');
    expect(attachmentBadge?.getAttribute('role')).toBe('img');
    expect(attachmentBadge?.getAttribute('aria-label')).toBe('pendingQueue.attachmentCount');
    await selectQueueMenuAction(container, 'collapse');
    expect(container.querySelector('[data-openbitfun-part="title"]')?.textContent).toBe('pendingQueue.title1');
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
    // A tab stop so the overflow tooltip can follow keyboard focus.
    expect(preview?.tabIndex).toBe(0);

    act(() => {
      preview!.focus();
      preview!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      preview!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      preview!.click();
    });
    expect(document.activeElement).toBe(preview);

    expect(onRestoreToComposer).not.toHaveBeenCalled();
    expect(mocks.queueRemove).not.toHaveBeenCalled();
  });

  it('returns focus to more actions on Escape without changing the draft', async () => {
    const onRestoreToComposer = vi.fn(() => true);
    await act(async () => root.render(
      <PendingQueuePanel sessionId="session-1" onRestoreToComposer={onRestoreToComposer} />,
    ));
    const more = container.querySelector<HTMLButtonElement>('[aria-label="pendingQueue.actions.more"]')!;
    await act(async () => { more.focus(); more.click(); });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const menu = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.querySelector('[data-menu-id="edit"]')?.textContent).toBe('pendingQueue.actions.edit');
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
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

    await selectQueueMenuAction(container, 'edit');

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

    await selectQueueMenuAction(container, 'edit');

    expect(onRestoreToComposer).toHaveBeenCalledTimes(1);
    expect(mocks.queueRemove).not.toHaveBeenCalled();
  });

  it('collapses the controlled list and keeps failed rows in a recovery list', async () => {
    mocks.items = [
      queuedItem,
      { id: 'failed-1', sessionId: 'session-1', content: 'retry me', timestamp: 2, status: 'failed', retryCount: 1 },
    ];
    await act(async () => {
      root.render(<PendingQueuePanel sessionId="session-1" onRestoreToComposer={() => true} />);
    });

    const controlled = container.querySelector<HTMLUListElement>('ul')!;
    const count = () => container.querySelector('[data-openbitfun-part="totalCount"]')?.textContent;
    expect(controlled.hidden).toBe(false);
    expect([...controlled.querySelectorAll('li')].map(row => row.textContent)).toEqual([
      expect.stringContaining('steer this turn'), expect.stringContaining('retry me'),
    ]);
    await selectQueueMenuAction(container, 'collapse');
    const toggle = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="header"] button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(controlled.id);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(controlled.hidden).toBe(true);
    expect(controlled.querySelectorAll('li')).toHaveLength(0);
    expect(count()).toBe('2');
    const recovery = [...container.querySelectorAll('ul')].filter(list => list !== controlled);
    expect(recovery).toHaveLength(1);
    const rows = recovery[0].querySelectorAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('retry me');
    expect(rows[0].textContent).toContain('pendingQueue.statusFailed');
    expect(rows[0].querySelector('button[aria-label="pendingQueue.actions.delete"]')).not.toBeNull();
    expect(container.textContent).not.toContain('steer this turn');

    act(() => toggle.click());
    expect(controlled.hidden).toBe(false);
    expect(controlled.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(document.activeElement).toBe(controlled.querySelector('[data-openbitfun-product-part="preview"]'));
    expect(container.querySelector('[data-openbitfun-part="header"]')).toBeNull();
  });

  it('shows a retried item that is sending again as sending, not failed', async () => {
    mocks.items = [
      { id: 'retry-1', sessionId: 'session-1', content: 'second attempt', timestamp: 2, status: 'sending', retryCount: 1 },
    ];
    await act(async () => {
      root.render(<PendingQueuePanel sessionId="session-1" onRestoreToComposer={() => true} />);
    });

    const row = container.querySelector('li')!;
    expect(row.getAttribute('data-openbitfun-state')).toBe('sending');
    expect(row.textContent).toContain('pendingQueue.statusQueuedSending');
    expect(row.querySelector('[data-openbitfun-part="message"] [data-openbitfun-part="status"]')).toBeNull();
    expect(row.textContent).not.toContain('pendingQueue.statusFailed');
    expect(row.querySelector('[data-openbitfun-tone="danger"]')).toBeNull();
    expect(row.querySelector<HTMLButtonElement>('[aria-label="pendingQueue.actions.sendNow"]')?.disabled).toBe(true);
    expect(row.querySelector<HTMLButtonElement>('[aria-label="pendingQueue.actions.delete"]')?.disabled).toBe(true);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="pendingQueue.actions.more"]')!.click());
    const edit = document.querySelector<HTMLButtonElement>('[role="menu"]:not([aria-hidden="true"]) [data-menu-id="edit"]')!;
    expect(edit.disabled).toBe(true);
    await act(async () => edit.click());
    expect(mocks.queueRemove).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));


    await selectQueueMenuAction(container, 'collapse');
    expect(container.textContent).not.toContain('second attempt');
  });
});
