// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SceneTopBar from './SceneTopBar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sceneState = vi.hoisted(() => ({ openTabs: [{}] as unknown[], selectTab: vi.fn(), closeTab: vi.fn() }));
const startDragging = vi.hoisted(() => vi.fn(async () => {}));
const isMaximized = vi.hoisted(() => vi.fn(async () => false));
const isFullscreen = vi.hoisted(() => vi.fn(async () => false));
const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/app/components/SceneTopBar/SceneTopBar.scss'),
  'utf8',
);

vi.mock('@/app/components/WindowControls', () => ({ WindowControls: () => <button>Window controls</button> }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ startDragging, isMaximized, isFullscreen }) }));
vi.mock('../../stores/sceneStore', () => ({ useSceneStore: (selector: (state: typeof sceneState) => unknown) => selector(sceneState) }));
vi.mock('../SceneBar/SceneBar', async () => {
  const { TabGroup } = await import('@openbitfun/ui');
  return {
    default: () => <TabGroup
      value="0"
      onValueChange={sceneState.selectTab}
      items={sceneState.openTabs.map((_, index) => ({
        value: String(index),
        label: <span>Scene {index}</span>,
        endAction: <button onClick={sceneState.closeTab} aria-label={`Close scene ${index}`}>
          <svg><path d="M0 0L1 1" /></svg>
        </button>,
      }))}
    />,
  };
});
vi.mock('./SceneChrome', () => ({
  SceneChromeHost: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>
    <button><svg><path d="M0 0L1 1" /></svg>Scene action</button>
    <input aria-label="Scene search" />
    <div contentEditable suppressContentEditableWarning><span>Editable title</span></div>
  </div>,
}));

describe('SceneTopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMaximized.mockResolvedValue(false);
    isFullscreen.mockResolvedValue(false);
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: vi.fn(),
      metadata: { currentWindow: { label: 'main' } },
    });
    sceneState.openTabs = [{}];
  });

  afterEach(() => vi.unstubAllGlobals());

  it('reclaims the left gutter and extends the divider through the remaining right gap', () => {
    expect(stylesheet).not.toContain('border-block-end: 0;');
    expect(stylesheet).toContain(
      'inset-block-end: calc(0px - var(--openbitfun-border-width-default));',
    );
    expect(stylesheet).toContain('width: var(--openbitfun-space-4);');
    expect(stylesheet).toContain('margin-inline-start: calc(0px - var(--openbitfun-space-4));');
    expect(stylesheet).toContain('inset-inline-start: 100%;');
  });

  it('composes the public Toolbar without changing scene actions or window interaction boundaries', () => {
    sceneState.openTabs = [{}];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const maximize = vi.fn();
    try {
      act(() => root.render(<SceneTopBar onMinimize={vi.fn()} onMaximize={maximize} onClose={vi.fn()} />));
      const toolbar = host.querySelector('[data-openbitfun-component="toolbar"]')!;
      expect(toolbar.getAttribute('data-openbitfun-part')).toBe('topBar');
      expect(toolbar.getAttribute('data-size')).toBe('md');
      expect(toolbar.getAttribute('data-bordered')).toBe('true');
      expect(toolbar.querySelector(':scope > [data-openbitfun-part="leading"] [role="tablist"]')).not.toBeNull();
      const trailing = toolbar.querySelector(':scope > [data-openbitfun-part="trailing"]')!;
      const actions = trailing.querySelector('[data-openbitfun-part="sceneActions"]')!;
      const divider = trailing.querySelector('.openbitfun-scene-top-bar__actions-divider')!;
      const controls = trailing.querySelector('[data-openbitfun-part="controls"]')!;
      expect(actions.nextElementSibling).toBe(divider);
      expect(divider.getAttribute('data-openbitfun-part')).toBe('separator');
      expect(divider.getAttribute('aria-hidden')).toBe('true');
      expect(divider.nextElementSibling).toBe(controls);
      expect(controls.querySelector('button')).not.toBeNull();
      expect(stylesheet).toContain('&__actions:empty + &__actions-divider');
      act(() => toolbar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      expect(maximize).toHaveBeenCalledOnce();
      act(() => toolbar.querySelector('[data-openbitfun-part="sceneActions"] button')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      expect(maximize).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('removes the divider when no scene tabs are open', () => {
    sceneState.openTabs = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<SceneTopBar />));
      expect(host.querySelector('[data-openbitfun-component="toolbar"]')?.getAttribute('data-bordered'))
        .toBe('false');
    } finally {
      act(() => root.unmount());
      host.remove();
      sceneState.openTabs = [{}];
    }
  });

  describe('window gestures', () => {
    let host: HTMLDivElement;
    let root: Root;
    const maximize = vi.fn();

    beforeEach(() => {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    });

    afterEach(() => {
      act(() => root.unmount());
      host.remove();
    });

    function renderBar(tabCount = 1) {
      sceneState.openTabs = Array.from({ length: tabCount }, () => ({}));
      act(() => root.render(<SceneTopBar onMinimize={vi.fn()} onMaximize={maximize} onClose={vi.fn()} />));
      return host.querySelector<HTMLElement>('[data-openbitfun-component="toolbar"]')!;
    }

    async function mouseDown(target: Element, options: MouseEventInit = {}) {
      await act(async () => {
        target.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 0, detail: 1, ...options,
        }));
        await vi.dynamicImportSettled();
      });
    }

    function doubleClick(target: Element) {
      act(() => target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2, cancelable: true })));
    }

    it.each([0, 1, 2, 8])('allows dragging and maximizing empty chrome with %i open tabs', async tabCount => {
      const toolbar = renderBar(tabCount);
      const tabList = toolbar.querySelector('[role="tablist"]')!;
      const leading = toolbar.querySelector(':scope > [data-openbitfun-part="leading"]')!;
      expect(leading.children).toHaveLength(1);
      expect(leading.firstElementChild).toBe(tabList);

      for (const target of [toolbar, leading, tabList]) {
        await mouseDown(target);
        doubleClick(target);
      }
      expect(startDragging).toHaveBeenCalledTimes(3);
      expect(maximize).toHaveBeenCalledTimes(3);
    });

    it('excludes the whole tab from window gestures as other tabs open and close', async () => {
      for (const tabCount of [1, 2, 1]) {
        const toolbar = renderBar(tabCount);
        const tab = toolbar.querySelector('[role="tab"]')!;
        const label = tab.querySelector('[data-openbitfun-part="label"] span')!;
        const item = tab.closest('[data-openbitfun-part="item"]')!;
        for (const target of [tab, label, item]) {
          await mouseDown(target);
          doubleClick(target);
        }
        expect(startDragging).not.toHaveBeenCalled();
        expect(maximize).not.toHaveBeenCalled();
      }
    });

    it('leaves multi-tab labels and item padding to tab interaction', async () => {
      const toolbar = renderBar(2);
      const tab = toolbar.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="1"]')!;
      for (const target of [tab, tab.querySelector('span')!, tab.closest('[data-openbitfun-part="item"]')!]) {
        await mouseDown(target);
        doubleClick(target);
      }
      act(() => tab.click());
      expect(sceneState.selectTab).toHaveBeenCalledWith('1');
      expect(startDragging).not.toHaveBeenCalled();
      expect(maximize).not.toHaveBeenCalled();
    });

    it.each([1, 2])('excludes close buttons, nested SVGs, scene actions and editable fields with %i tabs', async tabCount => {
      const toolbar = renderBar(tabCount);
      for (const target of toolbar.querySelectorAll('button:not([role="tab"]), svg, path, input, [contenteditable] span')) {
        await mouseDown(target);
        doubleClick(target);
      }
      act(() => toolbar.querySelector<HTMLButtonElement>('[aria-label="Close scene 0"]')!.click());
      expect(sceneState.closeTab).toHaveBeenCalledOnce();
      expect(startDragging).not.toHaveBeenCalled();
      expect(maximize).not.toHaveBeenCalled();
    });

    it('uses click detail to preserve double-click maximize without blocking separate drags', async () => {
      const toolbar = renderBar(2);
      await mouseDown(toolbar);
      await mouseDown(toolbar, { detail: 2 });
      doubleClick(toolbar);
      expect(startDragging).toHaveBeenCalledOnce();
      expect(maximize).toHaveBeenCalledOnce();

      await mouseDown(toolbar, { detail: 1 });
      expect(startDragging).toHaveBeenCalledTimes(2);
    });

    it.each([
      { maximized: true, fullscreen: false },
      { maximized: false, fullscreen: true },
      { maximized: true, fullscreen: true },
    ])('blocks dragging while maximized=$maximized/fullscreen=$fullscreen and restores it without rerendering', async ({ maximized, fullscreen }) => {
      const toolbar = renderBar(2);
      await mouseDown(toolbar);
      expect(startDragging).toHaveBeenCalledOnce();

      isMaximized.mockResolvedValue(maximized);
      isFullscreen.mockResolvedValue(fullscreen);
      for (const target of [toolbar, toolbar.querySelector('[role="tablist"]')!]) {
        await mouseDown(target);
      }
      expect(startDragging).toHaveBeenCalledOnce();
      doubleClick(toolbar);
      expect(maximize).toHaveBeenCalledOnce();

      isMaximized.mockResolvedValue(false);
      isFullscreen.mockResolvedValue(false);
      await mouseDown(toolbar);
      expect(startDragging).toHaveBeenCalledTimes(2);
    });

    it('ignores middle/right buttons and gestures already handled by descendants', async () => {
      const toolbar = renderBar(2);
      await mouseDown(toolbar, { button: 1 });
      await mouseDown(toolbar, { button: 2 });
      const tabList = toolbar.querySelector('[role="tablist"]')!;
      tabList.addEventListener('mousedown', event => event.preventDefault());
      tabList.addEventListener('dblclick', event => event.preventDefault());
      await mouseDown(tabList);
      doubleClick(tabList);
      expect(startDragging).not.toHaveBeenCalled();
      expect(maximize).not.toHaveBeenCalled();
    });

    it('does not expose native window gestures in a browser runtime', async () => {
      vi.stubGlobal('__TAURI_INTERNALS__', undefined);
      const toolbar = renderBar(2);
      await mouseDown(toolbar);
      doubleClick(toolbar);
      expect(startDragging).not.toHaveBeenCalled();
      expect(maximize).not.toHaveBeenCalled();
    });
  });
});
