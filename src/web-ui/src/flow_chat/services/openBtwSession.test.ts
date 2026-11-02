import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBtwSessionAvailable, openBtwSessionInAuxPane } from './btwSessionPane';
import { openMainSession } from './sessionActivation';

const mocks = vi.hoisted(() => ({
  addTab: vi.fn(),
  switchAgentCanvasScope: vi.fn(),
  expandSessionAuxPane: vi.fn(),
  clearSessionUnreadCompletion: vi.fn(),
  findTabByMetadata: vi.fn(),
  updateTabContent: vi.fn(),
  switchToTab: vi.fn(),
  closeTab: vi.fn(),
  addExternalSession: vi.fn(),
  ensurePersistedSessionMetadata: vi.fn(),
  hydrateSessionHistoryForDetail: vi.fn(() => Promise.resolve()),
  updateSessionRelationship: vi.fn(),
  switchChatSession: vi.fn(),
  syncSessionToModernStore: vi.fn(),
  updateLayout: vi.fn(),
  openScene: vi.fn(),
}));

let animationFrameCallbacks: FrameRequestCallback[] = [];
let sessions = new Map();
let activeSessionId: string | null = null;

const stubWindowForPanelExpansion = (rightPanelCollapsed: boolean) => {
  const dispatchEvent = vi.fn();
  class TestCustomEvent {
    readonly type: string;
    readonly detail?: unknown;

    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  }

  vi.stubGlobal('window', {
    CustomEvent: TestCustomEvent,
    dispatchEvent,
    __OPENBITFUN_LAYOUT_STATE__: { rightPanelCollapsed },
  });

  return dispatchEvent;
};

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? 'Side thread',
  },
}));

vi.mock('@/app/services/AppManager', () => ({
  appManager: {
    updateLayout: (...args: unknown[]) => mocks.updateLayout(...args),
  },
}));

vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: {
    getState: () => ({
      openScene: (...args: unknown[]) => mocks.openScene(...args),
    }),
  },
}));

vi.mock('@/app/scenes/session/sessionPanelLayout', () => ({
  expandSessionAuxPane: (...args: unknown[]) => mocks.expandSessionAuxPane(...args),
}));

vi.mock('@/app/components/panels/content-canvas/stores', () => ({
  switchAgentCanvasScope: (...args: unknown[]) => mocks.switchAgentCanvasScope(...args),
  useAgentCanvasStore: {
    getState: () => ({
      activeGroupId: 'primary',
      primaryGroup: { activeTabId: null, tabs: [] },
      secondaryGroup: { activeTabId: null, tabs: [] },
      tertiaryGroup: { activeTabId: null, tabs: [] },
      addTab: (...args: unknown[]) => mocks.addTab(...args),
      findTabByMetadata: (...args: unknown[]) => mocks.findTabByMetadata(...args),
      updateTabContent: (...args: unknown[]) => mocks.updateTabContent(...args),
      switchToTab: (...args: unknown[]) => mocks.switchToTab(...args),
      closeTab: (...args: unknown[]) => mocks.closeTab(...args),
    }),
  },
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({
      sessions,
      activeSessionId,
    }),
    ensurePersistedSessionMetadata: (...args: unknown[]) => mocks.ensurePersistedSessionMetadata(...args),
    addExternalSession: (...args: unknown[]) =>
      mocks.addExternalSession(...args),
    updateSessionRelationship: (...args: unknown[]) =>
      mocks.updateSessionRelationship(...args),
    clearSessionUnreadCompletion: (...args: unknown[]) =>
      mocks.clearSessionUnreadCompletion(...args),
  },
}));

vi.mock('./FlowChatManager', () => ({
  flowChatManager: {
    switchChatSession: (...args: unknown[]) => mocks.switchChatSession(...args),
    hydrateSessionHistoryForDetail: (...args: unknown[]) =>
      mocks.hydrateSessionHistoryForDetail(...args),
  },
}));

vi.mock('./storeSync', () => ({
  syncSessionToModernStore: (...args: unknown[]) => mocks.syncSessionToModernStore(...args),
}));

describe('openBtwSessionInAuxPane', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    animationFrameCallbacks = [];
    mocks.addTab.mockClear();
    mocks.switchAgentCanvasScope.mockClear();
    mocks.expandSessionAuxPane.mockClear();
    mocks.clearSessionUnreadCompletion.mockClear();
    mocks.findTabByMetadata.mockReset();
    mocks.updateTabContent.mockClear();
    mocks.switchToTab.mockClear();
    mocks.closeTab.mockClear();
    mocks.addExternalSession.mockClear();
    mocks.ensurePersistedSessionMetadata.mockReset();
    mocks.ensurePersistedSessionMetadata.mockImplementation(async (sessionId: string) => {
      sessions.set(sessionId, { ...sessions.get(sessionId), sessionId, workspaceId: 'child-worktree-id', config: {} });
      return true;
    });
    mocks.hydrateSessionHistoryForDetail.mockClear();
    mocks.updateSessionRelationship.mockClear();
    mocks.switchChatSession.mockReset();
    mocks.syncSessionToModernStore.mockClear();
    mocks.updateLayout.mockClear();
    mocks.openScene.mockClear();
    sessions = new Map();
    activeSessionId = 'parent-session';
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the child session unread until its result is actually visible', () => {
    openBtwSessionInAuxPane({
      childSessionId: 'review-child',
      parentSessionId: 'parent-session',
      workspacePath: 'D:\\workspace\\repo',
      expand: false,
    });

    expect(mocks.addTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'btw-session',
        data: expect.objectContaining({
          childSessionId: 'review-child',
          parentSessionId: 'parent-session',
        }),
      }),
      'active',
    );

    expect(mocks.clearSessionUnreadCompletion).not.toHaveBeenCalled();
    expect(animationFrameCallbacks).toHaveLength(0);
  });

  it('carries Review-check presentation without changing the child session kind', () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'DeepReview',
    });

    openBtwSessionInAuxPane({
      childSessionId: 'review-check-child',
      parentSessionId: 'parent-session',
      workspacePath: 'D:\\workspace\\repo',
      sessionKind: 'subagent',
      viewKind: 'review-check',
      includeInternal: true,
      expand: false,
    });

    expect(mocks.addTab).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          childSessionId: 'review-check-child',
          viewKind: 'review-check',
        }),
      }),
      'active',
    );
    expect(mocks.addExternalSession).toHaveBeenCalledWith(
      'review-check-child',
      expect.any(String),
      'DeepReview',
      'D:\\workspace\\repo',
      expect.objectContaining({ sessionKind: 'subagent' }),
      undefined,
      undefined,
    );
  });

  it('switches to an existing aux pane tab and asks its layout owner to reveal it', () => {
    stubWindowForPanelExpansion(false);
    mocks.findTabByMetadata.mockReturnValue({
      tab: { id: 'existing-review-tab' },
      groupId: 'secondary',
    });

    openBtwSessionInAuxPane({
      childSessionId: 'review-child',
      parentSessionId: 'parent-session',
      workspacePath: 'D:\\workspace\\repo',
      viewKind: 'review-check',
      sessionTitle: 'Checking authentication',
    });

    expect(mocks.findTabByMetadata).toHaveBeenCalledWith({
      duplicateCheckKey: 'btw-session-review-child',
    });
    expect(mocks.updateTabContent).toHaveBeenCalledWith(
      'existing-review-tab',
      'secondary',
      expect.objectContaining({
        data: expect.objectContaining({
          viewKind: 'review-check',
          displayTitle: 'Checking authentication',
        }),
      }),
    );
    expect(mocks.switchToTab).toHaveBeenCalledWith('existing-review-tab', 'secondary');
    expect(mocks.addTab).not.toHaveBeenCalled();
    expect(mocks.switchAgentCanvasScope).toHaveBeenCalledWith('parent-session');
    expect(mocks.expandSessionAuxPane).toHaveBeenCalledOnce();
  });

  it('reveals an existing aux pane tab when collapsed', () => {
    stubWindowForPanelExpansion(true);
    mocks.findTabByMetadata.mockReturnValue({
      tab: { id: 'existing-review-tab' },
      groupId: 'secondary',
    });

    openBtwSessionInAuxPane({
      childSessionId: 'review-child',
      parentSessionId: 'parent-session',
      workspacePath: 'D:\\workspace\\repo',
    });

    expect(mocks.switchToTab).toHaveBeenCalledWith('existing-review-tab', 'secondary');
    expect(mocks.addTab).not.toHaveBeenCalled();
    expect(mocks.expandSessionAuxPane).toHaveBeenCalledOnce();
  });

  it('hydrates incomplete live subagent history when explicitly opening the aux pane', async () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
    });
    sessions.set('subagent-child', {
      sessionId: 'subagent-child',
      workspaceId: 'child-worktree-id',
      sessionKind: 'subagent',
      isHistorical: false,
      historyState: 'ready',
      config: { agentType: 'Explore' },
      workspacePath: 'D:\\workspace\\repo',
      dialogTurns: [
        {
          id: 'post-restart-turn',
          status: 'processing',
          modelRounds: [],
          userMessage: { id: 'user-1', type: 'user', content: 'continue', timestamp: 1 },
          timestamp: 1,
        },
      ],
    });

    openBtwSessionInAuxPane({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
      expand: false,
    });

    await vi.waitFor(() => expect(mocks.hydrateSessionHistoryForDetail).toHaveBeenCalledTimes(1));
    expect(mocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('subagent-child');
  });

  it('does not rehydrate a subagent whose complete history is proven by counts', () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
    });
    sessions.set('subagent-child', {
      sessionId: 'subagent-child',
      workspaceId: 'child-worktree-id',
      sessionKind: 'subagent',
      isHistorical: false,
      historyState: 'ready',
      isPartial: false,
      loadedTurnCount: 2,
      totalTurnCount: 2,
      config: { agentType: 'Explore', modelName: 'model-1' },
      workspacePath: 'D:\\workspace\\repo',
      dialogTurns: [{ id: 'turn-1' }, { id: 'turn-2' }],
    });

    openBtwSessionInAuxPane({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
      expand: false,
    });

    expect(mocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
  });

  it('creates an on-demand subagent shell and reads its own binding before hydration', async () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    });

    ensureBtwSessionAvailable({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
      parentToolCallId: 'call-1',
      includeInternal: true,
    });

    expect(mocks.addExternalSession).toHaveBeenCalledWith(
      'subagent-child',
      expect.any(String),
      'Standard',
      'D:\\workspace\\repo',
      expect.objectContaining({
        parentSessionId: 'parent-session',
        sessionKind: 'subagent',
        parentToolCallId: 'call-1',
      }),
      'remote-1',
      'host-1',
    );
    await vi.waitFor(() => expect(mocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('subagent-child'));
    expect(mocks.ensurePersistedSessionMetadata).toHaveBeenCalledWith('subagent-child', 'project-id');
    expect(sessions.get('subagent-child').workspaceId).toBe('child-worktree-id');
  });

  it('hydrates an existing metadata-only hidden child session without creating a duplicate shell', async () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    });
    sessions.set('subagent-child', {
      sessionId: 'subagent-child',
      workspaceId: 'child-worktree-id',
      sessionKind: 'subagent',
      isHistorical: true,
      historyState: 'metadata-only',
      workspacePath: 'D:\\workspace\\repo',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    });

    ensureBtwSessionAvailable({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
      parentToolCallId: 'call-1',
      includeInternal: true,
    });

    expect(mocks.addExternalSession).not.toHaveBeenCalled();
    expect(mocks.updateSessionRelationship).toHaveBeenCalledWith(
      'subagent-child',
      expect.objectContaining({
        parentSessionId: 'parent-session',
        sessionKind: 'subagent',
        parentToolCallId: 'call-1',
      }),
    );
    await vi.waitFor(() => expect(mocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('subagent-child'));
  });

  it('reads a legacy child binding through the parent project ID without inheriting its execution ID', async () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
      remoteConnectionId: 'remote-current',
      remoteSshHost: 'host-current',
    });
    sessions.set('subagent-child', {
      sessionId: 'subagent-child',
      workspaceId: undefined,
      sessionKind: 'subagent',
      isHistorical: true,
      historyState: 'metadata-only',
    });

    ensureBtwSessionAvailable({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
    });

    await vi.waitFor(() => expect(mocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('subagent-child'));
    expect(mocks.ensurePersistedSessionMetadata).toHaveBeenCalledWith('subagent-child', 'project-id');
    expect(sessions.get('subagent-child').workspaceId).toBe('child-worktree-id');
  });

  it('hydrates an existing subagent shell when its model selection is missing', async () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    });
    sessions.set('subagent-child', {
      sessionId: 'subagent-child',
      workspaceId: 'child-worktree-id',
      sessionKind: 'subagent',
      isHistorical: false,
      historyState: 'new',
      config: { agentType: 'Explore' },
      workspacePath: 'D:\\workspace\\repo',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    });

    ensureBtwSessionAvailable({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
      parentToolCallId: 'call-1',
      includeInternal: true,
    });

    expect(mocks.addExternalSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('subagent-child'));
  });

  it('does not hydrate an existing live subagent with in-memory turns just to fill missing model selection', () => {
    sessions.set('parent-session', {
      sessionId: 'parent-session',
      workspaceId: 'parent-workspace-id',
      projectWorkspaceId: 'project-id',
      workspacePath: 'D:\\workspace\\repo',
      mode: 'Standard',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
    });
    sessions.set('subagent-child', {
      sessionId: 'subagent-child',
      workspaceId: 'child-worktree-id',
      sessionKind: 'subagent',
      isHistorical: false,
      historyState: 'new',
      config: { agentType: 'Explore' },
      workspacePath: 'D:\\workspace\\repo',
      remoteConnectionId: 'remote-1',
      remoteSshHost: 'host-1',
      dialogTurns: [
        {
          id: 'turn-1',
          status: 'processing',
          modelRounds: [],
          userMessage: { id: 'user-1', type: 'user', content: 'work', timestamp: 1 },
          timestamp: 1,
        },
      ],
    });

    ensureBtwSessionAvailable({
      childSessionId: 'subagent-child',
      parentSessionId: 'parent-session',
      sessionKind: 'subagent',
      parentToolCallId: 'call-1',
      includeInternal: true,
    });

    expect(mocks.addExternalSession).not.toHaveBeenCalled();
    expect(mocks.updateSessionRelationship).toHaveBeenCalledWith(
      'subagent-child',
      expect.objectContaining({
        parentSessionId: 'parent-session',
        sessionKind: 'subagent',
        parentToolCallId: 'call-1',
      }),
    );
    expect(mocks.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
  });
});

describe('openMainSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.switchChatSession.mockReset();
    mocks.syncSessionToModernStore.mockClear();
    mocks.updateLayout.mockClear();
    mocks.openScene.mockClear();
    sessions = new Map();
    activeSessionId = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not sync a superseded switch result into the modern store', async () => {
    sessions.set('session-b', { sessionId: 'session-b' });
    sessions.set('session-c', { sessionId: 'session-c' });
    mocks.switchChatSession.mockImplementationOnce(async () => {
      activeSessionId = 'session-c';
    });

    await openMainSession('session-b');

    expect(mocks.switchChatSession).toHaveBeenCalledWith('session-b', expect.any(Function));
    expect(mocks.syncSessionToModernStore).not.toHaveBeenCalledWith('session-b');
    expect(mocks.openScene).not.toHaveBeenCalledWith('session');
  });

  it('rehydrates an already-active metadata-only historical session before syncing it', async () => {
    sessions.set('session-b', {
      sessionId: 'session-b',
      isHistorical: true,
      historyState: 'metadata-only',
      dialogTurns: [],
    });
    activeSessionId = 'session-b';

    await openMainSession('session-b');

    expect(mocks.switchChatSession).toHaveBeenCalledWith('session-b', expect.any(Function));
    expect(mocks.syncSessionToModernStore).toHaveBeenCalledWith('session-b');
    expect(mocks.openScene).toHaveBeenCalledWith('session');
  });

  it('does not re-switch an already-active ready session', async () => {
    sessions.set('session-b', {
      sessionId: 'session-b',
      isHistorical: false,
      historyState: 'ready',
      dialogTurns: [{ id: 'turn-1' }],
    });
    activeSessionId = 'session-b';

    await openMainSession('session-b');

    expect(mocks.switchChatSession).not.toHaveBeenCalled();
    expect(mocks.syncSessionToModernStore).toHaveBeenCalledWith('session-b');
    expect(mocks.openScene).toHaveBeenCalledWith('session');
  });
});
