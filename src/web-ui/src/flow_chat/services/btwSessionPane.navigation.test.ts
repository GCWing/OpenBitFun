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
import { openBtwSessionInAuxPane } from './btwSessionPane';
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

  it.each([false, true])('opens a visible child tab before the panel mounts, worktree=%s', worktree => {
    openParent(worktree ? { workspaceId: 'worktree', projectWorkspaceId: 'project', workspacePath: '/worktrees/parent' } : {});
    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    const canvas = useAgentCanvasStore.getState();
    expect(canvas.scopeKey).toBe('parent');
    expect(canvas.primaryGroup.tabs).toHaveLength(1);
    expect(isCanvasTabVisibleForSession(canvas.primaryGroup.tabs[0], 'parent')).toBe(true);
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(false);
    switchAgentCanvasScope('parent');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].id).toBe(canvas.primaryGroup.tabs[0].id);
    expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(0);
    appManager.updateLayout({ rightPanelCollapsed: true });
    openBtwSessionInAuxPane({ childSessionId: 'child', parentSessionId: 'parent', sessionKind: 'subagent' });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].id).toBe(canvas.primaryGroup.tabs[0].id);
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(false);
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
});
