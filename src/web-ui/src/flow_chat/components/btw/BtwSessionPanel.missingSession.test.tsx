// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { BtwSessionPanel } from './BtwSessionPanel';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatState, Session } from '../../types/flow-chat';

const panelMocks = vi.hoisted(() => ({
  addExternalSession: vi.fn(),
  ensurePersistedSessionMetadata: vi.fn(async () => true),
  updateSessionRelationship: vi.fn(),
  clearSessionUnreadCompletion: vi.fn(),
  hydrateSessionHistoryForDetail: vi.fn(async () => undefined),
  findTabByMetadata: vi.fn(),
  closeTab: vi.fn(),
  cancelSessionTask: vi.fn(async () => true),
}));

let flowChatState: FlowChatState;
const storeListeners = new Set<(state: FlowChatState) => void>();

const translate = (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) =>
  options?.defaultValue ?? _key;

vi.mock('react-i18next', () => ({
  // The real i18n service is loaded by the auxiliary-pane service under test.
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({ t: translate }),
}));

vi.mock('./BtwVirtualSessionList', () => ({
  BtwVirtualSessionList: () => React.createElement('div', { 'data-testid': 'btw-virtual-session-list' }),
}));

vi.mock('../modern/useFlowGroupState', () => ({
  useFlowGroupState: () => ({
    groupStates: new Map(),
    groupReceiveFeedback: new Map(),
    expandedToolCapsules: new Set(),
    onToolCapsuleExpandedChange: vi.fn(),
    onGroupToggle: vi.fn(),
    onExpandGroup: vi.fn(),
    onExpandAllInTurn: vi.fn(),
    onCollapseGroup: vi.fn(),
  }),
}));

vi.mock('../modern/usePermissionRequests', () => ({
  usePermissionRequests: () => ({
    requests: [],
    activeBatch: undefined,
    ownedRequests: [],
    ownedActiveBatch: undefined,
    respond: vi.fn(),
    respondBatch: vi.fn(),
  }),
}));

vi.mock('../ChatInputApprovalBand', () => ({ ChatInputApprovalBand: () => null }));
vi.mock('@/flow_chat', () => ({ ScrollToBottomButton: () => null }));
vi.mock('./DeepReviewActionBar', () => ({ ReviewActionBar: () => null }));
vi.mock('@/shared/services/FileTabManager', () => ({ fileTabManager: { openFile: vi.fn() } }));
vi.mock('@/shared/utils/tabUtils', () => ({ createTab: vi.fn() }));
vi.mock('@/infrastructure/api', () => ({ agentAPI: { cancelSession: vi.fn() } }));
vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: vi.fn() } }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The auxiliary-pane service is exercised for real: this suite is about the pane
// healing its own tab, so only the canvas transport underneath it is stubbed.
vi.mock('@/app/components/panels/content-canvas/stores', () => ({
  switchAgentCanvasScope: vi.fn(),
  useAgentCanvasStore: {
    getState: () => ({
      findTabByMetadata: (...args: unknown[]) => panelMocks.findTabByMetadata(...args),
      closeTab: (...args: unknown[]) => panelMocks.closeTab(...args),
    }),
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
  sessionToVirtualItems: () => [],
}));

vi.mock('../../services/ReviewActionBarPersistenceService', () => ({
  loadPersistedReviewState: vi.fn(() => Promise.resolve(null)),
  persistReviewActionState: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => ({ getState: () => flowChatState, subscribe: () => () => {} }),
  },
  flowChatStore: {
    getState: () => flowChatState,
    retainSessionHistory: () => () => {},
    clearSessionUnreadCompletion: (...args: unknown[]) => panelMocks.clearSessionUnreadCompletion(...args),
    addExternalSession: (...args: unknown[]) => panelMocks.addExternalSession(...args),
    updateSessionRelationship: (...args: unknown[]) => panelMocks.updateSessionRelationship(...args),
    ensurePersistedSessionMetadata: (...args: unknown[]) =>
      panelMocks.ensurePersistedSessionMetadata(...args),
    subscribeSelector: <T,>(select: (state: FlowChatState) => T, notify: (selected: T) => void) => {
      let previous = select(flowChatState);
      const listener = (state: FlowChatState) => {
        const next = select(state);
        if (Object.is(previous, next)) return;
        previous = next;
        notify(next);
      };
      storeListeners.add(listener);
      return () => { storeListeners.delete(listener); };
    },
    subscribe: (listener: (state: FlowChatState) => void) => {
      storeListeners.add(listener);
      return () => { storeListeners.delete(listener); };
    },
  },
}));

function buildParentSession(): Session {
  return {
    sessionId: 'parent-session',
    title: 'Parent',
    dialogTurns: [],
    status: 'idle',
    workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
  } as Session;
}

function buildChildSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'missing-child',
    title: 'Child',
    dialogTurns: [{
      id: 'turn-1',
      sessionId: 'missing-child',
      userMessage: { id: 'user-1', content: 'work', timestamp: 1 },
      modelRounds: [],
      status: 'completed',
      startTime: 1,
    }],
    status: 'idle',
    workspaceId: 'workspace-id',
    config: { workspaceId: 'workspace-id' },
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    sessionKind: 'subagent',
    parentSessionId: 'parent-session',
    ...overrides,
  } as Session;
}

// The pane recovers from a passive effect, so its state updates land after the
// render that starts them. These tests await the rendered outcome instead of
// wrapping the whole load chain in act(), which that chain outlives.
describe('BtwSessionPanel child-session recovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  const sessions = () => flowChatState.sessions;

  const publishSessions = (next: Map<string, Session>) => {
    flowChatState = { ...flowChatState, sessions: next } as FlowChatState;
    Array.from(storeListeners).forEach(listener => listener(flowChatState));
  };

  const view = () => container
    .querySelector('[data-openbitfun-component="btw-session-panel"][data-openbitfun-part="root"]')
    ?.getAttribute('data-openbitfun-view');

  const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

  const flush = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  const waitForView = async (expected: string) => {
    await vi.waitFor(() => expect(view()).toBe(expected));
  };

  const renderPanel = async (props: Partial<React.ComponentProps<typeof BtwSessionPanel>> = {}) => {
    root.render(
      <BtwSessionPanel
        childSessionId="missing-child"
        parentSessionId="parent-session"
        workspaceId="workspace-id"
        workspacePath="D:/workspace/project"
        {...props}
      />,
    );
    await flush();
  };

  beforeEach(() => {
    activateSurface('local');
    storeListeners.clear();
    panelMocks.addExternalSession.mockReset();
    panelMocks.addExternalSession.mockImplementation(
      (sessionId: string, title: string, _mode: string, workspacePath: string, meta?: Record<string, unknown>) => {
        // Mirrors FlowChatStore.addExternalSession: the shell is created before
        // its history is read, and it is a record with no turns.
        publishSessions(new Map(sessions()).set(sessionId, buildChildSession({
          sessionId,
          title,
          workspacePath,
          workspaceId: meta?.workspaceId as string | undefined,
          sessionKind: (meta?.sessionKind as Session['sessionKind']) ?? 'btw',
          parentSessionId: meta?.parentSessionId as string | undefined,
          dialogTurns: [],
          historyState: 'new',
          isHistorical: false,
        })));
      },
    );
    panelMocks.ensurePersistedSessionMetadata.mockReset();
    panelMocks.ensurePersistedSessionMetadata.mockImplementation(async () => true);
    panelMocks.updateSessionRelationship.mockClear();
    panelMocks.clearSessionUnreadCompletion.mockReset();
    panelMocks.hydrateSessionHistoryForDetail.mockReset();
    panelMocks.hydrateSessionHistoryForDetail.mockResolvedValue(undefined);
    panelMocks.findTabByMetadata.mockReset();
    panelMocks.findTabByMetadata.mockReturnValue({
      tab: { id: 'child-tab' },
      groupId: 'primary',
    });
    panelMocks.closeTab.mockReset();
    panelMocks.cancelSessionTask.mockClear();

    flowChatState = {
      sessions: new Map([['parent-session', buildParentSession()]]),
      activeSessionId: 'parent-session',
    } as FlowChatState;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(async () => {
    root.unmount();
    container.remove();
    await flush();
    vi.restoreAllMocks();
  });

  it('offers a retry and a close action instead of the generic empty copy', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel();
    await waitForView('unavailable');

    expect(container.textContent).toContain('btw.unavailableThreadLabel');
    expect(container.textContent).not.toContain('btw.emptyThreadLabel');
    expect(button('btw-session-panel-retry')).not.toBeNull();
    expect(button('btw-session-panel-close-tab')).not.toBeNull();
    expect(panelMocks.addExternalSession).toHaveBeenCalledTimes(1);
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('missing-child');
  });

  it('shows a loading state while the missing record is being reloaded', async () => {
    let failLoad!: (error: Error) => void;
    panelMocks.hydrateSessionHistoryForDetail.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { failLoad = reject; }),
    );

    await renderPanel();

    expect(view()).toBe('loading');
    expect(container.textContent).toContain('btw.loadingThreadLabel');
    expect(button('btw-session-panel-retry')).toBeNull();

    failLoad(new Error('child session is gone'));
    await waitForView('unavailable');
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);
  });

  it('recreates the record and reads its history when the tab has none', async () => {
    let failLoad!: (error: Error) => void;
    panelMocks.hydrateSessionHistoryForDetail.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { failLoad = reject; }),
    );

    await renderPanel();
    await vi.waitFor(() => expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1));

    expect(panelMocks.addExternalSession).toHaveBeenCalledTimes(1);
    expect(panelMocks.addExternalSession).toHaveBeenCalledWith(
      'missing-child',
      expect.any(String),
      expect.any(String),
      'D:/workspace/project',
      expect.objectContaining({
        parentSessionId: 'parent-session',
        workspaceId: 'workspace-id',
      }),
      undefined,
      undefined,
    );

    failLoad(new Error('child session is gone'));
    await waitForView('unavailable');
  });

  it('recreates a missing subagent child with the identity its tab recorded', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel({
      sessionKind: 'subagent',
      sessionTitle: 'Subagent: verify the pane',
      parentToolCallId: 'task-call-1',
      subagentType: 'Explore',
    });
    await waitForView('unavailable');

    // Without the identity the heal rebuilds a plain side thread, and the history
    // read loses the internal turns a subagent restores.
    expect(panelMocks.addExternalSession).toHaveBeenCalledWith(
      'missing-child',
      'Subagent: verify the pane',
      expect.any(String),
      'D:/workspace/project',
      expect.objectContaining({
        parentSessionId: 'parent-session',
        sessionKind: 'subagent',
        parentToolCallId: 'task-call-1',
        subagentType: 'Explore',
      }),
      undefined,
      undefined,
    );
    expect(sessions().get('missing-child')?.sessionKind).toBe('subagent');
  });

  it('explains the state without dead controls on a pane with no parent and no tab', async () => {
    // What the MiniApp customize chat renders: a child id, no parent, and no
    // canvas tab holding it. Nothing there can be reloaded, and there is no tab
    // to close, so the pane must not offer controls that do nothing.
    panelMocks.findTabByMetadata.mockReturnValue(null);

    await renderPanel({ parentSessionId: undefined });

    expect(view()).toBe('unavailable');
    expect(container.textContent).toContain('btw.unavailableThreadLabel');
    expect(container.textContent).not.toContain('btw.loadingThreadLabel');
    expect(button('btw-session-panel-retry')).toBeNull();
    expect(button('btw-session-panel-close-tab')).toBeNull();
    expect(panelMocks.addExternalSession).not.toHaveBeenCalled();
    expect(panelMocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
  });

  it('never arms a load at settle time when the pane lost the parent it needed', async () => {
    let failLoad!: (error: Error) => void;
    panelMocks.hydrateSessionHistoryForDetail.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { failLoad = reject; }),
    );

    // The heal is armed and its load is in flight.
    await renderPanel();
    await vi.waitFor(() => expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1));
    expect(view()).toBe('loading');

    // The record is removed while the load runs, and the parent id goes away, so
    // no new attempt could be started at all. No production path drops the parent
    // of a mounted pane today; the host simply stops passing it.
    const withoutChild = new Map(sessions());
    withoutChild.delete('missing-child');
    publishSessions(withoutChild);
    await renderPanel({ parentSessionId: undefined });
    expect(view()).toBe('unavailable');

    // The in-flight load settles late: it may not arm an attempt nothing starts,
    // or the pane would sit on 「loading」 with no way back.
    failLoad(new Error('child session is gone'));
    await flush();
    await flush();
    publishSessions(new Map(sessions()));
    await flush();

    expect(view()).toBe('unavailable');
    expect(container.textContent).toContain('btw.unavailableThreadLabel');
    expect(container.textContent).not.toContain('btw.loadingThreadLabel');
    // The tab it is mounted in can still be closed; reloading needs a parent.
    expect(button('btw-session-panel-close-tab')).not.toBeNull();
    expect(button('btw-session-panel-retry')).toBeNull();
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);
  });

  it('never leaves the settle-time clamp armed when the record comes back as a shell', async () => {
    let failLoad!: (error: Error) => void;
    panelMocks.hydrateSessionHistoryForDetail.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { failLoad = reject; }),
    );

    await renderPanel();
    await vi.waitFor(() => expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1));

    // The record goes away and so does the parent id: the effect releases the
    // attempt and the pane explains the state rather than loading.
    const withoutChild = new Map(sessions());
    withoutChild.delete('missing-child');
    publishSessions(withoutChild);
    await renderPanel({ parentSessionId: undefined });
    expect(view()).toBe('unavailable');

    // The parent id returns while the pane is not showing: the effect returns
    // before it can start anything, but the host has already told the pane which
    // parent it has. That is the only shape in which a settle can face a pane
    // that could start an attempt — the clamp branch.
    await renderPanel({ parentSessionId: 'parent-session', isActive: false });
    failLoad(new Error('child session is gone'));
    await flush();

    // A failed heal leaves a contentless shell behind. The clamped arm must have
    // been released: claiming a load here would strand the pane on the loading
    // copy with no retry, which is the dead end this suite exists for.
    publishSessions(new Map(sessions()).set(
      'missing-child',
      buildChildSession({ dialogTurns: [], historyState: 'failed' }),
    ));
    await renderPanel({ parentSessionId: 'parent-session', isActive: true });

    await waitForView('unavailable');
    expect(container.textContent).not.toContain('btw.loadingThreadLabel');
    expect(button('btw-session-panel-retry')).not.toBeNull();
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);

    // Retrying is what runs a load again.
    button('btw-session-panel-retry')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(2);
  });

  it('does not start a load for an inactive tab and heals when it is shown', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel({ isActive: false });
    expect(panelMocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
    expect(panelMocks.addExternalSession).not.toHaveBeenCalled();
    expect(storeListeners.size).toBe(0);

    await renderPanel({ isActive: true });
    await waitForView('unavailable');
    expect(panelMocks.addExternalSession).toHaveBeenCalledTimes(1);
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);
  });

  it('attempts the load once and never loops on re-renders or store updates', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel();
    await waitForView('unavailable');
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);

    await renderPanel();
    await renderPanel();
    publishSessions(new Map(sessions()).set('parent-session', {
      ...buildParentSession(),
      title: 'Parent renamed',
    }));
    await flush();

    expect(view()).toBe('unavailable');
    expect(panelMocks.addExternalSession).toHaveBeenCalledTimes(1);
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);
  });

  it('reloads exactly once more when the operator retries', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel();
    await waitForView('unavailable');
    panelMocks.addExternalSession.mockClear();
    panelMocks.hydrateSessionHistoryForDetail.mockClear();

    button('btw-session-panel-retry')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1));
    await waitForView('unavailable');

    // The failed heal left a record with no turns, so the retry reads its
    // history instead of recreating the record.
    expect(panelMocks.addExternalSession).not.toHaveBeenCalled();
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('missing-child');
    expect(panelMocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1);
  });

  it('closes the tab through the auxiliary pane service', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel();
    await waitForView('unavailable');

    button('btw-session-panel-close-tab')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(panelMocks.findTabByMetadata).toHaveBeenCalledWith({
      duplicateCheckKey: 'btw-session-missing-child',
    });
    expect(panelMocks.closeTab).toHaveBeenCalledWith('child-tab', 'primary', { forceRemove: true });
  });

  it('renders the restored child session and drops the recovery actions', async () => {
    panelMocks.hydrateSessionHistoryForDetail.mockRejectedValue(new Error('child session is gone'));

    await renderPanel();
    await waitForView('unavailable');

    publishSessions(new Map(sessions()).set('missing-child', buildChildSession()));
    await waitForView('session');

    expect(button('btw-session-panel-retry')).toBeNull();
    expect(container.textContent).not.toContain('btw.unavailableThreadLabel');
  });

  it('leaves the ordinary path alone when the record is already loaded', async () => {
    publishSessions(new Map(sessions()).set('missing-child', buildChildSession()));
    panelMocks.hydrateSessionHistoryForDetail.mockClear();

    await renderPanel();

    expect(view()).toBe('session');
    expect(panelMocks.addExternalSession).not.toHaveBeenCalled();
    expect(panelMocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('btw.unavailableThreadLabel');
  });
});
