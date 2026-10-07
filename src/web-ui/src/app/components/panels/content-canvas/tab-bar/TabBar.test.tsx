// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabBar, type TabBarProps } from './TabBar';
import type { CanvasTab } from '../types';
import { SESSION_TAB_DRAG_TYPE } from '@/app/workbench/canvasTabTransfer';

const contextMenu = vi.hoisted(() => ({ showMenu: vi.fn() }));

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/context-menu-system/store/ContextMenuStore', () => ({
  useContextMenuStore: (selector: (state: typeof contextMenu) => unknown) => selector(contextMenu),
}));
vi.mock('@/shared/context-menu-system/commands/CommandExecutor', () => ({
  commandExecutor: { execute: vi.fn() },
}));
vi.mock('@/shared/context-menu-system/commands/builtin/file/RevealInExplorerCommand', () => ({
  canRevealInExplorer: () => false,
}));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: { getState: () => ({ currentWorkspace: null }) },
}));
vi.mock('@/shared/utils/tabUtils', () => ({ openFileInBestTarget: vi.fn() }));
vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const documentTab = (id: string, overrides: Partial<CanvasTab> = {}): CanvasTab => ({
  id, title: `${id}.md`, state: 'active', isDirty: false,
  content: { type: 'text-viewer', title: id, data: { content: id } },
  createdAt: 0, lastAccessedAt: 0,
  ...overrides,
});

describe('canvas TabGroup integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: TabBarProps;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    contextMenu.showMenu.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      tabs: [documentTab('a'), documentTab('b', { isDirty: true }), documentTab('c', { state: 'pinned' })],
      groupId: 'primary', activeTabId: 'a', isActiveGroup: true,
      onTabClick: vi.fn(), onTabDoubleClick: vi.fn(), onTabClose: vi.fn(), onTabPin: vi.fn(),
      onDragStart: vi.fn(), onDragEnd: vi.fn(), draggingTabId: null, onReorderTab: vi.fn(),
      onCloseAllTabs: vi.fn(),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const render = () => act(() => root.render(<TabBar {...props} />));
  const tab = (id: string) => container.querySelector<HTMLButtonElement>(`[role="tab"][data-openbitfun-value="${id}"]`)!;
  const wrapper = (id: string) => container.querySelector<HTMLElement>(`.canvas-tab[data-tab-id="${id}"]`)!;

  it('adds the session-to-workbench drag format only when pop-out is available', () => {
    props.onTabPopOut = vi.fn();
    render();
    const setData = vi.fn();
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: { setData } });
    act(() => wrapper('a').dispatchEvent(event));
    const payload = setData.mock.calls.find(([type]) => type === SESSION_TAB_DRAG_TYPE)?.[1];
    expect(JSON.parse(payload)).toMatchObject({ tabId: 'a', groupId: 'primary', surfaceId: 'local' });
    expect(props.onDragStart).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'a', sourceGroupId: 'primary' }));

    props.onTabPopOut = undefined;
    render();
    setData.mockClear();
    act(() => wrapper('a').dispatchEvent(event));
    expect(setData.mock.calls.some(([type]) => type === SESSION_TAB_DRAG_TYPE)).toBe(false);
  });

  it('keeps one tablist and routes pointer and keyboard selection once', () => {
    render();
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(tab('a').getAttribute('aria-selected')).toBe('true');
    act(() => tab('b').click());
    expect(props.onTabClick).toHaveBeenCalledExactlyOnceWith('b');

    vi.mocked(props.onTabClick).mockClear();
    act(() => tab('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(props.onTabClick).toHaveBeenCalledExactlyOnceWith('c');
    expect(document.activeElement).toBe(tab('c'));
  });

  it('preserves dirty labels and separates close/unpin actions from activation', () => {
    render();
    const close = wrapper('b').querySelector<HTMLButtonElement>('.canvas-tab__action-btn')!;
    expect(tab('b').contains(close)).toBe(false);
    expect(tab('b').textContent).toContain('●');
    act(() => close.click());
    expect(props.onTabClose).toHaveBeenCalledExactlyOnceWith('b');
    expect(props.onTabClick).not.toHaveBeenCalled();

    act(() => wrapper('c').querySelector<HTMLButtonElement>('.canvas-tab__action-btn')!.click());
    expect(props.onTabPin).toHaveBeenCalledExactlyOnceWith('c');
    act(() => tab('c').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })));
    expect(props.onTabClose).toHaveBeenCalledTimes(1);
  });

  it('preserves double-click, context menu and middle-click document actions', () => {
    render();
    act(() => tab('a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(props.onTabDoubleClick).toHaveBeenCalledExactlyOnceWith('a');
    act(() => tab('b').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })));
    expect(props.onTabClose).toHaveBeenCalledExactlyOnceWith('b');
    act(() => tab('c').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    expect(contextMenu.showMenu.mock.calls[0][2]).toMatchObject({ tabId: 'c', metadata: { groupId: 'primary' } });
    expect(contextMenu.showMenu.mock.calls[0][1].map((item: { id: string }) => item.id)).toContain('tab-toggle-pin');
  });

  it('replaces the close-all button with host controls while retaining close-all in the tab menu', () => {
    const hidePanel = vi.fn();
    props.toolbarActions = <button onClick={hidePanel}>Hide panel</button>;
    render();
    expect(container.querySelector('.canvas-tab-bar__close-all')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.canvas-tab-bar__actions button')!.click());
    expect(hidePanel).toHaveBeenCalledTimes(1);
    expect(props.onCloseAllTabs).not.toHaveBeenCalled();

    act(() => tab('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const closeAll = contextMenu.showMenu.mock.calls[0][1].find((item: { id: string }) => item.id === 'tab-close-all');
    expect(closeAll.disabled).toBe(false);

    props.toolbarActions = null;
    render();
    expect(container.querySelector('.canvas-tab-bar__close-all')).toBeNull();
    expect(container.querySelector('.canvas-tab-bar__actions')?.textContent).not.toContain('Hide panel');
  });

  it('retains group identity when dragging and reordering standard tabs', () => {
    props.draggingTabId = 'a';
    render();
    const dataTransfer = { setData: vi.fn(), getData: () => JSON.stringify({ tabId: 'a', sourceGroupId: 'primary' }), effectAllowed: '', dropEffect: '' };
    const dragStart = new Event('dragstart', { bubbles: true });
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer });
    act(() => wrapper('a').dispatchEvent(dragStart));
    expect(props.onDragStart).toHaveBeenCalledWith({ tabId: 'a', sourceGroupId: 'primary', tab: props.tabs[0] });
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    act(() => wrapper('b').dispatchEvent(drop));
    expect(props.onReorderTab).toHaveBeenCalledExactlyOnceWith('a', 1);
  });

  it('keeps overflow tabs keyboard-accessible and removes the menu after space becomes available', () => {
    render();
    const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const toolbar = container.querySelector<HTMLElement>('.canvas-tab-bar')!;
    let width = 120;
    Object.defineProperty(list, 'clientWidth', { get: () => width });
    Object.defineProperty(list, 'scrollWidth', { value: 300 });
    Object.defineProperty(toolbar, 'clientWidth', { get: () => width + 30 });
    vi.spyOn(list, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, right: width } as DOMRect));
    props.tabs.forEach((item, index) => {
      vi.spyOn(wrapper(item.id).parentElement!, 'getBoundingClientRect').mockReturnValue({ left: index * 100, right: (index + 1) * 100 } as DOMRect);
    });

    act(() => list.dispatchEvent(new Event('scroll')));
    expect(container.querySelector('[data-openbitfun-product-part="badge"]')?.textContent).toBe('+2');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    width = 400;
    act(() => list.dispatchEvent(new Event('scroll')));
    expect(container.querySelector('[data-openbitfun-product-component="canvas-tab-overflow"]')).toBeNull();
  });
});
