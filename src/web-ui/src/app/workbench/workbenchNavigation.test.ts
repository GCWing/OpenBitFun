// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { registerSessionSceneNavigation, useSceneStore } from '../stores/sceneStore';
import { getSessionSceneTabId } from '../components/SceneBar/types';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { sceneSelection } from './scenePaneModel';
import { sessionPaneLayoutStore, selectSessionPaneMode } from '../scenes/session/sessionPaneLayoutStore';
import { openContentInBestTarget } from '@/shared/services/workbenchContentService';
import { clearAgentCanvasForPeerSwitch, useAgentCanvasStore } from '../components/panels/content-canvas/stores';
import { useContentResourceStore } from './contentResourceStore';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { registerSettingsDraft, resetSettingsDraftRegistryForTests, getSettingsDraftSnapshot, cancelPendingSettingsNavigation, discardAndContinueSettingsNavigation } from '@/infrastructure/config/settingsDraftRegistry';

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({ currentWorkspace: { id: 'project', rootPath: '/project' },
    recentWorkspaces: [], openedWorkspaces: new Map([['project', { id: 'project', rootPath: '/project' }]]) }) },
}));

beforeEach(() => {
  activateSurface('local');
  let tick = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++tick);
  useSceneStore.getState().resetForPeerSwitch();
  sessionPaneLayoutStore.setState(sessionPaneLayoutStore.getInitialState());
  resetSettingsDraftRegistryForTests();
  flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
  clearAgentCanvasForPeerSwitch();
  useContentResourceStore.setState({ resources: {} });
});
afterEach(() => { resetSettingsDraftRegistryForTests(); vi.restoreAllMocks(); activateSurface('local'); });

it('reveals a primary destination when navigating out of a maximized secondary pane', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('assistant');
  scene.openScene('git');
  await scene.moveScene('git', 'secondary');
  sessionPaneLayoutStore.getState().maximizeContent();
  scene.openScene('terminal');
  expect(useSceneStore.getState().paneSelections.primary).toEqual(sceneSelection('terminal'));
  expect(selectSessionPaneMode(sessionPaneLayoutStore.getState())).not.toBe('content-only');
});

it('reveals a hidden secondary destination reached by navigation history', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('assistant');
  scene.openScene('git');
  await scene.moveScene('git', 'secondary');
  scene.activateScene('assistant');
  sessionPaneLayoutStore.getState().hideContent();
  scene.goBack();
  expect(useSceneStore.getState().activeTabId).toBe('git');
  expect(selectSessionPaneMode(sessionPaneLayoutStore.getState())).not.toBe('chat-only');
});

it('keeps a moved session visible when opening a file from that conversation', async () => {
  const session: Session = { sessionId: 'a', title: 'A', dialogTurns: [], status: 'idle', config: {},
    sessionKind: 'normal', createdAt: 1, lastActiveAt: 1, error: null, workspacePath: '/project', workspaceId: 'project' };
  flowChatStore.setState(state => ({ ...state, sessions: new Map([['a', session]]), activeSessionId: 'a' }));
  const target = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'a' };
  const id = getSessionSceneTabId(target);
  const scene = useSceneStore.getState();
  scene.openScene('assistant');
  scene.openSessionScene(target);
  await scene.moveScene(id, 'secondary');
  openContentInBestTarget({ type: 'code-editor', title: 'a.ts', data: { filePath: '/project/a.ts' } });
  expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
  expect(useSceneStore.getState()).toMatchObject({ canvasPane: 'primary', paneSelections: { primary: { kind: 'canvas' }, secondary: sceneSelection(id) } });
});

it('preserves canvas selection when an unrelated primary tab is closed', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('assistant');
  scene.openScene('git');
  await scene.moveScene('git', 'secondary');
  scene.selectCanvas();
  await scene.closeScene('assistant');
  expect(useSceneStore.getState().paneSelections.secondary).toEqual({ kind: 'canvas' });
});

it('restores the remaining session when closing a selected primary page while secondary has command focus', async () => {
  const scene = useSceneStore.getState();
  const target = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'a' };
  const id = getSessionSceneTabId(target);
  scene.openSessionScene(target);
  scene.openScene('git');
  scene.openScene('terminal');
  await scene.moveScene('terminal', 'secondary');
  expect(useSceneStore.getState().paneSelections).toEqual({ primary: sceneSelection('git'), secondary: sceneSelection('terminal') });
  await scene.closeScene('git');
  expect(useSceneStore.getState().paneSelections).toEqual({ primary: sceneSelection(id), secondary: sceneSelection('terminal') });
});

it('does not request settings exit when history changes only the other pane', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('assistant');
  scene.openScene('git');
  scene.openScene('settings');
  await scene.moveScene('settings', 'secondary');
  registerSettingsDraft({ id: 'review-draft', pageId: 'general', label: 'General', dirty: true, save: vi.fn(), discard: vi.fn() });
  scene.goBack();
  expect(getSettingsDraftSnapshot().pendingNavigation).toBeNull();
});


it.each(['primary', 'secondary'] as const)('guards a history destination replacing settings in %s, and supports cancellation', async pane => {
  const scene = useSceneStore.getState();
  scene.openScene('git');
  await scene.moveScene('git', pane);
  scene.openScene('settings');
  await scene.moveScene('settings', pane);
  registerSettingsDraft({ id: 'history-draft', pageId: 'general', label: 'General', dirty: true, save: vi.fn(), discard: vi.fn() });
  const before = useSceneStore.getState().paneSelections;
  scene.goBack();
  expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();
  expect(useSceneStore.getState().paneSelections).toBe(before);
  cancelPendingSettingsNavigation();
  await Promise.resolve();
  expect(useSceneStore.getState().paneSelections).toBe(before);
  scene.goBack();
  await discardAndContinueSettingsNavigation();
  expect(useSceneStore.getState().paneSelections[pane]).toEqual(sceneSelection('git'));
});

it('coalesces pointer and focus requests to show canvas through one settings decision', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('settings');
  await scene.moveScene('settings', 'secondary');
  const discard = vi.fn();
  registerSettingsDraft({ id: 'canvas-draft', pageId: 'general', label: 'General', dirty: true, save: vi.fn(), discard });
  scene.selectCanvas();
  const decision = getSettingsDraftSnapshot().pendingNavigation?.id;
  scene.selectCanvas();
  expect(getSettingsDraftSnapshot().pendingNavigation?.id).toBe(decision);
  await discardAndContinueSettingsNavigation();
  expect(discard).toHaveBeenCalledOnce();
  expect(useSceneStore.getState()).toMatchObject({ activeTabId: null, focusedPane: 'secondary', paneSelections: { secondary: { kind: 'canvas' } } });
});

it('changes only command focus when clicking an already selected pane', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('assistant');
  scene.openScene('git');
  await scene.moveScene('git', 'secondary');
  const before = useSceneStore.getState();
  scene.focusPane('primary');
  expect(useSceneStore.getState()).toMatchObject({ activeTabId: 'assistant', focusedPane: 'primary' });
  expect(useSceneStore.getState().paneSelections).toBe(before.paneSelections);
  expect(useSceneStore.getState().navHistory).toBe(before.navHistory);
  expect(useSceneStore.getState().navigationSequence).toBe(before.navigationSequence);
});

it.each(['success', 'failure', 'new-navigation', 'device-epoch'] as const)('activates a session revealed by closing the unfocused pane transactionally: %s', async outcome => {
  const scene = useSceneStore.getState();
  const target = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'a' };
  scene.openSessionScene(target);
  scene.openScene('git');
  scene.openScene('terminal');
  await scene.moveScene('terminal', 'secondary');
  let complete!: (ok: boolean) => void;
  const activate = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
  const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false, activate });
  try {
    const close = scene.closeScene('git');
    expect(activate).toHaveBeenCalledWith(target, expect.any(Function));
    expect(useSceneStore.getState().paneSelections.primary).toEqual(sceneSelection('git'));
    if (outcome === 'new-navigation') scene.openScene('assistant');
    if (outcome === 'device-epoch') { activateSurface('peer:review'); activateSurface('local'); }
    complete(outcome !== 'failure');
    await close;
    expect(useSceneStore.getState().pendingTabId).toBeNull();
    expect(useSceneStore.getState().openTabs.some(tab => tab.id === 'git')).toBe(outcome !== 'success');
    expect(useSceneStore.getState().activeTabId).toBe(outcome === 'new-navigation' ? 'assistant' : 'terminal');
    if (outcome === 'success') expect(useSceneStore.getState().paneSelections.primary).toEqual(sceneSelection(getSessionSceneTabId(target)));
  } finally { stop(); }
});

it('does not apply a delayed draft decision after a device round trip', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('settings');
  registerSettingsDraft({ id: 'stale-draft', pageId: 'general', label: 'General', dirty: true, save: vi.fn(), discard: vi.fn() });
  scene.openScene('git');
  expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();
  activateSurface('peer:review');
  activateSurface('local');
  await discardAndContinueSettingsNavigation();
  expect(useSceneStore.getState().activeTabId).toBe('settings');
  expect(useSceneStore.getState().openTabs.some(tab => tab.id === 'git')).toBe(false);
});

it('places canvas opposite a session revealed by close fallback, even after presenting sessions in both panes', async () => {
  const scene = useSceneStore.getState();
  const first = { surfaceId: 'local', workspaceKey: 'a', sessionId: 'a' };
  const second = { surfaceId: 'local', workspaceKey: 'b', sessionId: 'b' };
  scene.openSessionScene(first);
  await scene.moveScene(getSessionSceneTabId(first), 'secondary');
  scene.openSessionScene(second);
  await scene.moveScene(getSessionSceneTabId(second), 'primary');
  scene.openScene('git');
  scene.openScene('terminal');
  await scene.moveScene('terminal', 'secondary');
  expect(useSceneStore.getState().canvasPane).toBe('secondary');
  await scene.closeScene('terminal');
  expect(useSceneStore.getState().canvasPane).toBe('primary');
  scene.revealCanvas();
  expect(useSceneStore.getState().paneSelections).toEqual({ primary: { kind: 'canvas' }, secondary: sceneSelection(getSessionSceneTabId(first)) });
});

it('cancels a move replacing dirty settings without changing either pane or its visibility', async () => {
  const scene = useSceneStore.getState();
  scene.openScene('settings');
  await scene.moveScene('settings', 'secondary');
  scene.openScene('git');
  sessionPaneLayoutStore.getState().hideContent();
  registerSettingsDraft({ id: 'move-draft', pageId: 'general', label: 'General', dirty: true, save: vi.fn(), discard: vi.fn() });
  const before = useSceneStore.getState();
  const move = scene.moveScene('git', 'secondary');
  expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();
  cancelPendingSettingsNavigation();
  expect(await move).toBe(false);
  expect(useSceneStore.getState().paneSelections).toBe(before.paneSelections);
  expect(useSceneStore.getState().openTabs).toBe(before.openTabs);
  expect(selectSessionPaneMode(sessionPaneLayoutStore.getState())).toBe('chat-only');
});
