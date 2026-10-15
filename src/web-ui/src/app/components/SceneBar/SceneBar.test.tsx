// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionMotion } from '@/shared/utils/motionPreference';
import type { SceneTab, SceneTabId } from './types';
import SceneBar from './SceneBar';
import { useSceneStore } from '../../stores/sceneStore';
import { useContentResourceStore } from '../../workbench/contentResourceStore';
import { writeSessionTabDrag } from '../../workbench/canvasTabTransfer';
import { clearAgentCanvasForPeerSwitch, switchAgentCanvasScope, useAgentCanvasStore } from '../panels/content-canvas/stores';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sceneBarStyles = readFileSync(
  resolve(process.cwd(), 'src/app/components/SceneBar/SceneBar.scss'),
  'utf8',
);

const sceneHarness = vi.hoisted(() => ({
  state: {
    openTabs: [
      { id: 'session' as const, lastUsed: 1 },
      { id: 'settings' as const, lastUsed: 2 },
      { id: 'terminal' as const, lastUsed: 3 },
      { id: 'git' as const, lastUsed: 4 },
    ] as SceneTab[],
    activeTabId: 'session' as SceneTabId,
    pendingTabId: null as SceneTabId | null,
    navigationMotion: 'instant' as InteractionMotion,
    sessionTitle: undefined as string | undefined,
    tabDefs: [
      { id: 'session' as const, label: 'Session', Icon: () => null, pinned: true, closable: true, singleton: true, defaultOpen: false },
      { id: 'settings' as const, label: 'Settings', pinned: false, singleton: true, defaultOpen: false },
      { id: 'terminal' as const, label: 'Terminal', pinned: false, singleton: true, defaultOpen: false },
      { id: 'git' as const, label: 'Git', pinned: false, singleton: true, defaultOpen: false },
    ],
  },
  activateScene: vi.fn(),
  closeScene: vi.fn(),
}));

vi.mock('../../hooks/useSceneManager', () => ({
  useSceneManager: () => ({
    ...sceneHarness.state,
    activateScene: sceneHarness.activateScene,
    closeScene: sceneHarness.closeScene,
  }),
}));

vi.mock('../../hooks/useSessionTabLabels', () => ({
  useSessionTabLabels: () => ({ session: { title: sceneHarness.state.sessionTitle ?? '' } }),
}));

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/infrastructure/runtime', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/runtime')>(),
  supportsNativeWindowDragging: () => false,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/components/WindowControls', () => ({
  WindowControls: () => null,
}));

describe('SceneBar overflow navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    activateSurface('local');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sceneHarness.state.activeTabId = 'session';
    sceneHarness.state.pendingTabId = null;
    sceneHarness.state.navigationMotion = 'instant';
    sceneHarness.state.sessionTitle = undefined;
    for (const tab of sceneHarness.state.openTabs) delete tab.session;
    sceneHarness.activateScene.mockReset();
    sceneHarness.closeScene.mockReset();
    clearAgentCanvasForPeerSwitch();
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    activateSurface('local');
  });

  function renderSceneBar() {
    act(() => root.render(<SceneBar />));
  }

  function startSessionTabDrag() {
    const store = useAgentCanvasStore.getState();
    store.addTab({ type: 'code-editor', title: 'a.ts', data: { filePath: '/project/a.ts' },
      metadata: { resourceScope: { surfaceId: 'local', workspacePath: '/project' } } }, 'active');
    const tab = useAgentCanvasStore.getState().primaryGroup.tabs[0];
    store.startDrag(tab.id, 'primary');
    const data = new Map<string, string>();
    const transfer = { get types() { return [...data.keys()]; },
      setData: (type: string, value: string) => { data.set(type, value); },
      getData: (type: string) => data.get(type) ?? '',
    } as DataTransfer;
    writeSessionTabDrag(transfer, tab.id, 'primary');
    document.dispatchEvent(dragEvent('dragstart', transfer));
    return transfer;
  }

  function dragEvent(type: string, transfer: DataTransfer, clientX = 0) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    return event;
  }

  it('advertises the destination at dragstart, then distinguishes hover from availability', () => {
    renderSceneBar();
    const bar = container.querySelector<HTMLElement>('.openbitfun-scene-bar')!;
    expect(bar.dataset.canvasDropState).toBeUndefined();
    let transfer!: DataTransfer;
    act(() => { transfer = startSessionTabDrag(); });
    expect(bar.dataset.canvasDropState).toBe('available');
    const hint = container.querySelector<HTMLElement>('[data-openbitfun-part="dropHint"]')!;
    expect(hint.querySelector('[aria-hidden="false"]')?.textContent).toBe('workbench.dragToPopOut');
    expect(container.querySelector('[data-canvas-drop-position]')).toBeNull();
    expect(useContentResourceStore.getState().resources).toEqual({});

    act(() => bar.dispatchEvent(dragEvent('dragover', transfer)));
    expect(bar.dataset.canvasDropState).toBe('active');
    expect(hint.querySelector('[aria-hidden="false"]')?.textContent).toBe('workbench.releaseToPopOut');
    act(() => bar.dispatchEvent(dragEvent('dragleave', transfer)));
    expect(bar.dataset.canvasDropState).toBe('available');
    expect(hint.querySelector('[aria-hidden="false"]')?.textContent).toBe('workbench.dragToPopOut');
    expect(container.querySelector('[data-canvas-drop-position]')).toBeNull();
    act(() => window.dispatchEvent(new Event('dragend')));
    expect(bar.dataset.canvasDropState).toBeUndefined();
    expect(container.querySelector('[data-openbitfun-part="dropHint"]')).toBeNull();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
  });

  it('clears its offer after another drop target stops event bubbling', async () => {
    renderSceneBar();
    let transfer!: DataTransfer;
    act(() => { transfer = startSessionTabDrag(); });
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.addEventListener('drop', event => event.stopPropagation());
    await act(async () => {
      elsewhere.dispatchEvent(dragEvent('drop', transfer));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-openbitfun-part="dropHint"]')).toBeNull();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useContentResourceStore.getState().resources).toEqual({});
    elsewhere.remove();
  });

  it.each(['end', 'remove', 'scope-switch', 'device-switch'])('withdraws availability when the source is invalidated: %s', action => {
    renderSceneBar();
    act(() => { startSessionTabDrag(); });
    expect(container.querySelector('[data-openbitfun-part="dropHint"]')).not.toBeNull();
    act(() => {
      const store = useAgentCanvasStore.getState();
      if (action === 'end') store.endDrag();
      if (action === 'remove') store.detachTab(store.draggingTabId!, 'primary');
      if (action === 'scope-switch') switchAgentCanvasScope('another-session');
      if (action === 'device-switch') activateSurface('peer');
    });
    expect(container.querySelector('[data-openbitfun-part="dropHint"]')).toBeNull();
    expect(container.querySelector('[data-canvas-drop-state]')).toBeNull();
  });

  it.each(['Files', 'application/x-openbitfun-scene'])('does not offer pop-out for another drag format: %s', type => {
    renderSceneBar();
    const transfer = { types: [type] } as unknown as DataTransfer;
    act(() => document.dispatchEvent(dragEvent('dragstart', transfer)));
    expect(container.querySelector('[data-openbitfun-part="dropHint"]')).toBeNull();
  });

  it('accepts a session tab over an existing top tab and transfers it at the indicated position', () => {
    useSceneStore.getState().openScene('terminal');
    useSceneStore.getState().openScene('git');
    const transfer = startSessionTabDrag();
    renderSceneBar();
    const destination = container.querySelector<HTMLElement>('[data-scene-tab-id="git"]')!;
    vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 100 } as DOMRect);
    const over = dragEvent('dragover', transfer, 120);
    act(() => destination.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(destination.dataset.canvasDropPosition).toBe('before');
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    act(() => destination.dispatchEvent(dragEvent('drop', transfer, 120)));
    const id = useSceneStore.getState().activeTabId;
    expect(id).toMatch(/^content:/);
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['terminal', id, 'git']);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(container.querySelector('[data-canvas-drop-target="true"]')).toBeNull();
  });

  it('accepts the empty area of the top bar and clears a canceled drag without moving content', () => {
    const transfer = startSessionTabDrag();
    renderSceneBar();
    const bar = container.querySelector<HTMLElement>('.openbitfun-scene-bar')!;
    act(() => bar.dispatchEvent(dragEvent('dragover', transfer)));
    expect(bar.dataset.canvasDropTarget).toBe('true');
    act(() => window.dispatchEvent(new Event('dragend')));
    expect(bar.dataset.canvasDropTarget).toBeUndefined();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
    expect(useContentResourceStore.getState().resources).toEqual({});
    act(() => bar.dispatchEvent(dragEvent('drop', transfer)));
    expect(useSceneStore.getState().activeTabId).toMatch(/^content:/);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
  });

  it('ignores external file drags', () => {
    renderSceneBar();
    const bar = container.querySelector<HTMLElement>('.openbitfun-scene-bar')!;
    const over = dragEvent('dragover', { types: ['Files'] } as unknown as DataTransfer);
    act(() => bar.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
    expect(bar.dataset.canvasDropTarget).toBeUndefined();
    expect(useContentResourceStore.getState().resources).toEqual({});
  });

  function setOverflowMetrics(tabs: HTMLElement, region: HTMLElement) {
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 240 });
    Object.defineProperty(tabs, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(tabs, 'scrollWidth', { configurable: true, value: 620 });
    Object.defineProperty(tabs, 'scrollLeft', { configurable: true, value: 0, writable: true });
  }

  it('uses the real session title as the single label and keeps Settings static', () => {
    sceneHarness.state.sessionTitle = 'Investigate top tabs';
    renderSceneBar();

    const sessionTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="session"]')!;
    const settingsTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="settings"]')!;

    expect(sessionTab.querySelector('[data-openbitfun-part="label"]')?.textContent)
      .toBe('Investigate top tabs');
    expect(settingsTab.querySelector('[data-openbitfun-part="label"]')?.textContent)
      .toBe('Settings');
    expect(sessionTab.querySelector('[data-openbitfun-part="icon"]')).toBeNull();
    expect(sessionTab.closest('[data-openbitfun-part="item"]')?.getAttribute('data-has-icon'))
      .toBe('false');
    expect(sessionTab.closest('[data-openbitfun-part="item"]')?.hasAttribute('data-overflow-trigger'))
      .toBe(true);
    expect(sessionTab.querySelector('[data-openbitfun-part="label"]')?.getAttribute('data-overflow-behavior'))
      .toBe('marquee');
    expect(container.querySelector('[data-scene-bar-part="tabs"]')?.getAttribute('data-size'))
      .toBe('sm');
    expect(container.querySelector('.openbitfun-scene-bar__tab-subtitle')).toBeNull();
    expect(container.querySelector('.openbitfun-scene-bar__tab-separator')).toBeNull();
  });

  it('delegates arrow and Home/End navigation to TabGroup', () => {
    renderSceneBar();
    const sessionTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="session"]');
    const settingsTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="settings"]');
    expect(sessionTab).not.toBeNull();
    expect(settingsTab).not.toBeNull();

    sessionTab!.focus();
    act(() => {
      sessionTab!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(sceneHarness.activateScene).toHaveBeenCalledWith('settings');
    expect(document.activeElement).toBe(settingsTab);

    act(() => {
      settingsTab!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(sceneHarness.activateScene).toHaveBeenLastCalledWith('git');
  });

  it('keeps the tab and rolling label mounted when its workspace selects another session', () => {
    const sessionSlot = sceneHarness.state.openTabs[0];
    sessionSlot.session = { surfaceId: 'local', workspaceKey: 'workspace-a', sessionId: 'a' };
    sceneHarness.state.sessionTitle = 'First title';
    renderSceneBar();
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="session"]')!;
    const label = tab.querySelector('[data-openbitfun-component="rolling-text"]');
    expect(label).not.toBeNull();
    tab.focus();

    sessionSlot.session = { ...sessionSlot.session, sessionId: 'b' };
    sceneHarness.state.sessionTitle = 'Second title';
    renderSceneBar();
    expect(container.querySelector('[role="tab"][data-openbitfun-value="session"]')).toBe(tab);
    expect(tab.querySelector('[data-openbitfun-component="rolling-text"]')).toBe(label);
    expect(document.activeElement).toBe(tab);
    expect(tab.textContent).toBe('Second title');
    expect(tab.textContent).not.toContain('workspace-a');
  });

  it('marks pending navigation and lets the user return to the displayed tab', () => {
    sceneHarness.state.activeTabId = 'settings';
    sceneHarness.state.pendingTabId = 'session';
    renderSceneBar();
    expect(container.querySelector('[data-scene-bar-part="tabs"]')?.getAttribute('aria-busy')).toBe('true');
    const settings = container.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="settings"]')!;
    act(() => settings.click());
    expect(sceneHarness.activateScene).toHaveBeenCalledWith('settings');
  });

  it('exposes overflow controls and translates a vertical wheel into horizontal movement', () => {
    renderSceneBar();
    const region = container.querySelector<HTMLElement>('[data-openbitfun-component="scene-bar"][data-openbitfun-part="tabs"]')!;
    const tabs = container.querySelector<HTMLElement>('[data-scene-bar-part="tabs"]')!;
    setOverflowMetrics(tabs, region);

    act(() => tabs.dispatchEvent(new Event('scroll')));

    expect(region.dataset.overflow).toBe('true');
    expect(container.querySelector('[data-openbitfun-part="scrollPrevious"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="scrollNext"]')).not.toBeNull();

    act(() => {
      tabs.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 72,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(tabs.scrollLeft).toBe(72);
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-part="scrollPrevious"]')?.disabled).toBe(false);
  });

  it('removes unavailable edge controls from layout and paints the overflow fade directly', () => {
    expect(sceneBarStyles).toMatch(/&:disabled\s*\{\s*display:\s*none;/);
    expect(sceneBarStyles).toContain('background: linear-gradient(');
    expect(sceneBarStyles).not.toContain('mask-image: linear-gradient(');
    expect(sceneBarStyles).not.toContain('backdrop-filter: var(--openbitfun-effect-blur-subtle)');
  });

  it('scrolls a newly active off-screen tab into view', () => {
    renderSceneBar();
    const region = container.querySelector<HTMLElement>('[data-openbitfun-component="scene-bar"][data-openbitfun-part="tabs"]')!;
    const tabs = container.querySelector<HTMLElement>('[data-scene-bar-part="tabs"]')!;
    const gitTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="git"]')!;
    const gitItem = gitTab.closest<HTMLElement>('[data-openbitfun-part="item"]')!;
    setOverflowMetrics(tabs, region);
    Object.defineProperty(gitItem, 'offsetLeft', { configurable: true, value: 420 });
    Object.defineProperty(gitItem, 'offsetWidth', { configurable: true, value: 100 });
    const scrollTo = vi.fn(({ left }: ScrollToOptions) => {
      tabs.scrollLeft = left ?? tabs.scrollLeft;
    });
    Object.defineProperty(tabs, 'scrollTo', { configurable: true, value: scrollTo });

    sceneHarness.state.activeTabId = 'git';
    sceneHarness.state.navigationMotion = 'pointer';
    act(() => root.render(<SceneBar />));

    expect(scrollTo).toHaveBeenCalledWith({ left: 340, behavior: 'smooth' });
  });

  it('renders close actions from closeability metadata, including the leading session tab', () => {
    renderSceneBar();
    const sessionTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="session"]')!;
    const sessionItem = sessionTab.closest<HTMLElement>('[data-openbitfun-part="item"]')!;
    const sessionCloseButton = sessionItem.querySelector<HTMLButtonElement>('[data-scene-bar-part="closeTab"]')!;
    const settingsTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="settings"]')!;
    const settingsItem = settingsTab.closest<HTMLElement>('[data-openbitfun-part="item"]')!;
    const closeButton = settingsItem.querySelector<HTMLButtonElement>('[data-scene-bar-part="closeTab"]')!;

    expect(sessionCloseButton).not.toBeNull();
    act(() => sessionCloseButton.click());
    expect(sceneHarness.closeScene).toHaveBeenCalledWith('session');

    expect(settingsTab.contains(closeButton)).toBe(false);
    act(() => closeButton.click());
    expect(sceneHarness.closeScene).toHaveBeenCalledWith('settings');
  });

  it('keeps close targets out of press transforms so pointer hit testing stays stable', () => {
    renderSceneBar();
    const closeButtons = container.querySelectorAll<HTMLButtonElement>('[data-scene-bar-part="closeTab"]');

    expect(closeButtons.length).toBeGreaterThan(0);
    for (const closeButton of closeButtons) {
      expect(closeButton.dataset.motion).toBe('none');
    }
  });

  it('supports standard middle-click and Delete-key close interactions for session', () => {
    renderSceneBar();
    const sessionTab = container.querySelector<HTMLElement>('[role="tab"][data-openbitfun-value="session"]')!;

    act(() => {
      sessionTab.dispatchEvent(new MouseEvent('auxclick', {
        button: 1,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(sceneHarness.closeScene).toHaveBeenCalledWith('session');

    sceneHarness.closeScene.mockReset();
    act(() => {
      sessionTab.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(sceneHarness.closeScene).toHaveBeenCalledWith('session');
  });
});
