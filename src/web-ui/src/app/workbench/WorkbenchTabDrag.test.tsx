// @vitest-environment jsdom
import { selectedScene } from './scenePaneModel';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkbenchLayout from './WorkbenchLayout';
import { useSceneStore } from '../stores/sceneStore';
import { workbenchPaneLayoutStore } from './workbenchPaneLayoutStore';
import { endSceneTabDrag } from './sceneTabTransfer';
import { CanvasToolbarContribution } from '../components/panels/content-canvas/CanvasToolbar';
import { TabBar } from '../components/panels/content-canvas/tab-bar/TabBar';
import { clearAgentCanvasForPeerSwitch, useAgentCanvasStore } from '../components/panels/content-canvas/stores';
import { useContentResourceStore } from './contentResourceStore';

const paneScenes = () => {
  const selections = useSceneStore.getState().paneSelections;
  return { primary: selectedScene(selections.primary), secondary: selectedScene(selections.secondary) };
};

vi.mock('@/infrastructure/i18n', async original => ({ ...await original<typeof import('@/infrastructure/i18n')>(), useI18n: () => ({ t: (key: string) => key, currentLanguage: 'en-US' }) }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/runtime', async original => ({ ...await original<typeof import('@/infrastructure/runtime')>(), supportsNativeWindowDragging: () => false }));
vi.mock('../scenes/session/AuxPane', () => ({ default: () => {
  const canvas = useAgentCanvasStore();
  return <CanvasToolbarContribution groupId="primary"><TabBar
    tabs={canvas.primaryGroup.tabs} groupId="primary" activeTabId={canvas.primaryGroup.activeTabId}
    isActiveGroup onTabClick={() => {}} onTabDoubleClick={() => {}} onTabClose={() => {}} onTabPin={() => {}}
    onDragStart={payload => canvas.startDrag(payload.tabId, payload.sourceGroupId)} onDragEnd={canvas.endDrag}
    draggingTabId={canvas.draggingTabId} onReorderTab={() => {}} onTabPopOut={() => {}}
  /></CanvasToolbarContribution>;
} }));

// Match the native data-store phases: formats are visible during dragover,
// payloads become readable only on drop. Each phase has a fresh wrapper.
function drag() {
  const entries = new Map<string, string>();
  let effectAllowed = 'uninitialized';
  return (type: string) => {
    const data = {
      get types() { return [...entries.keys()]; },
      get effectAllowed() { return effectAllowed; },
      set effectAllowed(value: string) { if (type === 'dragstart') effectAllowed = value; },
      setData: (key: string, value: string) => { if (type === 'dragstart') entries.set(key, value); },
      getData: (key: string) => type === 'dragover' ? '' : entries.get(key) ?? '',
    };
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: data });
    return event;
  };
}

describe('workbench header drag event integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1201, left: 0 } as DOMRect);
    useSceneStore.getState().resetForPeerSwitch();
    workbenchPaneLayoutStore.setState(workbenchPaneLayoutStore.getInitialState());
    clearAgentCanvasForPeerSwitch();
    useContentResourceStore.setState({ resources: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    endSceneTabDrag();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = () => act(() => root.render(<WorkbenchLayout><main /></WorkbenchLayout>));
  const scene = (id: string) => container.querySelector<HTMLElement>(`[data-scene-tab-id="${id}"]`)!;
  const primary = () => container.querySelector<HTMLElement>('[data-workbench-pane="primary"]')!;
  const secondary = () => container.querySelector<HTMLElement>('.openbitfun-scene-top-bar__panel-region')!;
  const header = () => container.querySelector<HTMLElement>('.openbitfun-scene-top-bar')!;
  const slot = (name: string) => header().querySelector<HTMLElement>(`:scope > [data-openbitfun-part="${name}"]`)!;

  async function move(source: HTMLElement, target: () => HTMLElement) {
    const event = drag();
    act(() => source.dispatchEvent(event('dragstart')));
    expect(source.isConnected).toBe(true);
    const over = event('dragover');
    act(() => target().dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    const drop = event('drop');
    await act(async () => { target().dispatchEvent(drop); });
    act(() => source.dispatchEvent(event('dragend')));
    expect(drop.defaultPrevented).toBe(true);
  }

  it.each([false, true])('moves scene tabs both ways with the panel initially open: %s', async open => {
    useSceneStore.getState().openScene('git');
    useSceneStore.getState().openScene('settings');
    if (open) workbenchPaneLayoutStore.getState().showContent();
    render();
    await move(scene('settings'), secondary);
    expect(paneScenes()).toEqual({ primary: 'git', secondary: 'settings' });
    await move(scene('settings'), primary);
    expect(paneScenes()).toEqual({ primary: 'settings', secondary: null });
  });

  it.each([false, true])('receives a drop on the advertised destination before native capture cleanup (open: %s)', async open => {
    useSceneStore.getState().openScene('git');
    if (open) workbenchPaneLayoutStore.getState().showContent();
    render();
    // Trusted native events can run React's queued microtask between native
    // listeners; dispatchEvent alone keeps all listeners on one JS stack.
    const checkpoint = () => flushSync(() => {});
    window.addEventListener('drop', checkpoint, true);
    try {
      await move(scene('git'), secondary);
      expect(paneScenes().secondary).toBe('git');
      await move(scene('git'), primary);
      expect(paneScenes().primary).toBe('git');
    } finally { window.removeEventListener('drop', checkpoint, true); }
  });

  it.each(['right', 'left'] as const)('accepts the whole header slot, including its padding, with the secondary pane on the %s', async side => {
    useSceneStore.getState().openScene('git');
    useSceneStore.getState().openScene('settings');
    workbenchPaneLayoutStore.getState().showContent();
    if (side === 'left') workbenchPaneLayoutStore.getState().swapPanes();
    render();
    await move(scene('settings'), () => slot(side === 'right' ? 'trailing' : 'leading'));
    expect(paneScenes().secondary).toBe('settings');
    await move(scene('settings'), () => slot(side === 'right' ? 'leading' : 'trailing'));
    expect(paneScenes().primary).toBe('settings');
  });

  it.each([false, true])('advertises both halves, follows nested targets, and restores chrome after cancellation (open: %s)', open => {
    useSceneStore.getState().openScene('git');
    useSceneStore.getState().openScene('settings');
    const pane = workbenchPaneLayoutStore.getState();
    pane.resizeRightPane(640);
    if (open) pane.showContent();
    render();
    const source = scene('git');
    const event = drag();
    const body = container.querySelector<HTMLElement>('[data-openbitfun-component="split-view"][data-openbitfun-part="root"]')!;
    const originalColumns = body.style.cssText;
    const originalHeaderClass = header().className;
    act(() => source.dispatchEvent(event('dragstart')));
    expect(header().dataset.tabDragActive).toBe('true');
    expect(header().querySelector('[role="status"]')).toBeNull();
    expect(header().textContent).not.toContain('canvas.dragTabHere');
    expect(header().dataset.panelOpen).toBe(String(open));
    expect(header().className).toBe(originalHeaderClass);
    expect(scene('git')).toBe(source);
    act(() => secondary().dispatchEvent(event('dragover')));
    expect(header().dataset.tabDropTarget).toBe('trailing');
    // SceneBar stops bubbling; capture must still update the whole half.
    act(() => scene('settings').dispatchEvent(event('dragover')));
    expect(header().dataset.tabDropTarget).toBe('leading');
    act(() => source.dispatchEvent(event('dragend')));
    expect(header().dataset.tabDragActive).toBeUndefined();
    expect(header().dataset.tabDropTarget).toBeUndefined();
    expect(header().dataset.panelOpen).toBe(String(open));
    expect(body.style.cssText).toBe(originalColumns);
    expect(workbenchPaneLayoutStore.getState().preferredRightPaneWidth).toBe(640);
    expect(scene('git')).toBe(source);
    expect(paneScenes()).toEqual({ primary: 'settings', secondary: null });
  });

  it('groups the shell maximize and collapse controls together and keeps their actions working', () => {
    workbenchPaneLayoutStore.getState().showContent();
    render();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="workbench-toggle-panel"]')!;
    const maximize = container.querySelector<HTMLButtonElement>('[data-testid="workbench-maximize-panel"]')!;
    const actions = toggle.closest('[data-openbitfun-part="group"]')!;
    expect(actions.getAttribute('data-gap')).toBe('sm');
    expect(maximize.closest('[data-openbitfun-part="group"]')).toBe(actions);
    expect(actions.querySelectorAll('button')).toHaveLength(2);
    act(() => maximize.click());
    expect(maximize.getAttribute('aria-pressed')).toBe('true');
    act(() => maximize.click());
    expect(maximize.getAttribute('aria-pressed')).toBe('false');
    act(() => toggle.click());
    expect(header().dataset.panelOpen).toBe('false');
    expect(container.querySelector('[data-testid="workbench-maximize-panel"]')).toBeNull();
  });

  it.each(['right', 'left'] as const)('maximizes secondary tabs with their content and restores both headers (side: %s)', async side => {
    const scenes = useSceneStore.getState();
    scenes.openScene('git');
    scenes.openScene('settings');
    await scenes.moveScene('settings', 'secondary');
    if (side === 'left') workbenchPaneLayoutStore.getState().swapPanes();
    render();
    const maximize = () => container.querySelector<HTMLButtonElement>('[data-testid="workbench-maximize-panel"]')!;
    act(() => maximize().click());
    expect(header().dataset.panelMaximized).toBe('true');
    expect(header().querySelector(':scope > [data-openbitfun-part="leading"]')).toBeNull();
    expect(scene('git')).toBeNull();
    expect(slot('trailing').contains(scene('settings'))).toBe(true);
    expect(header().querySelector('.openbitfun-scene-top-bar__panel-divider')).toBeNull();
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toContain('git');
    act(() => maximize().click());
    expect(header().dataset.panelMaximized).toBeUndefined();
    expect(scene('git')).not.toBeNull();
    expect(scene('settings')).not.toBeNull();
    expect(workbenchPaneLayoutStore.getState().contentSide).toBe(side);
  });

  it('moves a canvas tab into the primary header and then back into the secondary header', async () => {
    useSceneStore.getState().openScene('git');
    workbenchPaneLayoutStore.getState().showContent();
    useAgentCanvasStore.getState().addTab({ type: 'text-viewer', title: 'Note', data: { content: 'draft' } }, 'active');
    render();
    await move(container.querySelector<HTMLElement>('.canvas-tab')!, () => container.querySelector<HTMLElement>('.openbitfun-scene-top-bar > [data-openbitfun-part="leading"]')!);
    const id = useSceneStore.getState().activeTabId!;
    expect(id).toMatch(/^content:/);
    await move(scene(id), secondary);
    expect(paneScenes().secondary).toBe(id);
  });

  it('keeps a returned canvas tab beside the remaining canvas tabs in the same pane row', async () => {
    useSceneStore.getState().openScene('git');
    workbenchPaneLayoutStore.getState().showContent();
    const canvas = useAgentCanvasStore.getState();
    canvas.addTab({ type: 'text-viewer', title: 'First', data: { content: 'first draft' } }, 'active');
    const first = useAgentCanvasStore.getState().primaryGroup.activeTabId!;
    canvas.addTab({ type: 'text-viewer', title: 'Second', data: { content: 'second draft' } }, 'active');
    const second = useAgentCanvasStore.getState().primaryGroup.activeTabId!;
    render();
    const source = container.querySelector<HTMLElement>(`[data-tab-id="${first}"] [draggable="true"]`)!;
    await move(source, primary);
    const promoted = useSceneStore.getState().activeTabId!;
    await move(scene(promoted), secondary);
    const row = scene(promoted).closest('.openbitfun-workbench-layout__pane-tabs');
    expect(row).not.toBeNull();
    expect(row?.contains(container.querySelector(`[data-tab-id="${second}"]`))).toBe(true);
    expect([...row!.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['First', 'Second']);
    expect(paneScenes().secondary).toBe(promoted);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs.map(tab => tab.id)).toEqual([second]);
  });
});
