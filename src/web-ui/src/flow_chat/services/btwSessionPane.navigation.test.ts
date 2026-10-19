// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneStore } from '@/app/stores/sceneStore';
import { resolveSessionSceneTarget } from '@/app/services/sessionSceneTarget';
import { appManager } from '@/app/services/AppManager';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { clearAgentCanvasForPeerSwitch, switchAgentCanvasScope, useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores';
import { isCanvasTabVisibleForSession } from '@/app/components/panels/content-canvas/types';
import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { flowChatStore } from '../store/FlowChatStore';
import type { Session } from '../types/flow-chat';
import { openBtwSessionInAuxPane, ensureBtwSessionAvailableAndSettle, hasBtwSessionAuxPaneTab } from './btwSessionPane';
import { flowChatManager } from './FlowChatManager';

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({
    activeWorkspaceId: 'project',
    currentWorkspace: { id: 'project', rootPath: '/project' },
    openedWorkspaces: new Map([['project', { id: 'project', rootPath: '/project' }]]),
    recentWorkspaces: [],
  }) },
}));

vi.mock('./FlowChatManager', () => ({
  flowChatManager: {
    hydrateSessionHistoryForDetail: vi.fn(async () => {}),
    switchChatSession: vi.fn(async (sessionId: string, isCurrent: () => boolean) => {
      if (isCurrent()) flowChatStore.setState(state => ({ ...state, activeSessionId: sessionId }));
    }),
  },
}));

describe('subagent pane navigation through production stores', () => {
  function addSession(sessionId: string, overrides: Partial<Session> = {}) {
    const session: Session = {
      sessionId, title: sessionId, dialogTurns: [], status: 'idle',
      config: { modelName: 'test-model' }, sessionKind: 'normal',
      createdAt: 1, lastActiveAt: 1, error: null,
      workspaceId: 'project', workspacePath: '/project',
      historyState: 'ready', loadedTurnCount: 0, totalTurnCount: 0,
      ...overrides,
    };
    flowChatStore.setState(state => ({ ...state, sessions: new Map(state.sessions).set(sessionId, session) }));
    return session;
  }

  function openParent(overrides: Partial<Session> = {}) {
    const session = addSession('parent', overrides);
    flowChatStore.setState(state => ({ ...state, activeSessionId: session.sessionId }));
    useSceneStore.getState().openSessionScene(resolveSessionSceneTarget(
      session, workspaceManager.getState().openedWorkspaces.values(), getActiveSurfaceId(),
    ));
    addSession('child', { sessionKind: 'subagent', parentSessionId: 'parent' });
    return session;
  }

  beforeEach(() => {
    activateSurface('local');
    clearAgentCanvasForPeerSwitch();
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    appManager.updateLayout({ chatCollapsed: false, rightPanelCollapsed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAgentCanvasForPeerSwitch();
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
  });

  it('resolves unknown continuation policy without reloading an already complete transcript', async () => {
    openParent();
    vi.mocked(flowChatManager.hydrateSessionHistoryForDetail).mockClear();
    const metadata = vi.spyOn(flowChatStore, 'ensurePersistedSessionMetadata').mockImplementation(async childId => {
      flowChatStore.updateSessionRelationship(childId, { continuationPolicy: 'fresh_only' });
      return true;
    });
    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledWith('child', 'project'));
    expect(flowChatStore.getState().sessions.get('child')?.continuationPolicy).toBe('fresh_only');
    expect(flowChatManager.hydrateSessionHistoryForDetail).not.toHaveBeenCalled();
  });

  it.each([false, true])('opens a visible child tab before the panel mounts, worktree=%s', async worktree => {
    openParent(worktree ? { workspaceId: 'worktree', projectWorkspaceId: 'project', workspacePath: '/worktrees/parent' } : {});
    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    const canvas = useAgentCanvasStore.getState();
    expect(canvas.scopeKey).toBe('parent');
    expect(canvas.primaryGroup.tabs).toHaveLength(1);
    expect(isCanvasTabVisibleForSession(canvas.primaryGroup.tabs[0], 'parent')).toBe(true);
    await vi.waitFor(() => expect(appManager.getState().layout.rightPanelCollapsed).toBe(false));
    switchAgentCanvasScope('parent');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].id).toBe(canvas.primaryGroup.tabs[0].id);
    expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(0);
    appManager.updateLayout({ rightPanelCollapsed: true });
    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].id).toBe(canvas.primaryGroup.tabs[0].id);
    await vi.waitFor(() => expect(appManager.getState().layout.rightPanelCollapsed).toBe(false));
  });

  it('opens into the requested parent while retaining another session canvas', async () => {
    openParent();
    addSession('other');
    flowChatStore.setState(state => ({ ...state, activeSessionId: 'other' }));
    switchAgentCanvasScope('other');
    useAgentCanvasStore.getState().addTab({ type: 'text-viewer', title: 'Other', data: 'retained' }, 'active');
    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    await vi.waitFor(() => expect(useAgentCanvasStore.getState().scopeKey).toBe('parent'));
    expect(flowChatStore.getState().activeSessionId).toBe('parent');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content.data.childSessionId).toBe('child');
    switchAgentCanvasScope('other');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content.data).toBe('retained');
  });

  it('recreates and reloads a child record that a session removal left behind', async () => {
    openParent();
    vi.mocked(flowChatManager.hydrateSessionHistoryForDetail).mockClear();
    const metadata = vi.spyOn(flowChatStore, 'ensurePersistedSessionMetadata').mockResolvedValue(true);
    // What delete / archive / rollback do to the tab's child while the tab stays.
    flowChatStore.setState(state => {
      const sessions = new Map(state.sessions);
      sessions.delete('child');
      return { ...state, sessions };
    });
    expect(flowChatStore.getState().sessions.has('child')).toBe(false);

    await ensureBtwSessionAvailableAndSettle({
      childSessionId: 'child',
      parentSessionId: 'parent',
      sessionKind: 'subagent',
      workspaceId: 'project',
    });

    expect(metadata).toHaveBeenCalledWith('child', 'project');
    expect(flowChatStore.getState().sessions.get('child')?.sessionKind).toBe('subagent');
    expect(flowChatManager.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('child');
  });

  it('recreates a missing subagent child from the identity its tab recorded', async () => {
    openParent();
    vi.spyOn(flowChatStore, 'ensurePersistedSessionMetadata').mockResolvedValue(true);
    vi.mocked(flowChatManager.hydrateSessionHistoryForDetail).mockClear();
    openBtwSessionInAuxPane({
      childSessionId: 'hidden-child',
      parentSessionId: 'parent',
      sessionKind: 'subagent',
      sessionTitle: 'Subagent: verify the pane',
      parentToolCallId: 'task-call-1',
      subagentType: 'Explore',
      workspaceId: 'project',
    });

    // The tab keeps the child identity: it is the only thing left that knows this
    // child after its record is gone.
    const data = useAgentCanvasStore.getState().primaryGroup.tabs[0].content.data;
    expect(data).toMatchObject({
      childSessionId: 'hidden-child',
      sessionKind: 'subagent',
      sessionTitle: 'Subagent: verify the pane',
      parentToolCallId: 'task-call-1',
      subagentType: 'Explore',
    });

    flowChatStore.setState(state => {
      const sessions = new Map(state.sessions);
      sessions.delete('hidden-child');
      return { ...state, sessions };
    });
    expect(flowChatStore.getState().sessions.has('hidden-child')).toBe(false);

    // What the pane does for a mounted tab whose record is missing.
    await ensureBtwSessionAvailableAndSettle({
      childSessionId: data.childSessionId,
      parentSessionId: data.parentSessionId,
      sessionKind: data.sessionKind,
      sessionTitle: data.sessionTitle,
      parentToolCallId: data.parentToolCallId,
      subagentType: data.subagentType,
      workspaceId: 'project',
    });

    const healed = flowChatStore.getState().sessions.get('hidden-child');
    expect(healed?.sessionKind).toBe('subagent');
    expect(healed?.title).toBe('Subagent: verify the pane');
    expect(healed?.parentToolCallId).toBe('task-call-1');
    expect(healed?.subagentType).toBe('Explore');
    expect(flowChatManager.hydrateSessionHistoryForDetail).toHaveBeenCalledWith('hidden-child');
  });

  it('propagates a failed child reload so the pane can render it', async () => {
    openParent();
    vi.mocked(flowChatManager.hydrateSessionHistoryForDetail)
      .mockRejectedValueOnce(new Error('child session is gone'));

    await expect(ensureBtwSessionAvailableAndSettle({
      childSessionId: 'child',
      parentSessionId: 'parent',
      sessionKind: 'subagent',
      workspaceId: 'project',
    })).rejects.toThrow('child session is gone');
  });

  it('reports tab ownership so an embedded pane knows it cannot close one', async () => {
    openParent();
    expect(hasBtwSessionAuxPaneTab('child')).toBe(false);

    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    await vi.waitFor(() => expect(hasBtwSessionAuxPaneTab('child')).toBe(true));
    expect(hasBtwSessionAuxPaneTab('unknown-child')).toBe(false);
  });
});
