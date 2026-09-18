// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useModernFlowChatStore } from '@/flow_chat/store/modernFlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { activateSurface, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import { selectActiveSceneId, useSceneStore } from '../stores/sceneStore';
import { resolveSessionSceneTarget } from './sessionSceneTarget';
import { workspaceManager, type WorkspaceEventListener } from '@/infrastructure/services/business/workspaceManager';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { startSessionSceneLifecycle } from './sessionSceneLifecycle';

function session(sessionId: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId,
    title: sessionId,
    dialogTurns: [],
    status: 'idle',
    config: {},
    createdAt: 1,
    lastActiveAt: 1,
    error: null,
    workspacePath: '/workspace/project',
    ...overrides,
  };
}

function select(sessions: Session[], activeSessionId: string | null): void {
  flowChatStore.setState(previous => ({
    ...previous,
    sessions: new Map(sessions.map(value => [value.sessionId, value])),
    activeSessionId,
  }));
}

describe('Session scene resource lifetime with real stores', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    select([], null);
    useModernFlowChatStore.getState().clear();
    useSceneStore.getState().resetForPeerSwitch();
    stop = startSessionSceneLifecycle();
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
    activateSurface(LOCAL_SURFACE_ID);
    select([], null);
    useModernFlowChatStore.getState().clear();
    useSceneStore.getState().resetForPeerSwitch();
  });

  it('removes the last session tab, projection and navigation history together', () => {
    select([session('last')], 'last');
    useSceneStore.getState().openScene('session');

    flowChatStore.removeSession('last', { nextActiveSessionId: null });

    expect(flowChatStore.getState().sessions.size).toBe(0);
    expect(useSceneStore.getState()).toMatchObject({
      openTabs: [], activeTabId: null, navHistory: [], navCursor: -1,
    });
    expect(useModernFlowChatStore.getState()).toMatchObject({
      activeSession: null, virtualItems: [], visibleTurnInfo: null,
    });
  });

  it('retains different workspaces and replaces only the selected workspace session', () => {
    const first = session('a1', { workspaceId: 'workspace-a', workspacePath: '/projects/a' });
    const second = session('a2', { workspaceId: 'workspace-a', workspacePath: '/projects/a' });
    const other = session('b1', { workspaceId: 'workspace-b', workspacePath: '/projects/b' });
    select([first, second, other], first.sessionId);
    useSceneStore.getState().openScene('session');
    const firstTabId = useSceneStore.getState().activeTabId;

    flowChatStore.switchSession(other.sessionId);
    useSceneStore.getState().openScene('session');
    const otherTabId = useSceneStore.getState().activeTabId;
    flowChatStore.switchSession(second.sessionId);
    useSceneStore.getState().openScene('session');

    expect(useSceneStore.getState().openTabs.map(tab => [tab.id, tab.session?.sessionId])).toEqual([
      [firstTabId, second.sessionId], [otherTabId, other.sessionId],
    ]);
    expect(useSceneStore.getState().activeTabId).toBe(firstTabId);
    expect(flowChatStore.getState().sessions.size).toBe(3);
  });

  it('preserves workspace tabs during a temporary empty selection', () => {
    const first = session('a', { workspacePath: '/a' });
    const second = session('b', { workspacePath: '/b' });
    select([first, second], 'a');
    useSceneStore.getState().openScene('session');
    select([first, second], null);
    expect(useSceneStore.getState().openTabs.map(tab => tab.session?.sessionId)).toEqual(['a']);
    select([first, second], 'b');
    expect(useSceneStore.getState().openTabs.map(tab => tab.session?.sessionId)).toEqual(['a', 'b']);
  });

  it('defers legacy identity changes until pending navigation commits', () => {
    const original = session('legacy');
    select([original], original.sessionId);
    useSceneStore.getState().openScene('session');
    const tabId = useSceneStore.getState().activeTabId!;
    useSceneStore.setState({ pendingTabId: tabId });
    select([{ ...original, workspaceId: 'known-workspace' }], original.sessionId);
    expect(useSceneStore.getState().activeTabId).toBe(tabId);
    useSceneStore.setState({ pendingTabId: null });
    expect(useSceneStore.getState().activeTabId).not.toBe(tabId);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
    expect(useSceneStore.getState().openTabs[0].session?.sessionId).toBe(original.sessionId);
    expect(useSceneStore.getState().navHistory).not.toContain(tabId);
  });

  it('removes a deleted background workspace tab without stealing focus', () => {
    const first = session('a', { workspacePath: '/a' });
    const second = session('b', { workspacePath: '/b' });
    select([first, second], 'a');
    useSceneStore.getState().openScene('session');
    flowChatStore.switchSession('b');
    const activeTabId = useSceneStore.getState().activeTabId;
    flowChatStore.removeSession('a');
    expect(useSceneStore.getState().activeTabId).toBe(activeTabId);
    expect(useSceneStore.getState().openTabs.map(tab => tab.session?.sessionId)).toEqual(['b']);
    expect(flowChatStore.getActiveSession()?.sessionId).toBe('b');
  });

  it('closing a background tab keeps its active session available', () => {
    const first = session('a', { workspacePath: '/a', status: 'active' });
    const second = session('b', { workspacePath: '/b' });
    select([first, second], 'a');
    useSceneStore.getState().openScene('session');
    const firstTabId = useSceneStore.getState().activeTabId!;
    flowChatStore.switchSession('b');
    useSceneStore.getState().closeScene(firstTabId);
    expect(flowChatStore.getState().sessions.get('a')).toBe(first);
    expect(flowChatStore.getActiveSession()?.sessionId).toBe('b');
    expect(useSceneStore.getState().navHistory).not.toContain(firstTabId);
  });

  it.each(['legacy', 'bound', 'worktree', 'remote'] as const)(
    'retires a closed %s workspace tab without reactivating its cached session', kind => {
      stop?.();
      const workspace = {
        id: 'closing', rootPath: '/projects/a',
        ...(kind === 'remote'
          ? { workspaceKind: WorkspaceKind.Remote, connectionId: 'ssh-a', sshHost: 'host-a' }
          : { workspaceKind: WorkspaceKind.Normal }),
      } as WorkspaceInfo;
      const first = session('a', {
        workspacePath: kind === 'worktree' ? '/worktrees/a' : workspace.rootPath,
        ...(kind === 'bound' ? { workspaceId: workspace.id } : {}),
        ...(kind === 'worktree' ? { projectWorkspacePath: workspace.rootPath } : {}),
        ...(kind === 'remote' ? { remoteConnectionId: 'ssh-a', remoteSshHost: 'host-a' } : {}),
      });
      const workspaceState = {
        ...workspaceManager.getState(), currentWorkspace: workspace,
        activeWorkspaceId: workspace.id, openedWorkspaces: new Map([[workspace.id, workspace]]),
      };
      let onWorkspaceEvent: WorkspaceEventListener = () => {};
      vi.spyOn(workspaceManager, 'getState').mockImplementation(() => workspaceState);
      vi.spyOn(workspaceManager, 'addEventListener').mockImplementation(listener => {
        onWorkspaceEvent = listener;
        return () => {};
      });
      select([first], first.sessionId);
      stop = startSessionSceneLifecycle();
      useSceneStore.getState().openScene('settings');
      useSceneStore.getState().openScene('session');
      const tabId = useSceneStore.getState().activeTabId;
      const open = vi.spyOn(useSceneStore.getState(), 'openSessionScene');

      workspaceState.openedWorkspaces = new Map();
      onWorkspaceEvent({ type: 'workspace:closed', workspaceId: workspace.id });

      expect(open).not.toHaveBeenCalled();
      expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['settings']);
      expect(useSceneStore.getState().activeTabId).toBe('settings');
      expect(useSceneStore.getState().navHistory).not.toContain(tabId);
      expect(flowChatStore.getState().sessions.get(first.sessionId)).toBe(first);
      // The active session may lag the workspace update until hydrate completes.
      select([{ ...first, title: 'Late update' }], first.sessionId);
      expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['settings']);
    },
  );

  it('does not reopen a closed tab when its session is updated in the background', () => {
    const first = session('a');
    select([first], 'a');
    useSceneStore.getState().openScene('session');
    useSceneStore.getState().closeScene(useSceneStore.getState().activeTabId!);
    select([{ ...first, title: 'Background title' }], 'a');
    expect(useSceneStore.getState().openTabs).toEqual([]);
  });

  it('returns to another open tab when the selected session disappears', () => {
    select([session('active')], 'active');
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openScene('session');

    flowChatStore.removeSession('active');

    expect(useSceneStore.getState().activeTabId).toBe('settings');
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['settings']);
    useSceneStore.getState().goBack();
    useSceneStore.getState().goForward();
    expect(useSceneStore.getState().activeTabId).toBe('settings');
    expect(useSceneStore.getState().navHistory).not.toContain('session');
  });

  it('retires a hidden session scene after workspace removal without changing the visible tab', () => {
    select([session('active', { workspaceId: 'workspace-project' })], 'active');
    useSceneStore.getState().openScene('session');
    useSceneStore.getState().openScene('settings');

    flowChatStore.removeSessionsForWorkspace({
      id: 'workspace-project', rootPath: '/workspace/project', connectionId: undefined, sshHost: 'localhost',
    });

    expect(useSceneStore.getState().activeTabId).toBe('settings');
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['settings']);
  });

  it('keeps a valid replacement selection when another session is removed', () => {
    select([session('removed'), session('retained')], 'retained');
    useSceneStore.getState().openScene('session');

    flowChatStore.removeSession('removed');

    expect(selectActiveSceneId(useSceneStore.getState())).toBe('session');
    expect(useModernFlowChatStore.getState().activeSession?.sessionId).toBe('retained');
  });

  it.each(['metadata-only', 'hydrating', 'failed'] as const)(
    'keeps a %s record recoverable even with no rendered turns', historyState => {
      const retained = session('history', {
        isHistorical: true, historyState, remoteConnectionId: 'offline-ssh',
      });
      select([retained], retained.sessionId);
      useSceneStore.getState().openScene('session');


      expect(selectActiveSceneId(useSceneStore.getState())).toBe('session');
      expect(useModernFlowChatStore.getState().activeSession).toBe(retained);
    },
  );

  it('reconciles orphan tabs and stale presentation when the shell remounts', () => {
    stop?.();
    const stale = session('stale');
    useModernFlowChatStore.getState().setActiveSession(stale);
    useSceneStore.getState().openSessionScene(resolveSessionSceneTarget(stale, [], 'local'));
    stop = startSessionSceneLifecycle();

    expect(useSceneStore.getState().activeTabId).toBeNull();
    expect(useModernFlowChatStore.getState().activeSession).toBeNull();
    // A late navigation callback cannot leave the orphan tab open either.
    useSceneStore.getState().openScene('session');
    expect(useSceneStore.getState().openTabs).toEqual([]);
  });

  it('closes a dangling selection without deleting other session records', () => {
    const retained = session('retained');
    select([retained], 'missing');
    useSceneStore.getState().openScene('session');

    expect(useSceneStore.getState().activeTabId).toBeNull();
    expect(flowChatStore.getState().sessions.get('retained')).toBe(retained);
  });

  it('preserves sessions on the source device when switching to an empty surface', () => {
    const local = session('local-session');
    select([local], local.sessionId);
    useSceneStore.getState().openScene('session');

    activateSurface('empty-peer-lifecycle-test');
    expect(useSceneStore.getState().activeTabId).toBeNull();
    expect(useModernFlowChatStore.getState().activeSession).toBeNull();

    activateSurface(LOCAL_SURFACE_ID);
    expect(flowChatStore.getActiveSession()).toBe(local);
    expect(useModernFlowChatStore.getState().activeSession).toBe(local);
    expect(useSceneStore.getState().openTabs).toEqual([]);
    useSceneStore.getState().openScene('session');
    expect(selectActiveSceneId(useSceneStore.getState())).toBe('session');
  });

  it('allows a newly established session to open after the empty state', () => {

    select([session('created')], 'created');
    expect(useSceneStore.getState().openTabs).toEqual([]);

    useSceneStore.getState().openScene('session');
    expect(selectActiveSceneId(useSceneStore.getState())).toBe('session');
    expect(useModernFlowChatStore.getState().activeSession?.sessionId).toBe('created');
  });

  it('clears previous visible-turn metadata when selecting another session', () => {
    select([session('first')], 'first');

    useModernFlowChatStore.getState().setVisibleTurnInfo({
      turnIndex: 2, totalTurns: 3, userMessage: 'old', turnId: 'old-turn', visibleTurnIds: ['old-turn'],
    });

    select([session('second')], 'second');

    expect(useModernFlowChatStore.getState().visibleTurnInfo).toBeNull();
  });

  it('stops observing both stores when the shell unmounts', () => {

    stop?.();
    stop = undefined;

    useSceneStore.getState().openScene('session');
    select([session('later')], 'later');

    expect(useSceneStore.getState().openTabs).toEqual([]);
    expect(useModernFlowChatStore.getState().activeSession).toBeNull();
  });
});
