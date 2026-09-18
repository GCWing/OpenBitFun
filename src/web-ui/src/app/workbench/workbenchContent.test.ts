// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSessionSceneNavigation, useSceneStore } from '../stores/sceneStore';
import { useContentResourceStore } from './contentResourceStore';
import { registerContentCloseGuard } from './contentResourceLifecycle';
import { fileTabManager } from '@/shared/services/FileTabManager';
import { openFileInBestTarget, createTerminalTab, createGitCodeEditorTab, createTab } from '@/shared/utils/tabUtils';
import { openContentInBestTarget, openWorkbenchContent } from '@/shared/services/workbenchContentService';
import { clearAgentCanvasForPeerSwitch, switchAgentCanvasWorkspace, useAgentCanvasStore, useGitCanvasStore } from '../components/panels/content-canvas/stores';
import { appManager } from '../services/AppManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { getEditorDocument, releaseEditorDocument } from '@/tools/editor/services/EditorDocument';
import { cancelPendingSettingsNavigation, discardAndContinueSettingsNavigation, registerSettingsDraft,
  resetSettingsDraftRegistryForTests } from '@/infrastructure/config/settingsDraftRegistry';
import { globalEventBus } from '@/infrastructure/event-bus';
import { editorJumpService } from '@/shared/services/EditorJumpService';
import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { SCENE_TAB_REGISTRY } from '../scenes/registry';
import { getSessionSceneTabId } from '../components/SceneBar/types';
import { resolveSessionSceneTarget } from '../services/sessionSceneTarget';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import type { WorkspaceInfo } from '@/shared/types';

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: vi.fn(() => ({ currentWorkspace: { id: 'project', rootPath: '/project' }, recentWorkspaces: [],
    openedWorkspaces: new Map([['project', { id: 'project', rootPath: '/project' }]]) })) },
}));

describe('workbench content navigation', () => {
  function selectSession(sessionId = 'session-a', overrides: Partial<Session> = {}) {
    const session: Session = { sessionId, title: sessionId, dialogTurns: [], status: 'idle', config: {},
      sessionKind: 'normal', createdAt: 1, lastActiveAt: 1, error: null,
      workspacePath: '/project', workspaceId: 'project', ...overrides };
    flowChatStore.setState(state => ({ ...state, sessions: new Map(state.sessions).set(sessionId, session), activeSessionId: sessionId }));
    return session;
  }

  function openSession(sessionId = 'session-a', overrides: Partial<Session> = {}) {
    const session = selectSession(sessionId, overrides);
    const target = resolveSessionSceneTarget(session, workspaceManager.getState().openedWorkspaces.values(), getActiveSurfaceId());
    useSceneStore.getState().openSessionScene(target);
    return target;
  }

  beforeEach(() => {
    activateSurface('local');
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    clearAgentCanvasForPeerSwitch();
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
    resetSettingsDraftRegistryForTests();
    appManager.updateLayout({ chatCollapsed: false, rightPanelCollapsed: true });
  });

  afterEach(() => {
    activateSurface('local');
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    clearAgentCanvasForPeerSwitch();
    resetSettingsDraftRegistryForTests();
    vi.mocked(workspaceManager.getState).mockClear();
  });

  it.each([false, true])('refreshes a dispatch snapshot through the production open path, inline=%s', inline => {
    if (inline) openSession();
    const open = (dataUrl: string) => createTab({
      type: 'image-viewer', title: 'output.png', mode: 'agent', replaceExisting: true,
      duplicateCheckKey: 'job/output.png', data: { filePath: 'dispatch-file://job/output.png', imageSource: { dataUrl, size: 1 } },
    });
    open('data:image/png;base64,AQ==');
    open('data:image/png;base64,Ag==');
    const contents = inline
      ? useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.content)
      : Object.values(useContentResourceStore.getState().resources).map(resource => resource.content);
    expect(contents).toHaveLength(1);
    expect(contents[0].data.imageSource.dataUrl).toBe('data:image/png;base64,Ag==');
  });

  it('falls back to one main file tab when a stale scene has no usable session', () => {
    useSceneStore.getState().openSessionScene({ surfaceId: 'local', workspaceKey: 'project', sessionId: 'session-a' });
    fileTabManager.openFile({ filePath: '/project/a.ts', sceneJustOpened: true });
    openFileInBestTarget({ filePath: '/project/a.ts', jumpToLine: 42 }, { source: 'project-nav' });
    const state = useSceneStore.getState();
    expect(state.openTabs.filter(tab => tab.contentId)).toHaveLength(1);
    expect(state.activeTabId).toMatch(/^content:/);
    expect(Object.values(useContentResourceStore.getState().resources)[0].content.data.jumpToLine).toBe(42);
    expect(SCENE_TAB_REGISTRY.some(tab => ['file-viewer', 'panel-view'].includes(tab.id))).toBe(false);
  });

  it.each([true, false])('opens content at the top when only a cached session exists, selected=%s', selected => {
    const session = selectSession();
    if (!selected) flowChatStore.setState(state => ({ ...state, activeSessionId: null }));
    const activate = vi.fn(async () => true);
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false, activate });
    try {
      fileTabManager.openFile({ filePath: '/project/a.ts' });
      createTerminalTab('pty-session', 'Shell', 'project');
      createTab({ type: 'markdown-viewer', title: 'Note', data: '# Note', mode: 'agent' });
      expect(activate).not.toHaveBeenCalled();
      expect(useSceneStore.getState().openTabs).toHaveLength(3);
      expect(useSceneStore.getState().openTabs.every(tab => tab.contentId && !tab.session)).toBe(true);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
      expect(flowChatStore.getState().activeSessionId).toBe(selected ? session.sessionId : null);
    } finally { stop(); }
  });

  it('does not reopen a closed session tab while its session remains selected', async () => {
    const target = openSession();
    await useSceneStore.getState().closeScene(getSessionSceneTabId(target));
    expect(flowChatStore.getState().activeSessionId).toBe(target.sessionId);
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
    expect(useSceneStore.getState().activeTabId).toMatch(/^content:/);
    expect(useSceneStore.getState().openTabs.some(tab => tab.session)).toBe(false);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
  });

  it('opens into the session and expands its panel before any viewport mounts', () => {
    openSession();
    fileTabManager.openFile({ filePath: '/project/a.ts', sceneJustOpened: true });
    openFileInBestTarget({ filePath: '/project/a.ts', jumpToLine: 42 }, { source: 'project-nav' });
    const canvas = useAgentCanvasStore.getState();
    expect(canvas.workspaceKey).toBe('project');
    expect(canvas.primaryGroup.tabs).toHaveLength(1);
    expect(canvas.primaryGroup.tabs[0].content.data).toMatchObject({ filePath: '/project/a.ts', jumpToLine: 42 });
    expect(useSceneStore.getState().openTabs.map(tab => tab.session?.sessionId)).toEqual(['session-a']);
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(false);
    expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(0);

    // AuxPane's later first mount and stale workspace events cannot reset this write.
    switchAgentCanvasWorkspace(null, 'project');
    switchAgentCanvasWorkspace('previous-workspace', 'project');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].id).toBe(canvas.primaryGroup.tabs[0].id);
  });

  it('returns to an open session behind another top-level scene instead of a cached selection', () => {
    const target = openSession();
    selectSession('cached-session', { lastActiveAt: 999 });
    useSceneStore.getState().openScene('git');
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(target));
    expect(useSceneStore.getState().openTabs.find(tab => tab.session)?.session).toEqual(target);
    expect(useSceneStore.getState().openTabs.some(tab => tab.contentId)).toBe(false);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
  });

  it('chooses the matching workspace tab while a different workspace session is active', () => {
    const target = openSession();
    const other = openSession('other-session', { workspaceId: undefined, workspacePath: '/other' });
    switchAgentCanvasWorkspace(undefined, 'other');
    useAgentCanvasStore.getState().addTab({ type: 'text-viewer', title: 'Other', data: { content: 'draft' } }, 'active');
    const previous = useAgentCanvasStore.getState().primaryGroup.tabs[0];
    fileTabManager.openFile({ filePath: '/project/a.ts', workspacePath: '/project' });
    expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(target));
    expect(useSceneStore.getState().openTabs.map(tab => tab.session)).toEqual([target, other]);
    expect(useAgentCanvasStore.getState().workspaceKey).toBe('project');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content.data.filePath).toBe('/project/a.ts');
    switchAgentCanvasWorkspace(undefined, 'other');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toEqual([previous.id]);
  });

  it.each([
    { isTransient: true },
    { sessionKind: 'subagent' as const },
    { persistedStatus: 'archived' as const },
  ])('does not use an ineligible session even if its tab remains open: %j', overrides => {
    openSession('ineligible', overrides);
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    expect(useSceneStore.getState().activeTabId).toMatch(/^content:/);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
  });

  it.each(['local', 'peer'])('uses the matching SSH workspace tab on the %s surface', surfaceId => {
    activateSurface(surfaceId);
    const workspaces = workspaceManager.getState();
    const sshWorkspace = { id: 'ssh-project', rootPath: '/srv/project', connectionId: 'ssh-a', workspaceKind: 'remote' } as WorkspaceInfo;
    vi.mocked(workspaceManager.getState).mockReturnValue({ ...workspaces,
      currentWorkspace: sshWorkspace, openedWorkspaces: new Map([[sshWorkspace.id, sshWorkspace]]) });
    try {
      const target = openSession('ssh-session', { workspaceId: sshWorkspace.id,
        workspacePath: sshWorkspace.rootPath, remoteConnectionId: 'ssh-a' });
      useSceneStore.getState().openScene('git');
      fileTabManager.openFile({ filePath: 'a.ts', workspacePath: sshWorkspace.rootPath, remoteConnectionId: 'ssh-a' });
      expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(target));
      expect(useAgentCanvasStore.getState().workspaceKey).toBe(sshWorkspace.id);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content.metadata?.resourceScope).toEqual({
        surfaceId, workspaceId: sshWorkspace.id, workspacePath: sshWorkspace.rootPath, remoteConnectionId: 'ssh-a',
      });
      expect(() => fileTabManager.openFile({ filePath: 'b.ts', workspacePath: sshWorkspace.rootPath, remoteConnectionId: 'ssh-b' })).toThrow('Workspace identity');
      expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(target));
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    } finally { vi.mocked(workspaceManager.getState).mockReturnValue(workspaces); }
  });

  it('routes an upgraded worktree session through its owning project ID', () => {
    const target = openSession('worktree-session', { workspaceId: 'worktree-id', projectWorkspaceId: 'project', workspacePath: '/worktrees/a',
      projectWorkspacePath: '/project' });
    fileTabManager.openFile({ filePath: '/project/a.ts', workspacePath: '/project' });
    expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(target));
    expect(useAgentCanvasStore.getState().workspaceKey).toBe('project');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
  });

  it('keeps a draft and replaces stale navigation when reopening an inline file', () => {
    openSession();
    fileTabManager.openFile({ filePath: '/project/a.ts', jumpToRange: { start: 2, end: 5 } });
    const store = useAgentCanvasStore.getState();
    const tab = store.primaryGroup.tabs[0];
    const documentId = `canvas:${tab.id}`;
    const document = getEditorDocument(documentId, tab.content.metadata!.resourceScope, '/project/a.ts');
    document.capture('unsaved draft', true, 'saved');
    store.setTabDirty(tab.id, 'primary', true);
    store.updateTabContent(tab.id, 'primary', { ...tab.content, data: { ...tab.content.data, content: 'unsaved draft' } });
    appManager.updateLayout({ rightPanelCollapsed: true });
    fileTabManager.openFile({ filePath: '/project/a.ts', jumpToLine: 9, jumpToColumn: 3 });
    const reopened = useAgentCanvasStore.getState().primaryGroup.tabs[0];
    expect(reopened).toMatchObject({ id: tab.id, isDirty: true, content: { data: { content: 'unsaved draft', jumpToLine: 9, jumpToColumn: 3 } } });
    expect(reopened.content.data.jumpToRange).toBeUndefined();
    expect(reopened.content.data.navigationToken).not.toBe(tab.content.data.navigationToken);
    expect(document.snapshot).toEqual({ content: 'unsaved draft', isDirty: true, savedContent: 'saved' });
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(false);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    releaseEditorDocument(documentId);
  });

  it('routes terminals and contextual content through the same session-first policy', () => {
    openSession();
    createTerminalTab('pty-session', 'Shell', 'project');
    createTerminalTab('pty-session', 'Shell', 'agent');
    createTab({ type: 'markdown-viewer', title: 'Note', data: '# Note', mode: 'project' });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.content.type)).toEqual(['markdown-viewer', 'terminal']);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[1].content.metadata?.terminalCloseBehavior).toBe('detach');
    expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(0);
  });

  it('keeps explicit Git opens in Git even with a selected session', () => {
    openSession();
    useSceneStore.getState().openScene('git');
    createGitCodeEditorTab('/project/a.ts', 'a.ts');
    expect(useGitCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(useSceneStore.getState().activeTabId).toBe('git');
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
  });

  it('keeps an explicit pop-out at the top and reuses its document on later opens', () => {
    openSession();
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    const canvas = useAgentCanvasStore.getState();
    const tab = canvas.primaryGroup.tabs[0];
    const resourceId = openWorkbenchContent(tab.content, { scope: tab.content.metadata!.resourceScope, documentId: `canvas:${tab.id}` });
    canvas.detachTab(tab.id, 'primary');
    fileTabManager.openFile({ filePath: '/project/a.ts', jumpToLine: 12 });
    expect(useSceneStore.getState().activeTabId).toBe(`content:${resourceId}`);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(1);
    expect(useContentResourceStore.getState().resources[resourceId].documentId).toBe(`canvas:${tab.id}`);
  });

  it.each([
    { workspacePath: '/other' },
    { workspacePath: '/project', remoteConnectionId: 'ssh-other' },
  ])('does not route a different workspace or filesystem into the selected session: %j', origin => {
    openSession();
    const selected = useSceneStore.getState().activeTabId;
    expect(() => fileTabManager.openFile({ filePath: 'a.ts', ...origin })).toThrow('Workspace identity');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(useSceneStore.getState().activeTabId).toBe(selected);
    expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
  });

  it('isolates a peer file from sessions on the local device', () => {
    openSession();
    activateSurface('peer-without-session');
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    expect(useSceneStore.getState().activeTabId).toMatch(/^content:/);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(() => fileTabManager.openFile({ filePath: '/project/b.ts', scope: { surfaceId: 'local' } })).toThrow('another device');
  });

  it.each(['superseded', 'device-change'])('waits for session activation and abandons a stale content request: %s', async reason => {
    openSession();
    useSceneStore.getState().openScene('git');
    flowChatStore.setState(state => ({ ...state, activeSessionId: null }));
    let complete!: (activated: boolean) => void;
    const activation = new Promise<boolean>(resolve => { complete = resolve; });
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false, activate: () => activation });
    let current = true;
    try {
      openContentInBestTarget({ type: 'code-editor', title: 'a.ts', data: { filePath: '/project/a.ts' } }, { isCurrent: () => current });
      expect(useSceneStore.getState().pendingTabId).toMatch(/^session:/);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      if (reason === 'superseded') current = false;
      else { activateSurface('peer'); activateSurface('local'); }
      complete(true);
      await vi.waitFor(() => expect(useSceneStore.getState().pendingTabId).toBeNull());
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      expect(useSceneStore.getState().activeTabId).toBe('git');
      expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
    } finally { stop(); }
  });

  it.each(['closed', 'replaced', 'scope-changed'])('cancels content when the destination changes during activation: %s', async reason => {
    const target = openSession();
    useSceneStore.getState().openScene('git');
    let complete!: (activated: boolean) => void;
    let isCurrent = () => true;
    const activation = new Promise<boolean>(resolve => { complete = resolve; });
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false,
      activate: (_target, current) => { isCurrent = current; return activation; } });
    try {
      fileTabManager.openFile({ filePath: '/project/a.ts' });
      expect(useSceneStore.getState().pendingTabId).toBe(getSessionSceneTabId(target));
      if (reason === 'closed') await useSceneStore.getState().closeScene(getSessionSceneTabId(target));
      else if (reason === 'replaced') {
        selectSession('replacement');
        useSceneStore.getState().updateSessionScene({ ...target, sessionId: 'replacement' });
      } else selectSession(target.sessionId, { workspaceId: undefined, workspacePath: '/other' });
      expect(isCurrent()).toBe(false);
      complete(true);
      await vi.waitFor(() => expect(useSceneStore.getState().pendingTabId).toBeNull());
      expect(useSceneStore.getState().activeTabId).toBe('git');
      const retained = useSceneStore.getState().openTabs.find(tab => tab.id === getSessionSceneTabId(target));
      if (reason === 'closed') expect(retained).toBeUndefined();
      if (reason === 'replaced') expect(retained?.session?.sessionId).toBe('replacement');
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(0);
      expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
    } finally { stop(); }
  });

  it('activates an existing session tab before committing and preserves the previous workspace canvas', async () => {
    openSession();
    useSceneStore.getState().openScene('git');
    flowChatStore.setState(state => ({ ...state, activeSessionId: null }));
    switchAgentCanvasWorkspace(null, 'other-workspace');
    useAgentCanvasStore.getState().addTab({ type: 'markdown-viewer', title: 'Previous', data: 'draft' }, 'active');
    const previous = useAgentCanvasStore.getState().primaryGroup.tabs[0];
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false,
      activate: async target => {
        flowChatStore.setState(state => ({ ...state, activeSessionId: target.sessionId }));
        return true;
      } });
    try {
      fileTabManager.openFile({ filePath: '/project/a.ts' });
      await vi.waitFor(() => expect(useAgentCanvasStore.getState().workspaceKey).toBe('project'));
      expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content.data.filePath).toBe('/project/a.ts');
      expect(flowChatStore.getState().activeSessionId).toBe('session-a');
      switchAgentCanvasWorkspace(null, 'other-workspace');
      expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toEqual([previous.id]);
    } finally { stop(); }
  });

  it('keeps content and layout unchanged when settings exit is canceled', async () => {
    openSession();
    useSceneStore.getState().openScene('settings');
    const draft = registerSettingsDraft({ id: 'settings-draft', pageId: 'page', label: 'Settings', dirty: true,
      save: () => true, discard: () => {} });
    try {
      fileTabManager.openFile({ filePath: '/project/a.ts' });
      expect(useSceneStore.getState().activeTabId).toBe('settings');
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
      cancelPendingSettingsNavigation();
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      fileTabManager.openFile({ filePath: '/project/a.ts' });
      await discardAndContinueSettingsNavigation();
      expect(useSceneStore.getState().activeTabId).toMatch(/^session:/);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
      expect(appManager.getState().layout.rightPanelCollapsed).toBe(false);
    } finally { draft(); }
  });

  it.each(['closed', 'replaced'])('does not restore a destination changed while settings exit is pending: %s', async reason => {
    const target = openSession();
    useSceneStore.getState().openScene('settings');
    const draft = registerSettingsDraft({ id: 'settings-draft', pageId: 'page', label: 'Settings', dirty: true,
      save: () => true, discard: () => {} });
    const activate = vi.fn(async () => true);
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false, activate });
    try {
      fileTabManager.openFile({ filePath: '/project/a.ts' });
      expect(activate).not.toHaveBeenCalled();
      if (reason === 'closed') await useSceneStore.getState().closeScene(getSessionSceneTabId(target));
      else {
        selectSession('replacement');
        useSceneStore.getState().updateSessionScene({ ...target, sessionId: 'replacement' });
      }
      await discardAndContinueSettingsNavigation();
      expect(activate).not.toHaveBeenCalled();
      expect(useSceneStore.getState().activeTabId).toBe('settings');
      const retained = useSceneStore.getState().openTabs.find(tab => tab.id === getSessionSceneTabId(target));
      if (reason === 'closed') expect(retained).toBeUndefined();
      else expect(retained?.session?.sessionId).toBe('replacement');
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
      expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(0);
      expect(appManager.getState().layout.rightPanelCollapsed).toBe(true);
    } finally { stop(); draft(); }
  });

  it('does not remove a dirty document after a canceled close and shares repeated close requests', async () => {
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    const tab = useSceneStore.getState().openTabs[0];
    const resourceId = tab.contentId!;
    useContentResourceStore.getState().update(resourceId, { isDirty: true });
    let resolve!: (approved: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const stop = registerContentCloseGuard(resourceId, guard);
    useSceneStore.getState().closeScene(tab.id);
    useSceneStore.getState().closeScene(tab.id);
    expect(guard).toHaveBeenCalledTimes(1);
    resolve(false);
    await vi.waitFor(() => expect(useSceneStore.getState().openTabs).toHaveLength(1));
    expect(useContentResourceStore.getState().resources[resourceId].isDirty).toBe(true);
    stop();
  });
  it('restores file tabs by device without discarding their resource state', () => {
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    const localTab = useSceneStore.getState().openTabs[0];
    useContentResourceStore.getState().update(localTab.contentId!, { isDirty: true });
    useSceneStore.getState().resetForPeerSwitch();
    activateSurface('peer');
    useSceneStore.getState().resetForPeerSwitch(true);
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    expect(useSceneStore.getState().openTabs[0].contentId).not.toBe(localTab.contentId);
    useSceneStore.getState().resetForPeerSwitch();
    activateSurface('local');
    useSceneStore.getState().resetForPeerSwitch(true);
    expect(useSceneStore.getState().openTabs[0].id).toBe(localTab.id);
    expect(useContentResourceStore.getState().resources[localTab.contentId!].isDirty).toBe(true);
  });
  it('pins and reorders tabs without changing document identity or navigation history', () => {
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    fileTabManager.openFile({ filePath: '/project/b.ts' });
    fileTabManager.openFile({ filePath: '/project/c.ts' });
    const [a, b, c] = useSceneStore.getState().openTabs;
    const history = useSceneStore.getState().navHistory;
    useSceneStore.getState().togglePinScene(b.id);
    useSceneStore.getState().reorderScene(a.id, c.id, 'after');
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([b.id, c.id, a.id]);
    expect(useSceneStore.getState().navHistory).toEqual(history);
    expect(Object.keys(useContentResourceStore.getState().resources)).toHaveLength(3);
  });
  it('rejects a pending close after switching away and back to the same device', async () => {
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    const tab = useSceneStore.getState().openTabs[0];
    let resolve!: (approved: boolean) => void;
    const stop = registerContentCloseGuard(tab.contentId!, () => new Promise<boolean>(done => { resolve = done; }));
    const close = useSceneStore.getState().closeScene(tab.id);
    activateSurface('peer');
    activateSurface('local');
    resolve(true);
    await close;
    expect(useSceneStore.getState().openTabs[0].id).toBe(tab.id);
    stop();
  });
  it('routes repeated jumps through the resource tab and retains line columns', async () => {
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    const tab = useSceneStore.getState().openTabs[0];
    useSceneStore.getState().openScene('git');
    await editorJumpService.jumpToFile('/project/a.ts', 7, 8);
    const firstToken = useContentResourceStore.getState().resources[tab.contentId!].content.data.navigationToken;
    await editorJumpService.jumpToFile('/project/a.ts', 7, 8);
    expect(useSceneStore.getState().activeTabId).toBe(tab.id);
    expect(useContentResourceStore.getState().resources[tab.contentId!].content.data).toMatchObject({ jumpToLine: 7, jumpToColumn: 8 });
    expect(useContentResourceStore.getState().resources[tab.contentId!].content.data.navigationToken).not.toBe(firstToken);
  });
  it('applies rename notifications to their originating device while it is suspended', () => {
    fileTabManager.openFile({ filePath: '/project/a.ts' });
    const tab = useSceneStore.getState().openTabs[0];
    activateSurface('peer');
    globalEventBus.emit('workspace:file-renamed', { surfaceId: 'local', workspaceId: 'project', oldPath: '/project/a.ts', newPath: '/project/b.ts' });
    expect(useContentResourceStore.getState().resources[tab.contentId!].target).toEqual({ kind: 'file', path: '/project/b.ts' });
  });
  it('detaches regular terminals on tab close and reconciles explicit renames and destruction', async () => {
    createTerminalTab('pty-a', 'Terminal A');
    const first = useSceneStore.getState().openTabs[0];
    window.dispatchEvent(new CustomEvent('terminal-session-renamed', { detail: { sessionId: 'pty-a', newName: 'Build', surfaceId: 'local' } }));
    expect(useContentResourceStore.getState().resources[first.contentId!].content.title).toBe('Build');
    await useSceneStore.getState().closeScene(first.id);
    expect(useSceneStore.getState().openTabs).toHaveLength(0);
    createTerminalTab('pty-a', 'Build');
    window.dispatchEvent(new CustomEvent('terminal-session-destroyed', { detail: { sessionId: 'pty-a', surfaceId: 'local' } }));
    await vi.waitFor(() => expect(useSceneStore.getState().openTabs).toHaveLength(0));
  });

});
