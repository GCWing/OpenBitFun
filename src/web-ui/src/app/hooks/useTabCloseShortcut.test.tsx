// @vitest-environment jsdom
import React, { act, createRef, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Portal } from '@openbitfun/ui';
import { shortcutManager } from '@/infrastructure/services/ShortcutManager';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useConfirmDialogStore } from '@/infrastructure/confirm-dialog/confirmDialogService';
import {
  cancelPendingSettingsNavigation, discardAndContinueSettingsNavigation, getSettingsDraftSnapshot,
  registerSettingsDraft, resetSettingsDraftRegistryForTests,
} from '@/infrastructure/config/settingsDraftRegistry';
import { resetSceneStoreForTest, useSceneStore } from '../stores/sceneStore';
import { getSessionSceneTabId } from '../components/SceneBar/types';
import { useGlobalSceneShortcuts } from './useGlobalSceneShortcuts';
import { useKeyboardShortcuts } from '../components/panels/content-canvas/hooks/useKeyboardShortcuts';
import { useTabLifecycle } from '../components/panels/content-canvas/hooks/useTabLifecycle';
import {
  CanvasStoreModeContext, clearAgentCanvasForPeerSwitch, useAgentCanvasStore, useBottomTerminalCanvasStore,
} from '../components/panels/content-canvas/stores';
import type { EditorGroupId } from '../components/panels/content-canvas/types';

const host = vi.hoisted(() => ({ destroyTerminal: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/services/destroyTerminalSession', () => ({ destroyTerminalSession: host.destroyTerminal }));
vi.mock('@/shared/services/workbenchContentService', () => ({ openCanvasContent: vi.fn(), openContentInBestTarget: vi.fn() }));
vi.mock('@/shared/services/pendingTabQueue', () => ({ drainPendingTabs: () => [] }));
vi.mock('@/flow_chat/services/BtwSessionLifecycle', () => ({
  discardBtwSession: vi.fn(), saveBtwSessionAsFork: vi.fn(), canSaveBtwSessionAsFork: () => false,
}));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: new Map() }) } }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const session = { surfaceId: 'local', workspaceKey: 'project', sessionId: 'conversation' };
const sessionTabId = getSessionSceneTabId(session);

function GlobalShortcuts() { useGlobalSceneShortcuts(); return null; }
function CanvasShortcuts({ enabled = true }: { enabled?: boolean }) {
  const mode = useContext(CanvasStoreModeContext);
  const { handleCloseWithDirtyCheck } = useTabLifecycle({ mode });
  useKeyboardShortcuts({ enabled, handleCloseWithDirtyCheck });
  return null;
}
function Fixture({ canvasEnabled = true, bottom = false }: { canvasEnabled?: boolean; bottom?: boolean }) {
  return <>
    <GlobalShortcuts />
    <textarea data-testid="chat" data-shortcut-scope="chat"
      onFocus={() => useSceneStore.getState().focusPane('primary')} />
    <div data-shortcut-scope="canvas" data-canvas-mode="agent"
      onFocus={() => useSceneStore.getState().focusPane(useSceneStore.getState().canvasPane)}>
      <CanvasStoreModeContext.Provider value="agent"><CanvasShortcuts enabled={canvasEnabled} /></CanvasStoreModeContext.Provider>
      {(['primary', 'secondary', 'tertiary'] as const).map(group => <div key={group} data-openbitfun-group={group}>
        <textarea data-testid={`editor-${group}`} data-shortcut-scope="editor" />
        <textarea data-testid={`terminal-${group}`} data-shortcut-scope="terminal" />
      </div>)}
    </div>
    {bottom && <div data-shortcut-scope="canvas" data-canvas-mode="bottom-terminal">
      <CanvasStoreModeContext.Provider value="bottom-terminal"><CanvasShortcuts /></CanvasStoreModeContext.Provider>
      <textarea data-testid="bottom-terminal" data-shortcut-scope="terminal" />
    </div>}
  </>;
}

describe('close-tab keyboard ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  let primaryModifier: KeyboardEventInit;
  const setPlatform = (platform: string) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    primaryModifier = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true };
  };
  const press = async (target: string | HTMLElement, extra: KeyboardEventInit = {}) => {
    const element = typeof target === 'string' ? container.querySelector<HTMLElement>(`[data-testid="${target}"]`)! : target;
    const event = new KeyboardEvent('keydown', { key: 'w', ...primaryModifier, bubbles: true, cancelable: true, ...extra });
    await act(async () => { element.focus(); element.dispatchEvent(event); });
    return event;
  };
  const addFile = (group: EditorGroupId = 'primary') => {
    useAgentCanvasStore.getState().addTab({ type: 'code-editor', title: group, data: { filePath: `/project/${group}.ts` } }, 'active', group);
    return useAgentCanvasStore.getState()[`${group}Group`].activeTabId!;
  };
  const render = async (props: React.ComponentProps<typeof Fixture> = {}) => {
    await act(async () => root.render(<Fixture {...props} />));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    host.destroyTerminal.mockResolvedValue(undefined);
    activateSurface('local');
    resetSceneStoreForTest();
    resetSettingsDraftRegistryForTests();
    clearAgentCanvasForPeerSwitch();
    useAgentCanvasStore.getState().reset();
    useBottomTerminalCanvasStore.getState().reset();
    shortcutManager.clear();
    shortcutManager.loadUserOverrides({});
    shortcutManager.setEnabled(true);
    setPlatform('Win32');
    useSceneStore.getState().openSessionScene(session);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { useConfirmDialogStore.getState().cancel(); });
    await act(async () => root.unmount());
    container.remove();
    shortcutManager.clear();
    shortcutManager.loadUserOverrides({});
    activateSurface('local');
    resetSettingsDraftRegistryForTests();
    vi.restoreAllMocks();
  });

  it.each(['Win32', 'Linux x86_64', 'MacIntel'])('closes only the conversation from the middle input on %s', async platform => {
    setPlatform(platform);
    const file = addFile();
    await render();
    const event = await press('chat');
    expect(event.defaultPrevented).toBe(true);
    expect(useSceneStore.getState().openTabs).toEqual([]);
    expect(useAgentCanvasStore.getState().primaryGroup.activeTabId).toBe(file);
  });

  it.each(['Win32', 'Linux x86_64', 'MacIntel'])('closes only the right file from its editor on %s', async platform => {
    setPlatform(platform);
    addFile();
    await render();
    const event = await press('editor-primary');
    expect(event.defaultPrevented).toBe(true);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([sessionTabId]);
  });

  it.each(['Win32', 'Linux x86_64', 'MacIntel'])('closes the right terminal through its lifecycle on %s', async platform => {
    setPlatform(platform);
    useAgentCanvasStore.getState().addTab({ type: 'terminal', title: 'right', data: { sessionId: 'right-pty' } }, 'active');
    useBottomTerminalCanvasStore.getState().addTab({ type: 'terminal', title: 'bottom', data: { sessionId: 'bottom-pty' } }, 'active');
    await render({ bottom: true });
    await press('terminal-primary');
    expect(host.destroyTerminal).toHaveBeenCalledExactlyOnceWith('right-pty');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(useBottomTerminalCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([sessionTabId]);
    await press('bottom-terminal');
    expect(host.destroyTerminal).toHaveBeenLastCalledWith('bottom-pty');
    expect(useBottomTerminalCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('detaches a persistent workspace terminal without destroying its process', async () => {
    useAgentCanvasStore.getState().addTab({ type: 'terminal', title: 'Shell', data: { sessionId: 'pty' }, metadata: { terminalCloseBehavior: 'detach' } }, 'active');
    await render();
    await press('terminal-primary');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(host.destroyTerminal).not.toHaveBeenCalled();
  });

  it('uses the keyboard-focused third split even when the stored active group is different', async () => {
    useAgentCanvasStore.getState().setSplitMode('grid');
    addFile('primary'); addFile('secondary'); addFile('tertiary');
    useAgentCanvasStore.getState().setActiveGroup('primary');
    await render();
    await press('editor-tertiary');
    expect(useAgentCanvasStore.getState().tertiaryGroup.tabs).toEqual([]);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useAgentCanvasStore.getState().secondaryGroup.tabs).toHaveLength(1);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('routes the external tab strip to its canvas and focused group', async () => {
    useAgentCanvasStore.getState().setSplitMode('horizontal');
    addFile('primary'); addFile('secondary');
    await render();
    const strip = document.createElement('div');
    strip.innerHTML = '<div data-shortcut-scope="canvas" data-canvas-mode="agent"><button data-canvas-toolbar-group="primary">File</button></div>';
    container.append(strip);
    await press(strip.querySelector('button')!);
    // The surviving secondary group is merged into primary by the close lifecycle.
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.title)).toEqual(['secondary']);
    expect(useAgentCanvasStore.getState().secondaryGroup.tabs).toEqual([]);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('changes the responding region when focus moves from the right editor back to chat', async () => {
    addFile();
    useAgentCanvasStore.getState().addTab({ type: 'code-editor', title: 'second', data: { filePath: '/project/second.ts' } }, 'active');
    await render();
    await press('editor-primary');
    expect(useSceneStore.getState().activeTabId).toBeNull();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    await press('chat');
    expect(useSceneStore.getState().openTabs).toEqual([]);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
  });

  it('retains right-pane ownership when closing a tab leaves keyboard focus on the document body', async () => {
    addFile();
    useAgentCanvasStore.getState().addTab({ type: 'code-editor', title: 'second', data: { filePath: '/project/second.ts' } }, 'active');
    await render();
    await press('editor-primary');
    await press(document.body);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('closes the keyboard-focused scene label even when the right pane was previously focused', async () => {
    const file = addFile();
    await render();
    useSceneStore.getState().focusPane('secondary');
    const label = document.createElement('div');
    label.dataset.openbitfunComponent = 'scene-bar';
    label.dataset.sceneTabId = sessionTabId;
    const button = document.createElement('button');
    label.append(button);
    container.append(label);
    await press(button);
    expect(useSceneStore.getState().openTabs).toEqual([]);
    expect(useAgentCanvasStore.getState().primaryGroup.activeTabId).toBe(file);
  });

  it.each([true, false])('never falls through an empty/unavailable right pane to the conversation (enabled=%s)', async canvasEnabled => {
    await render({ canvasEnabled });
    expect((await press('terminal-primary')).defaultPrevented).toBe(true);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('preserves one pending dirty confirmation and respects cancellation', async () => {
    const file = addFile();
    useAgentCanvasStore.getState().setTabDirty(file, 'primary', true);
    await render();
    await press('editor-primary');
    expect(useConfirmDialogStore.getState().isOpen).toBe(true);
    const resolve = useConfirmDialogStore.getState().resolve;
    await press('editor-primary');
    expect(useConfirmDialogStore.getState().resolve).toBe(resolve);
    await act(async () => { useConfirmDialogStore.getState().cancel(); });
    expect(useAgentCanvasStore.getState().primaryGroup.activeTabId).toBe(file);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
    await press('editor-primary');
    await act(async () => { useConfirmDialogStore.getState().confirm(); });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
  });

  it('uses the settings draft guard when closing a top-level settings tab', async () => {
    useSceneStore.getState().openScene('settings');
    registerSettingsDraft({ id: 'form', pageId: 'application.voice', label: 'Voice', dirty: true, save: vi.fn(), discard: vi.fn() });
    await render();
    await press('chat');
    expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();
    expect(useSceneStore.getState().activeTabId).toBe('settings');
    cancelPendingSettingsNavigation();
    expect(useSceneStore.getState().activeTabId).toBe('settings');
    await press('chat');
    await act(async () => { await discardAndContinueSettingsNavigation(); });
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual([sessionTabId]);
  });

  it('does not apply an old close confirmation after a peer surface switch', async () => {
    const file = addFile();
    useAgentCanvasStore.getState().setTabDirty(file, 'primary', true);
    await render();
    await press('editor-primary');
    activateSurface('peer-b');
    await act(async () => { useConfirmDialogStore.getState().confirm(); });
    expect(useAgentCanvasStore.getState().primaryGroup.activeTabId).toBe(file);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it.each([{ repeat: true }, { isComposing: true }, { keyCode: 229 }])('consumes repeated/IME-owned close without closing either region: %o', async extra => {
    addFile();
    await render();
    expect((await press('editor-primary', extra)).defaultPrevented).toBe(true);
    expect((await press('chat', extra)).defaultPrevented).toBe(true);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('does not close the underlying scene while an overlay owns interaction', async () => {
    const surfaceRef = createRef<HTMLDivElement>();
    await act(async () => root.render(<><Fixture /><Portal surfaceRef={surfaceRef}>
      <div ref={surfaceRef}><input data-testid="dialog-input" /></div>
    </Portal></>));
    const input = document.querySelector<HTMLElement>('[data-testid="dialog-input"]')!;
    expect((await press(input)).defaultPrevented).toBe(true);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });

  it('keeps the existing close command override for both regions', async () => {
    addFile();
    shortcutManager.loadUserOverrides({ 'tab.close': { key: 'q', alt: true } });
    await render();
    await press('editor-primary');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    await press('editor-primary', { key: 'q', ctrlKey: false, altKey: true });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toEqual([]);
    await press('chat', { key: 'q', ctrlKey: false, altKey: true });
    expect(useSceneStore.getState().openTabs).toEqual([]);
  });

  it('does not treat macOS Control or extra modifiers as Command+W', async () => {
    setPlatform('MacIntel');
    addFile();
    await render();
    for (const extra of [{ metaKey: false, ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect((await press('editor-primary', extra)).defaultPrevented).toBe(false);
    }
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useSceneStore.getState().openTabs).toHaveLength(1);
  });
});
