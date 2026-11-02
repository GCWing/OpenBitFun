import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordInteractionModality } from '@/shared/utils/motionPreference';
import { registerSessionSceneNavigation, useSceneStore } from './sceneStore';
import { getSessionSceneTabId } from '../components/SceneBar/types';
import { useSettingsStore } from '../scenes/settings/settingsStore';
import { projectResourceSceneId } from '../scenes/project-resources/projectResourceTarget';
const sessionTarget = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'current' };
const sessionTabId = getSessionSceneTabId(sessionTarget);
import {
  discardAndContinueSettingsNavigation,
  getSettingsDraftSnapshot,
  registerSettingsDraft,
  resetSettingsDraftRegistryForTests,
} from '@/infrastructure/config/settingsDraftRegistry';

describe('sceneStore transition snapshots', () => {
  beforeEach(() => {
    recordInteractionModality('programmatic');
    resetSettingsDraftRegistryForTests();
    useSceneStore.getState().resetForPeerSwitch();
  });

  afterEach(() => {
    resetSettingsDraftRegistryForTests();
    vi.restoreAllMocks();
  });

  it('starts on the welcome surface without creating a tab', () => {
    const state = useSceneStore.getState();

    expect(state.openTabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.navHistory).toEqual([]);
    expect(state.navCursor).toBe(-1);
  });

  it('redirects legacy external-import scenes into the settings destination', () => {
    useSceneStore.getState().openScene('ecosystem-compatibility');
    expect(useSettingsStore.getState().activePageId).toBe('tools.external-import');
    expect(useSceneStore.getState().activeTabId).toBe('settings');
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['settings']);
  });

  it('reuses each project resource tab and supports history without activating a session', () => {
    const first = projectResourceSceneId({ surfaceId: 'local', workspaceId: 'a' });
    const second = projectResourceSceneId({ surfaceId: 'local', workspaceId: 'b' });
    const activate = vi.fn();
    const stop = registerSessionSceneNavigation({ current: () => sessionTarget, isActive: () => true, activate });
    try {
      const scenes = useSceneStore.getState();
      scenes.openScene(first);
      scenes.openScene(second);
      scenes.openScene(first);
      expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([first, second]);
      scenes.goBack();
      expect(useSceneStore.getState().activeTabId).toBe(second);
      scenes.closeScene(second);
      expect(useSceneStore.getState().activeTabId).toBe(first);
      expect(activate).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('keeps the five most recently opened sessions per workspace, moving repeats to the front', () => {
    const scenes = useSceneStore.getState();
    for (let index = 1; index <= 7; index++) {
      scenes.openSessionScene({ ...sessionTarget, sessionId: String(index) });
    }
    scenes.openSessionScene({ ...sessionTarget, sessionId: '4' });
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
    expect(useSceneStore.getState().openTabs[0].sessionHistory).toEqual(['4', '7', '6', '5', '3']);
    scenes.openSessionScene({ ...sessionTarget, workspaceKey: 'other', sessionId: 'elsewhere' });
    expect(useSceneStore.getState().openTabs.map(tab => tab.sessionHistory))
      .toEqual([['4', '7', '6', '5', '3'], ['elsewhere']]);
  });

  it('accepts legacy tabs without history and records background session changes without stealing focus', () => {
    const scenes = useSceneStore.getState();
    scenes.openSessionScene(sessionTarget);
    useSceneStore.setState(state => ({ openTabs: state.openTabs.map(({ sessionHistory: _history, ...tab }) => tab) }));
    scenes.openScene('git');
    scenes.updateSessionScene({ ...sessionTarget, sessionId: 'next' });
    expect(useSceneStore.getState().activeTabId).toBe('git');
    expect(useSceneStore.getState().openTabs[0].sessionHistory).toEqual(['next', 'current']);
    scenes.resetForPeerSwitch();
    expect(useSceneStore.getState().openTabs).toEqual([]);
  });

  it('does not add a failed session activation to the recent list', async () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    const stop = registerSessionSceneNavigation({
      current: () => sessionTarget,
      isActive: target => target.sessionId === sessionTarget.sessionId,
      activate: async () => false,
    });
    try {
      useSceneStore.getState().openSessionScene({ ...sessionTarget, sessionId: 'failed' });
      await vi.waitFor(() => expect(useSceneStore.getState().pendingTabId).toBeNull());
      expect(useSceneStore.getState().openTabs[0].sessionHistory).toEqual(['current']);
    } finally { stop(); }
  });

  it('only activates an existing session reference without creating or replacing its workspace tab', () => {
    const onActivated = vi.fn();
    useSceneStore.getState().activateSessionScene(sessionTarget, { onActivated });
    expect(useSceneStore.getState().openTabs).toEqual([]);
    expect(onActivated).not.toHaveBeenCalled();

    useSceneStore.getState().openSessionScene(sessionTarget);
    useSceneStore.getState().openScene('git');
    const tabs = useSceneStore.getState().openTabs;
    useSceneStore.getState().activateSessionScene({ ...sessionTarget, sessionId: 'different' }, { onActivated });
    expect(useSceneStore.getState().openTabs).toEqual(tabs);
    expect(useSceneStore.getState().activeTabId).toBe('git');
    expect(onActivated).not.toHaveBeenCalled();

    useSceneStore.getState().activateSessionScene(sessionTarget, { onActivated });
    expect(useSceneStore.getState().activeTabId).toBe(sessionTabId);
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(tabs.map(tab => tab.id));
    expect(onActivated).toHaveBeenCalledOnce();
  });

  it('uses the same resource activator for history and closing the active tab', async () => {
    const a = { ...sessionTarget, workspaceKey: 'a', sessionId: 'a' };
    const b = { ...sessionTarget, workspaceKey: 'b', sessionId: 'b' };
    useSceneStore.getState().openSessionScene(a);
    useSceneStore.getState().openSessionScene(b);
    let active = b;
    const activations: string[] = [];
    const stop = registerSessionSceneNavigation({
      current: () => active,
      isActive: target => target.sessionId === active.sessionId,
      activate: async target => { active = target; activations.push(target.sessionId); return true; },
    });
    try {
      useSceneStore.getState().goBack();
      await vi.waitFor(() => expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(a)));
      useSceneStore.getState().goForward();
      await vi.waitFor(() => expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(b)));
      useSceneStore.getState().closeScene(getSessionSceneTabId(b));
      await vi.waitFor(() => expect(useSceneStore.getState().activeTabId).toBe(getSessionSceneTabId(a)));
      expect(activations).toEqual(['a', 'b', 'a']);
      expect(useSceneStore.getState().navHistory).not.toContain(getSessionSceneTabId(b));
    } finally { stop(); }
  });

  it('does not focus a session after a newer navigation supersedes its activation', async () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    useSceneStore.getState().openScene('terminal');
    let complete!: (activated: boolean) => void;
    const activation = new Promise<boolean>(resolve => { complete = resolve; });
    const stop = registerSessionSceneNavigation({
      current: () => null,
      isActive: () => false,
      activate: () => activation,
    });
    try {
      useSceneStore.getState().activateScene(sessionTabId);
      expect(useSceneStore.getState().pendingTabId).toBe(sessionTabId);
      useSceneStore.getState().openScene('settings');
      complete(true);
      await activation;
      expect(useSceneStore.getState().activeTabId).toBe('settings');
      expect(useSceneStore.getState().pendingTabId).toBeNull();
    } finally { stop(); }
  });

  it('invalidates pending activation when its workspace tab is retired', async () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    useSceneStore.getState().openScene('terminal');
    let complete!: (activated: boolean) => void;
    const activation = new Promise<boolean>(resolve => { complete = resolve; });
    let isCurrent = () => true;
    const stop = registerSessionSceneNavigation({
      current: () => null,
      isActive: () => false,
      activate: (_target, current) => { isCurrent = current; return activation; },
    });
    try {
      useSceneStore.getState().activateScene(sessionTabId);
      useSceneStore.getState().reconcileSessionScenes(new Map());
      expect(isCurrent()).toBe(false);
      expect(useSceneStore.getState().pendingTabId).toBeNull();
      complete(true);
      await activation;
      expect(useSceneStore.getState().activeTabId).toBe('terminal');
      expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['terminal']);
    } finally { stop(); }
  });

  it('keeps recoverable tabs when resource activation is unsuccessful', async () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    useSceneStore.getState().openScene('terminal');
    const stop = registerSessionSceneNavigation({
      current: () => null,
      isActive: () => false,
      activate: async () => false,
    });
    try {
      useSceneStore.getState().activateScene(sessionTabId);
      await vi.waitFor(() => expect(useSceneStore.getState().pendingTabId).toBeNull());
      expect(useSceneStore.getState().activeTabId).toBe('terminal');
      expect(useSceneStore.getState().openTabs.some(tab => tab.id === sessionTabId)).toBe(true);
    } finally { stop(); }
  });

  it('rekeys legacy workspace references without duplicating their slot or breaking history', () => {
    const legacy = { ...sessionTarget, workspaceKey: 'legacy-path' };
    useSceneStore.getState().openSessionScene(legacy);
    useSceneStore.getState().openScene('terminal');
    useSceneStore.getState().reconcileSessionScenes(new Map([[sessionTarget.sessionId, sessionTarget]]));
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([sessionTabId, 'terminal']);
    useSceneStore.getState().goBack();
    expect(useSceneStore.getState().activeTabId).toBe(sessionTabId);
    expect(useSceneStore.getState().navHistory).not.toContain(getSessionSceneTabId(legacy));
  });

  it('publishes the first scene switch atomically from the tabless welcome surface', () => {
    const snapshots: Array<{ activeTabId: string | null; openTabIds: string[] }> = [];
    const unsubscribe = useSceneStore.subscribe(state => {
      snapshots.push({
        activeTabId: state.activeTabId,
        openTabIds: state.openTabs.map(tab => tab.id),
      });
    });

    useSceneStore.getState().openScene('settings');
    unsubscribe();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].activeTabId).toBe('settings');
    expect(snapshots[0].openTabIds).toEqual(['settings']);
  });

  it('records pointer scene navigation without animating keyboard activation', () => {
    recordInteractionModality('pointer');
    useSceneStore.getState().openScene('settings');
    expect(useSceneStore.getState().navigationMotion).toBe('pointer');

    recordInteractionModality('keyboard');
    useSceneStore.getState().openSessionScene(sessionTarget);
    expect(useSceneStore.getState().navigationMotion).toBe('instant');
  });

  it('keeps every explicitly opened scene instead of evicting older tabs', () => {
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openScene('terminal');
    useSceneStore.getState().openScene('git');
    useSceneStore.getState().openScene('miniapps');
    useSceneStore.getState().openScene('miniapp:first');
    useSceneStore.getState().openScene('miniapp:second');

    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([
      'settings',
      'terminal',
      'git',
      'miniapps',
      'miniapp:first',
      'miniapp:second',
    ]);
    expect(useSceneStore.getState().activeTabId).toBe('miniapp:second');
  });

  it('activates an existing tab without changing its order or duplicating it', () => {
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openScene('terminal');
    useSceneStore.getState().openScene('settings');

    const state = useSceneStore.getState();
    expect(state.openTabs.map(tab => tab.id)).toEqual([
      'settings',
      'terminal',
    ]);
    expect(state.openTabs.filter(tab => tab.id === 'settings')).toHaveLength(1);
    expect(state.activeTabId).toBe('settings');
  });

  it('closes the last session tab into the tabless welcome state', () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    useSceneStore.getState().closeScene(sessionTabId);

    const state = useSceneStore.getState();
    expect(state.openTabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.navHistory).toEqual([]);
    expect(state.navCursor).toBe(-1);
  });

  it('keeps the session tab first while allowing it to close back to another scene', () => {
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openSessionScene(sessionTarget);

    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([
      sessionTabId,
      'settings',
    ]);

    useSceneStore.getState().closeScene(sessionTabId);

    const state = useSceneStore.getState();
    expect(state.openTabs.map(tab => tab.id)).toEqual(['settings']);
    expect(state.activeTabId).toBe('settings');
    expect(state.navHistory).not.toContain(sessionTabId);
  });

  it('preserves close fallback and history navigation across many open tabs', () => {
    let now = 1;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);

    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openScene('terminal');
    useSceneStore.getState().openScene('git');
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().closeScene('settings');

    const state = useSceneStore.getState();
    expect(state.openTabs.map(tab => tab.id)).toEqual(['terminal', 'git']);
    expect(state.activeTabId).toBe('git');
    expect(state.navHistory).not.toContain('settings');

    useSceneStore.getState().goBack();
    expect(useSceneStore.getState().activeTabId).toBe('terminal');
  });

  it('resets an expanded tab set to the tabless welcome surface when the peer host changes', () => {
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openScene('terminal');
    useSceneStore.getState().openScene('git');
    expect(useSceneStore.getState().openTabs).toHaveLength(3);

    useSceneStore.getState().resetForPeerSwitch();

    const state = useSceneStore.getState();
    expect(state.openTabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.navHistory).toEqual([]);
    expect(state.navCursor).toBe(-1);
  });

  it('keeps Settings active until its draft is resolved before changing scenes', async () => {
    useSceneStore.getState().openSessionScene(sessionTarget);
    useSceneStore.getState().openScene('settings');
    registerSettingsDraft({
      id: 'settings-form',
      pageId: 'application.voice',
      label: 'Voice',
      dirty: true,
      save: vi.fn(),
      discard: vi.fn(),
    });

    useSceneStore.getState().openSessionScene(sessionTarget);
    expect(useSceneStore.getState().activeTabId).toBe('settings');
    expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();

    await discardAndContinueSettingsNavigation();
    expect(useSceneStore.getState().activeTabId).toBe(sessionTabId);
  });

  it('abandons device-owned drafts during the non-interactive peer reset', () => {
    const save = vi.fn();
    const discard = vi.fn();
    registerSettingsDraft({
      id: 'old-device-form',
      pageId: 'application.voice',
      label: 'Voice',
      dirty: true,
      save,
      discard,
    });

    useSceneStore.getState().resetForPeerSwitch();

    expect(getSettingsDraftSnapshot().resources).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('reveals a background Settings tab before asking whether to close its draft', async () => {
    useSceneStore.getState().openScene('settings');
    useSceneStore.getState().openSessionScene(sessionTarget);
    registerSettingsDraft({
      id: 'background-form',
      pageId: 'application.voice',
      label: 'Voice',
      dirty: true,
      save: vi.fn(),
      discard: vi.fn(),
    });

    useSceneStore.getState().closeScene('settings');
    expect(useSceneStore.getState().activeTabId).toBe('settings');
    expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();

    await discardAndContinueSettingsNavigation();
    expect(useSceneStore.getState().openTabs.some(tab => tab.id === 'settings')).toBe(false);
    expect(useSceneStore.getState().activeTabId).toBe(sessionTabId);
  });
});
