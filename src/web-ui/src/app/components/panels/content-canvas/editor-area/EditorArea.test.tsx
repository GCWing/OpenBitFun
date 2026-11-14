// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasToolbarHost, CanvasToolbarProvider } from '../CanvasToolbar';
import { useAgentCanvasStore } from '../stores';
import type { EditorGroupId, PanelContentType, SplitMode } from '../types';
import { EditorArea } from './EditorArea';

vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../base/FlexiblePanel', () => ({
  default: ({ content, isActive }: { content: { title: string }; isActive: boolean }) => (
    <input data-panel-title={content.title} data-active={isActive} />
  ),
}));

// Exercise real groups, tab bars and toolbar registration without mounting editors.
describe('split canvas tab placement', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    useAgentCanvasStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAgentCanvasStore.getState().reset();
    vi.unstubAllGlobals();
  });

  function addTab(groupId: EditorGroupId, title: string = groupId, type: PanelContentType = 'text-viewer') {
    useAgentCanvasStore.getState().addTab({
      type, title, data: { content: title },
    }, 'active', groupId);
    return useAgentCanvasStore.getState()[`${groupId}Group`].activeTabId!;
  }

  function render(externalToolbar = true) {
    act(() => root.render(<CanvasToolbarProvider>
      <header><CanvasToolbarHost /></header>
      <main><EditorArea externalToolbar={externalToolbar} toolbarActions={<button>Layout</button>} /></main>
    </CanvasToolbarProvider>));
  }

  const headerGroups = () => [...container.querySelectorAll<HTMLElement>('[data-canvas-toolbar-group]')]
    .map(group => group.dataset.canvasToolbarGroup);
  const group = (id: EditorGroupId) => container.querySelector<HTMLElement>(
    `[data-openbitfun-component="canvas-editor-group"][data-openbitfun-group="${id}"]`,
  )!;
  const tab = (id: string) => container.querySelector<HTMLButtonElement>(
    `[role="tab"][data-openbitfun-value="${id}"]`,
  )!;

  it.each([
    ['none', ['primary'], []],
    ['horizontal', ['primary', 'secondary'], []],
    ['vertical', ['primary'], ['secondary']],
    ['grid', ['primary', 'secondary'], ['tertiary']],
  ] as [SplitMode, EditorGroupId[], EditorGroupId[]][])(
    'keeps lower tab bars beside their content in %s mode', (mode, topGroups, lowerGroups) => {
      useAgentCanvasStore.getState().setSplitMode(mode);
      const visibleGroups = [...topGroups, ...lowerGroups];
      visibleGroups.forEach(id => addTab(id));
      render();

      expect(headerGroups()).toEqual(topGroups);
      expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(visibleGroups.length);
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(visibleGroups.length);
      topGroups.forEach(id => expect(group(id).querySelector('[role="tablist"]')).toBeNull());
      lowerGroups.forEach(id => expect(group(id).querySelectorAll('[role="tab"]')).toHaveLength(1));
      expect([...container.querySelectorAll('button')].filter(button => button.textContent === 'Layout')).toHaveLength(1);
      expect(container.querySelector('header')?.textContent).toContain('Layout');
    },
  );

  it('moves tab bars between the header and lower pane when the layout changes', () => {
    useAgentCanvasStore.getState().setSplitMode('horizontal');
    const primaryId = addTab('primary');
    const secondaryId = addTab('secondary');
    render();
    expect(headerGroups()).toEqual(['primary', 'secondary']);

    act(() => useAgentCanvasStore.getState().setSplitMode('vertical'));
    expect(headerGroups()).toEqual(['primary']);
    expect(group('secondary').contains(tab(secondaryId))).toBe(true);

    act(() => useAgentCanvasStore.getState().setSplitMode('horizontal'));
    expect(headerGroups()).toEqual(['primary', 'secondary']);
    expect(group('secondary').querySelector('[role="tablist"]')).toBeNull();

    act(() => useAgentCanvasStore.getState().setSplitMode('none'));
    expect(headerGroups()).toEqual(['primary']);
    expect(container.querySelector('header')?.contains(tab(primaryId))).toBe(true);
    expect(container.querySelector('header')?.contains(tab(secondaryId))).toBe(true);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it('selects and closes tabs in the lower pane through the owning group', () => {
    useAgentCanvasStore.getState().setSplitMode('vertical');
    const primaryId = addTab('primary');
    const firstId = addTab('secondary', 'first');
    const secondId = addTab('secondary', 'second');
    render();

    act(() => tab(firstId).click());
    expect(useAgentCanvasStore.getState().activeGroupId).toBe('secondary');
    expect(useAgentCanvasStore.getState().secondaryGroup.activeTabId).toBe(firstId);
    expect(tab(firstId).getAttribute('aria-selected')).toBe('true');

    act(() => group('secondary').querySelector<HTMLButtonElement>(
      `[data-tab-id="${firstId}"] .canvas-tab__action-btn`,
    )!.click());
    expect(tab(firstId)).toBeNull();
    expect(group('secondary').contains(tab(secondId))).toBe(true);
    expect(useAgentCanvasStore.getState().primaryGroup.activeTabId).toBe(primaryId);
  });

  it('keeps embedded canvas toolbars local', () => {
    useAgentCanvasStore.getState().setSplitMode('vertical');
    addTab('primary');
    addTab('secondary');
    render(false);
    expect(headerGroups()).toEqual([]);
    expect(group('primary').querySelector('[role="tablist"]')).not.toBeNull();
    expect(group('secondary').querySelector('[role="tablist"]')).not.toBeNull();
  });

  it('keeps hidden editors laid out and inert until selected again', () => {
    const editorId = addTab('primary', 'Editor', 'code-editor');
    render();
    let diffId!: string;
    let terminalId!: string;
    act(() => { diffId = addTab('primary', 'Diff', 'diff-code-editor'); });
    act(() => { terminalId = addTab('primary', 'Terminal', 'terminal'); });

    const pane = (title: string) => container.querySelector(`[data-panel-title="${title}"]`)!
      .closest<HTMLElement>('[data-openbitfun-part="tabContent"]')!;
    const inactive = 'canvas-editor-group__tab-content--inactive-editor';
    const editor = pane('Editor');
    const diff = pane('Diff');
    const terminal = pane('Terminal');
    for (const hidden of [editor, diff]) {
      expect(hidden.classList.contains(inactive)).toBe(true);
      expect(hidden.style.display).toBe('');
      expect(hidden.getAttribute('aria-hidden')).toBe('true');
      expect(hidden.hasAttribute('inert')).toBe(true);
      expect(hidden.querySelector('input')?.getAttribute('data-active')).toBe('false');
    }

    for (const [id, title, retained] of [[editorId, 'Editor', editor], [diffId, 'Diff', diff]] as const) {
      act(() => tab(id).click());
      expect(pane(title)).toBe(retained);
      expect(retained.classList.contains(inactive)).toBe(false);
      expect(retained.hasAttribute('inert')).toBe(false);
      expect(retained.hasAttribute('aria-hidden')).toBe(false);
      expect(retained.querySelector('input')?.getAttribute('data-active')).toBe('true');
      expect(terminal.style.display).toBe('none');
      expect(terminal.classList.contains(inactive)).toBe(false);
    }

    act(() => tab(terminalId).click());
    expect(pane('Terminal')).toBe(terminal);
    expect(terminal.style.display).toBe('');
  });
});
