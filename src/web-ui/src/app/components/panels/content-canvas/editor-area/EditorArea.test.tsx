// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasToolbarHost, CanvasToolbarProvider } from '../CanvasToolbar';
import { useAgentCanvasStore } from '../stores';
import type { EditorGroupId, SplitMode } from '../types';
import { EditorArea } from './EditorArea';

vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../base/FlexiblePanel', () => ({ default: () => null }));

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

  function addTab(groupId: EditorGroupId, title: string = groupId) {
    useAgentCanvasStore.getState().addTab({
      type: 'text-viewer', title, data: { content: title },
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
});
