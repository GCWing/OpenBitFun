// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useSceneStore, resetSceneStoreForTest } from '../../stores/sceneStore';
import { resolveResourceWorkspace, useNavSceneStore } from '../../stores/navSceneStore';
import { normalizeResourceLayout, useWorkspaceResourceState } from './workspaceResourceState';
import { getSessionSceneTabId } from '../../components/SceneBar/types';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import type { WorkspaceInfo } from '@/shared/types';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { startSessionSceneLifecycle } from '../../services/sessionSceneLifecycle';

const sessionTarget = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'task' };

describe('workspace resource navigation', () => {
  beforeEach(() => {
    resetSceneStoreForTest();
    useNavSceneStore.getState().closeNavScene();
  });
  it('opens resources without replacing the active conversation', () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    useNavSceneStore.getState().openNavScene('file-viewer');
    expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(sessionTarget));
  });
  it.each([true, false])('browses another workspace without selecting or creating its session (history: %s)', hasHistory => {
    const previous = flowChatStore.getState();
    const session = (id: string, workspacePath: string): Session => ({
      sessionId: id, workspacePath, title: id, dialogTurns: [], config: {},
      status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
    });
    const a = session('a', '/a');
    const b = session('b', '/b');
    flowChatStore.setState(state => ({ ...state,
      sessions: new Map((hasHistory ? [a, b] : [a]).map(item => [item.sessionId, item])), activeSessionId: a.sessionId,
    }));
    const stop = startSessionSceneLifecycle();
    try {
      useSceneStore.getState().openScene('session');
      const scenes = useSceneStore.getState();
      const selection = flowChatStore.getState();
      const workspaces = workspaceManager.getState();
      useNavSceneStore.getState().openWorkspaceResources('workspace-b');
      expect(useSceneStore.getState()).toBe(scenes);
      expect(flowChatStore.getState()).toBe(selection);
      expect(workspaceManager.getState()).toStrictEqual(workspaces);
      expect(useNavSceneStore.getState().resourceWorkspace).toEqual({ surfaceId: 'local', workspaceId: 'workspace-b' });
    } finally {
      stop();
      flowChatStore.setState(() => previous);
    }
  });
  it('keeps resource selection independent of active workspace changes and back/forward navigation', () => {
    const a = { id: 'a', rootPath: '/a' } as WorkspaceInfo;
    const b = { id: 'b', rootPath: '/b' } as WorkspaceInfo;
    const workspaces = new Map([[a.id, a], [b.id, b]]);
    useNavSceneStore.getState().openWorkspaceResources(b.id);
    useNavSceneStore.getState().goBack();
    useNavSceneStore.getState().goForward();
    expect(resolveResourceWorkspace(useNavSceneStore.getState().resourceWorkspace, 'local', workspaces, a)).toBe(b);
    useNavSceneStore.getState().openWorkspaceResources(a.id);
    expect(resolveResourceWorkspace(useNavSceneStore.getState().resourceWorkspace, 'local', workspaces, b)).toBe(a);
  });
  it('does not substitute the active workspace for a closed or other-device browse target', () => {
    const active = { id: 'same-id', rootPath: '/repo' } as WorkspaceInfo;
    const target = { surfaceId: 'local', workspaceId: active.id };
    expect(resolveResourceWorkspace(target, 'local', new Map(), active)).toBeNull();
    expect(resolveResourceWorkspace(target, 'peer', new Map([[active.id, active]]), active)).toBeNull();
    expect(resolveResourceWorkspace(null, 'local', new Map(), active)).toBe(active);
  });
  it('lets an untargeted resource command return to the current workspace', () => {
    useNavSceneStore.getState().openWorkspaceResources('other-workspace');
    useSceneStore.getState().openScene('file-viewer');
    expect(useNavSceneStore.getState().resourceWorkspace).toBeNull();
    expect(useNavSceneStore.getState().showSceneNav).toBe(true);
  });
  it('keeps resources during file, terminal and conversation navigation', () => {
    useNavSceneStore.getState().openNavScene('file-viewer');
    for (const scene of ['file-viewer', 'terminal', 'session'] as const) {
      if (scene === 'session') useSceneStore.getState().openSessionScene(sessionTarget);
      else useSceneStore.getState().openScene(scene);
      expect(useNavSceneStore.getState().showSceneNav).toBe(true);
      expect(useNavSceneStore.getState().navSceneId).toBe('file-viewer');
    }
  });
  it('respects going back to the main navigation', () => {
    useNavSceneStore.getState().openNavScene('file-viewer');
    useNavSceneStore.getState().goBack();
    useSceneStore.getState().openScene('terminal');
    expect(useNavSceneStore.getState().showSceneNav).toBe(false);
    useNavSceneStore.getState().goForward();
    expect(useNavSceneStore.getState().navSceneId).toBe('file-viewer');
  });
  it('lets settings own their navigation and clears resources on a device switch', () => {
    useNavSceneStore.getState().openWorkspaceResources('project');
    useSceneStore.getState().openScene('settings');
    expect(useNavSceneStore.getState().navSceneId).toBe('settings');
    resetSceneStoreForTest();
    expect(useNavSceneStore.getState().showSceneNav).toBe(false);
    expect(useNavSceneStore.getState().resourceWorkspace).toBeNull();
  });
});

describe('workspace resource preferences', () => {
  it('isolates layouts by complete resource key', () => {
    const state = useWorkspaceResourceState.getState();
    state.updateLayout('local/project', { terminalFraction: 0.5, filesCollapsed: true });
    state.updateLayout('peer/project', { terminalsCollapsed: true });
    const layouts = useWorkspaceResourceState.getState().layouts;
    expect(layouts['local/project'].filesCollapsed).toBe(true);
    expect(layouts['peer/project'].filesCollapsed).toBe(false);
    expect(layouts['peer/project'].terminalFraction).toBe(0.3);
  });
  it('tolerates missing and invalid persisted preferences', () => {
    expect(normalizeResourceLayout({}).terminalFraction).toBe(0.3);
    expect(normalizeResourceLayout({ terminalFraction: Number.NaN }).terminalFraction).toBe(0.3);
    expect(normalizeResourceLayout({ terminalFraction: 10 }).terminalFraction).toBe(0.75);
    expect(normalizeResourceLayout({ terminalFraction: -1 }).terminalFraction).toBe(0.15);
  });
});
