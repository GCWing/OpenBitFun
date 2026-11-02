// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView, SplitViewPrimaryDock, SplitViewSurface, type SplitViewProps } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('shared SplitView interaction contract', () => {
  let container: HTMLDivElement;
  let root: Root;
  let width: number;
  let resized: () => void;
  let changed: ReturnType<typeof vi.fn>;
  let resizing: ReturnType<typeof vi.fn>;
  /** Every element whose box was measured, in order, so the tests can attribute reads. */
  let measured: HTMLElement[];
  const part = (name: string) => container.querySelector<HTMLElement>(`[data-openbitfun-component="split-view"][data-openbitfun-part="${name}"]`)!;
  const render = (props: Partial<SplitViewProps> = {}) => act(() => root.render(<SplitView
    primary={<SplitViewPrimaryDock><textarea aria-label="Draft" defaultValue="unsent" /></SplitViewPrimaryDock>}
    secondary={<iframe title="Content" />}
    rightSize={400} minLeftSize={300} minRightSize={200}
    onRightSizeChange={changed} onResizeStateChange={resizing}
    dividerLabel="Resize panes" dividerActions={<button>Swap</button>} {...props}
  />));
  const key = (target: HTMLElement, value: string, shiftKey = false) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })));
  const pointer = (type: string, x: number, pointerId = 1) => act(() => {
    const event = new MouseEvent(type, { button: 0, bubbles: true, cancelable: true });
    // jsdom coerces `clientX` to an integer, which would hide sub-pixel drags.
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    part('resizeHandle').dispatchEvent(event);
  });

  beforeEach(() => {
    width = 1001;
    changed = vi.fn(); resizing = vi.fn(); measured = [];
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      measured.push(this);
      return { width: this.getAttribute('data-openbitfun-part') === 'divider' ? 1 : width } as DOMRect;
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  });

  it('keeps the physical divider position and mounted editor/frame across swap, hide and fullscreen', () => {
    render();
    const primary = part('primary'), secondary = part('secondary');
    const draft = container.querySelector('textarea')!;
    const frame = container.querySelector('iframe')!;
    draft.value = 'still editing';
    for (const mode of ['split', 'secondary', 'primary', 'split'] as const) {
      render({ secondarySide: 'left', mode });
      expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('400px');
      expect(part('primary')).toBe(primary); expect(part('secondary')).toBe(secondary);
      expect(container.querySelector('iframe')).toBe(frame);
      expect(container.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('still editing');
      expect(primary.hidden).toBe(mode === 'secondary'); expect(secondary.hidden).toBe(mode === 'primary');
    }
    expect(changed).not.toHaveBeenCalled();
  });

  it('shares live resize and clamped geometry with the header', () => {
    const header: SplitViewProps['header'] = geometry => <div data-testid="aligned-header" className={geometry.columnClassName}>Tabs</div>;
    render({ header });
    const headerNode = container.querySelector<HTMLElement>('[data-testid="aligned-header"]')!;
    expect(headerNode.className).toMatch(/headerColumns/);
    pointer('pointerdown', 600);
    pointer('pointermove', 550);
    act(() => vi.advanceTimersByTime(16));
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('450px');
    expect(container.querySelector('[data-testid="aligned-header"]')).toBe(headerNode);
    pointer('pointercancel', 550);
    width = 400;
    act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('199.5px');
    render({ header, layout: 'overlay', secondarySide: 'left' });
    expect(part('root').getAttribute('data-secondary-side')).toBe('left');
    expect(headerNode.className).toMatch(/headerColumns/);
  });

  it('moves a stable surface between panes, preserves its DOM and routes F6 to visible surfaces', () => {
    const surfaces = (pane: 'primary' | 'secondary') => <>
      <SplitViewSurface key="document" pane={pane}><textarea aria-label="Moving draft" defaultValue="draft" /></SplitViewSurface>
      <SplitViewSurface key="other" pane={pane === 'primary' ? 'secondary' : 'primary'}><button>Other</button></SplitViewSurface>
    </>;
    render({ primary: null, secondary: null, header: <header>Tabs</header>, surfaces: surfaces('primary') });
    const draft = container.querySelector('textarea')!;
    draft.value = 'unsaved';
    render({ primary: null, secondary: null, header: <header>Tabs</header>, surfaces: surfaces('secondary') });
    expect(container.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('unsaved');
    expect(draft.closest('[data-split-surface]')?.getAttribute('data-split-surface')).toBe('secondary');
    draft.focus();
    key(draft, 'F6');
    expect(document.activeElement?.getAttribute('data-split-surface')).toBe('primary');
    render({ mode: 'primary', primary: null, secondary: null, surfaces: surfaces('secondary') });
    expect(draft.closest<HTMLElement>('[data-split-surface]')!.hidden).toBe(true);
    expect(draft.closest('[data-split-surface]')?.hasAttribute('inert')).toBe(true);
  });

  it('uses the same physical resize directions on either side and associates the actual right pane', () => {
    for (const secondarySide of ['left', 'right'] as const) {
      render({ secondarySide });
      expect(part('resizeHandle').getAttribute('aria-controls')).toBe(part(secondarySide === 'left' ? 'primary' : 'secondary').id);
      key(part('resizeHandle'), 'ArrowLeft'); expect(changed).toHaveBeenLastCalledWith(410);
      key(part('resizeHandle'), 'ArrowRight', true); expect(changed).toHaveBeenLastCalledWith(350);
      key(part('resizeHandle'), 'Home'); expect(changed).toHaveBeenLastCalledWith(200);
      key(part('resizeHandle'), 'End'); expect(changed).toHaveBeenLastCalledWith(700);
    }
  });

  it('retains edited content across live layout switches and overlay visibility changes', () => {
    render();
    const draft = container.querySelector('textarea')!;
    const frame = container.querySelector('iframe')!;
    draft.value = 'still editing';
    for (const layout of ['overlay', 'split', 'overlay'] as const) {
      for (const mode of ['split', 'primary', 'secondary', 'split'] as const) {
        render({ layout, mode });
        expect(part('root').getAttribute('data-layout')).toBe(layout);
        expect(container.querySelector('textarea')).toBe(draft);
        expect(draft.value).toBe('still editing');
        expect(container.querySelector('iframe')).toBe(frame);
        expect(part('primary').hidden).toBe(mode === 'secondary');
        expect(part('secondary').hidden).toBe(mode === 'primary');
      }
    }
  });

  it.each(['left', 'right'] as const)('resizes the %s overlay from its inner edge', secondarySide => {
    render({ layout: 'overlay', secondarySide, minLeftSize: 0 });
    expect(part('resizeHandle').getAttribute('aria-controls')).toBe(part('secondary').id);
    key(part('resizeHandle'), 'ArrowRight');
    expect(changed).toHaveBeenLastCalledWith(secondarySide === 'left' ? 410 : 390);
    pointer('pointerdown', 600);
    pointer('pointerup', 650);
    expect(changed).toHaveBeenLastCalledWith(secondarySide === 'left' ? 450 : 350);
  });

  it('clamps display to a smaller container without overwriting the preferred width', () => {
    render({ rightSize: 600 });
    width = 701; act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    width = 1001; act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('600px');
    expect(changed).not.toHaveBeenCalled();
  });

  it('reserves uncovered overlay space for a stable primary dock through clamping and dragging', () => {
    render({ layout: 'overlay', rightSize: 900, minLeftSize: 400 });
    const dock = part('primaryDock');
    const draft = container.querySelector('textarea')!;
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('600px');
    width = 601; act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('300px');
    width = 1201; act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('800px');
    pointer('pointerdown', 400); pointer('pointermove', 500);
    act(() => vi.advanceTimersByTime(16));
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('700px');
    expect(part('primaryDock')).toBe(dock);
    expect(container.querySelector('textarea')).toBe(draft);
    pointer('pointercancel', 500);
    render({ layout: 'overlay', secondarySide: 'left', mode: 'primary' });
    expect(part('primaryDock')).toBe(dock);
    expect(changed).not.toHaveBeenCalled();
  });

  it('commits once at pointer release, even before the last animation frame', () => {
    render();
    document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text';
    pointer('pointerdown', 600); pointer('pointermove', 550);
    expect(changed).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(16));
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('450px');
    pointer('pointerup', 520);
    expect(changed).toHaveBeenCalledExactlyOnceWith(480);
    expect(resizing.mock.calls).toEqual([[true], [false]]);
    expect(document.body.style.cursor).toBe('crosshair'); expect(document.body.style.userSelect).toBe('text');
  });

  it('clamps a drag to the latest container width and commits the constrained size', () => {
    render();
    const splitRoot = part('root');
    pointer('pointerdown', 600);
    width = 601; act(() => resized());
    expect(splitRoot.style.getPropertyValue('--_split-view-right-size')).toBe('300px');
    pointer('pointermove', 500);
    act(() => vi.advanceTimersByTime(16));
    expect(splitRoot.style.getPropertyValue('--_split-view-right-size')).toBe('300px');
    pointer('pointerup', 500);
    expect(changed).toHaveBeenCalledExactlyOnceWith(300);
  });

  it('uses newly available space when the container grows during a drag', () => {
    width = 701;
    render({ rightSize: 600 });
    pointer('pointerdown', 600); pointer('pointermove', 100);
    act(() => vi.advanceTimersByTime(16));
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    width = 1201; act(() => resized());
    pointer('pointermove', 100);
    act(() => vi.advanceTimersByTime(16));
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('900px');
    pointer('pointerup', 100);
    expect(changed).toHaveBeenCalledExactlyOnceWith(900);
  });

  it('clamps a queued drag frame when the container shrinks before it paints', () => {
    render();
    pointer('pointerdown', 600); pointer('pointermove', 400);
    width = 701; act(() => resized());
    const readsAfterResize = measured.length;
    act(() => vi.advanceTimersByTime(16));
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    expect(measured.length).toBe(readsAfterResize);
    pointer('pointerup', 400);
    expect(changed).toHaveBeenCalledExactlyOnceWith(400);
  });

  it('uses observer-cached bounds without layout reads during a drag', () => {
    render();
    const root = part('root');
    const rootReads = () => measured.filter(element => element === root).length;
    measured.length = 0;
    pointer('pointerdown', 600);
    // The observer already supplied the bounds; pointerdown needs no new read.
    expect(rootReads()).toBe(0);
    const readsAtPointerDown = measured.length;
    pointer('pointermove', 560);
    act(() => vi.advanceTimersByTime(16));
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('440px');
    pointer('pointermove', 500);
    act(() => vi.advanceTimersByTime(16));
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('500px');
    expect(rootReads()).toBe(0);
    expect(measured.length).toBe(readsAtPointerDown);
    // Clamping still uses the cached width and commits once at release.
    pointer('pointerup', 480);
    expect(changed).toHaveBeenCalledExactlyOnceWith(520);
  });

  it('skips the live write for a sub-pixel move and writes again on a rounded change', () => {
    render();
    const root = part('root');
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    const sizeWrites = () => setProperty.mock.calls.filter(([name]) => name === '--_split-view-right-size').length;
    pointer('pointerdown', 600);
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    const writesAtPointerDown = sizeWrites();
    pointer('pointermove', 600.3);
    act(() => vi.advanceTimersByTime(16));
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    expect(sizeWrites()).toBe(writesAtPointerDown);
    expect(changed).not.toHaveBeenCalled();
    pointer('pointermove', 599);
    act(() => vi.advanceTimersByTime(16));
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('401px');
    expect(sizeWrites()).toBe(writesAtPointerDown + 1);
  });

  it('re-seeds the sub-pixel guard when a re-render rewrites the displayed size mid-drag', () => {
    render({ rightSize: 600 });
    const root = part('root');
    width = 701; act(() => resized());
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    pointer('pointerdown', 600); pointer('pointermove', 610);
    act(() => vi.advanceTimersByTime(16));
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('390px');
    // The container grows mid-drag: the root's ResizeObserver re-renders and React
    // overwrites the inline width with the new resolved size, while `drag.painted`
    // still holds what the drag wrote (390).
    width = 1001; act(() => resized());
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('600px');
    // 390.25 rounds to the stale painted value, but the DOM holds 600px, so the move
    // must still write instead of being skipped as "already painted".
    pointer('pointermove', 609.75);
    act(() => vi.advanceTimersByTime(16));
    expect(root.style.getPropertyValue('--_split-view-right-size')).toBe('390.25px');
    pointer('pointerup', 609.75);
    expect(changed).toHaveBeenCalledExactlyOnceWith(390.25);
  });

  it.each(['pointercancel', 'lostpointercapture', 'Escape', 'mode', 'layout'])('cancels without persisting on %s', reason => {
    render(); pointer('pointerdown', 600); pointer('pointermove', 550);
    act(() => vi.advanceTimersByTime(16));
    if (reason === 'Escape') key(part('resizeHandle'), 'Escape');
    else if (reason === 'mode') render({ mode: 'secondary' });
    else if (reason === 'layout') render({ layout: 'overlay' });
    else pointer(reason, 550);
    expect(changed).not.toHaveBeenCalled();
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    expect(resizing).toHaveBeenLastCalledWith(false);
    expect(document.body.style.cursor).toBe('');
  });

  it('moves focus away from hidden panes and navigates the visual pane order with F6', () => {
    render({ secondarySide: 'left' });
    act(() => container.querySelector('textarea')!.focus());
    key(container.querySelector('textarea')!, 'F6'); expect(document.activeElement).toBe(part('secondary'));
    key(part('secondary'), 'F6', true); expect(document.activeElement).toBe(part('primary'));
    render({ mode: 'secondary' }); expect(document.activeElement).toBe(part('secondary'));
    render({ mode: 'primary' }); expect(document.activeElement).toBe(part('primary'));
  });

  it('keeps divider actions outside the separator drag target', () => {
    const swap = vi.fn(); render({ dividerActions: <button onClick={swap}>Swap</button> });
    const button = container.querySelector('button')!;
    act(() => button.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true })));
    act(() => button.click());
    expect(swap).toHaveBeenCalledOnce(); expect(resizing).not.toHaveBeenCalled();
    expect(button.closest('[role="separator"]')).toBeNull();
  });
});
