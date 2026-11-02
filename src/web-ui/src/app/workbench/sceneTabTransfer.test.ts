import { createPaneState, selectedScene } from './scenePaneModel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSessionSceneNavigation, useSceneStore } from '../stores/sceneStore';
import { getSessionSceneTabId } from '../components/SceneBar/types';
import { sessionPaneLayoutStore, selectSessionPaneMode } from '../scenes/session/sessionPaneLayoutStore';
import { dropSceneTab, endSceneTabDrag, isSceneTabDrag, writeSceneTabDrag } from './sceneTabTransfer';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { registerSettingsDraft, resetSettingsDraftRegistryForTests } from '@/infrastructure/config/settingsDraftRegistry';

const paneScenes = () => {
  const selections = useSceneStore.getState().paneSelections;
  return { primary: selectedScene(selections.primary), secondary: selectedScene(selections.secondary) };
};

function transfer() {
  const data = new Map<string, string>();
  return { get types() { return [...data.keys()]; }, setData: (key: string, value: string) => data.set(key, value),
    getData: (key: string) => data.get(key) ?? '' } as unknown as DataTransfer;
}

beforeEach(() => {
  endSceneTabDrag();
  resetSettingsDraftRegistryForTests();
  useSceneStore.getState().resetForPeerSwitch();
  sessionPaneLayoutStore.setState(sessionPaneLayoutStore.getInitialState());
});

describe('universal workbench pane moves', () => {
  it.each(['settings', 'git', 'terminal', 'browser', 'miniapp:demo'] as const)('moves %s both ways without closing or losing identity', async id => {
    const store = useSceneStore.getState();
    store.openScene('assistant');
    store.openScene(id);
    store.togglePinScene(id);
    const close = vi.spyOn(useSceneStore.getState(), 'closeScene');
    const data = transfer();
    writeSceneTabDrag(data, id);
    expect(isSceneTabDrag(data)).toBe(true);
    expect(await dropSceneTab(data, 'secondary')).toBe(true);
    expect(paneScenes()).toEqual({ primary: 'assistant', secondary: id });
    expect(useSceneStore.getState().openTabs.find(tab => tab.id === id)).toMatchObject({ pane: 'secondary', pinned: true });
    expect(selectSessionPaneMode(sessionPaneLayoutStore.getState())).toBe('split');
    writeSceneTabDrag(data, id);
    expect(await dropSceneTab(data, 'primary')).toBe(true);
    expect(paneScenes()).toEqual({ primary: id, secondary: null });
    expect(useSceneStore.getState().openTabs.filter(tab => tab.id === id)).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it('does not invoke settings exit when moving the settings view and retains the other pane on navigation', async () => {
    const store = useSceneStore.getState();
    store.openScene('settings');
    const discard = vi.fn();
    const stop = registerSettingsDraft({ id: 'move-test', pageId: 'general', label: 'General', dirty: true, save: vi.fn(), discard });
    try {
      await store.moveScene('settings', 'secondary');
      store.openScene('git');
      expect(paneScenes()).toEqual({ primary: 'git', secondary: 'settings' });
      expect(discard).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('restores the remaining session after moving content back to a reopened pane', async () => {
    const target = { surfaceId: 'local', workspaceKey: 'a', sessionId: 'a' };
    const id = getSessionSceneTabId(target);
    const store = useSceneStore.getState();
    store.openSessionScene(target);
    store.openScene('git');
    await store.moveScene('git', 'secondary');
    await store.moveScene('git', 'primary');
    sessionPaneLayoutStore.getState().collapseEmptyContent();
    sessionPaneLayoutStore.getState().showContent();
    await store.moveScene('git', 'secondary');
    expect(paneScenes()).toEqual({ primary: id, secondary: 'git' });
    expect(useSceneStore.getState().activeTabId).toBe('git');
  });

  it.each([false, true])('activates the revealed session before moving, unless superseded: %s', async superseded => {
    const target = { surfaceId: 'local', workspaceKey: 'a', sessionId: 'a' };
    const id = getSessionSceneTabId(target);
    const store = useSceneStore.getState();
    store.openSessionScene(target);
    store.openScene('git');
    let finish!: (ok: boolean) => void;
    const activate = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false, activate });
    try {
      const move = store.moveScene('git', 'secondary');
      expect(activate).toHaveBeenCalledWith(target, expect.any(Function));
      expect(paneScenes()).toEqual({ primary: 'git', secondary: null });
      if (superseded) store.openScene('terminal');
      finish(true);
      expect(await move).toBe(!superseded);
      expect(paneScenes()).toEqual(superseded
        ? { primary: 'terminal', secondary: null }
        : { primary: id, secondary: 'git' });
      expect(useSceneStore.getState().activeTabId).toBe(superseded ? 'terminal' : 'git');
    } finally { stop(); }
  });

  it('moves an inactive session bookmark without presenting the other pane session in its host', async () => {
    const first = { surfaceId: 'local', workspaceKey: 'a', sessionId: 'a' };
    const second = { surfaceId: 'local', workspaceKey: 'b', sessionId: 'b' };
    const store = useSceneStore.getState();
    store.openScene('assistant');
    store.openSessionScene(first);
    store.openSessionScene(second);
    const activate = vi.fn().mockResolvedValue(true);
    const stop = registerSessionSceneNavigation({ current: () => second, isActive: target => target === second, activate });
    try {
      expect(await store.moveScene(getSessionSceneTabId(first), 'secondary')).toBe(true);
      expect(activate).toHaveBeenCalledWith(first, expect.any(Function));
      expect(paneScenes()).toEqual({ primary: 'assistant', secondary: getSessionSceneTabId(first) });
    } finally { stop(); }
  });

  it('closes in its own pane and preserves the other selected page', async () => {
    const store = useSceneStore.getState();
    store.openScene('assistant');
    store.openScene('git');
    await store.moveScene('git', 'secondary');
    store.openScene('terminal');
    await store.moveScene('terminal', 'secondary');
    await store.closeScene('terminal');
    expect(paneScenes()).toEqual({ primary: 'assistant', secondary: 'git' });
    store.selectCanvas();
    expect(paneScenes().secondary).toBeNull();
    store.activateScene('git');
    expect(paneScenes().secondary).toBe('git');
  });

  it('keeps session bookmarks on the authoritative host and cancels an outdated activation before moving', async () => {
    const target = { surfaceId: 'local', workspaceKey: 'a', sessionId: 'a' };
    const id = getSessionSceneTabId(target);
    const store = useSceneStore.getState();
    store.openSessionScene(target);
    store.openScene('git');
    let finish!: (ok: boolean) => void;
    const stop = registerSessionSceneNavigation({ current: () => null, isActive: () => false,
      activate: () => new Promise<boolean>(resolve => { finish = resolve; }) });
    try {
      const data = transfer();
      writeSceneTabDrag(data, id);
      const move = dropSceneTab(data, 'secondary');
      store.openScene('terminal');
      finish(true);
      expect(await move).toBe(false);
      expect(useSceneStore.getState().openTabs.find(tab => tab.id === id)?.pane).toBeUndefined();
    } finally { stop(); }
    await store.moveScene(id, 'secondary');
    expect(paneScenes()).toEqual({ primary: 'terminal', secondary: id });
  });

  it('rejects a closed source, forged payload and completed offers', async () => {
    const store = useSceneStore.getState();
    store.openScene('git');
    const data = transfer();
    writeSceneTabDrag(data, 'git');
    const forged = transfer();
    forged.setData(data.types[0], 'wrong-token');
    expect(await dropSceneTab(forged, 'secondary')).toBe(false);
    await store.closeScene('git');
    expect(await dropSceneTab(data, 'secondary')).toBe(false);
    store.openScene('git');
    writeSceneTabDrag(data, 'git');
    endSceneTabDrag();
    expect(await dropSceneTab(data, 'secondary')).toBe(false);
  });

  it('rejects drags after switching away and back to the same device', async () => {
    const store = useSceneStore.getState();
    store.openScene('git');
    const data = transfer();
    writeSceneTabDrag(data, 'git');
    activateSurface('peer:other');
    activateSurface('local');
    expect(isSceneTabDrag(data)).toBe(false);
    expect(await dropSceneTab(data, 'secondary')).toBe(false);
  });

  it('reads legacy tabs without a pane as primary', () => {
    useSceneStore.setState({ ...createPaneState([{ id: 'git', lastUsed: 1 }], 'git'), activeTabId: 'git' });
    expect(paneScenes()).toEqual({ primary: 'git', secondary: null });
  });
});
