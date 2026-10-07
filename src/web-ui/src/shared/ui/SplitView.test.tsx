// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView, type SplitViewProps } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('shared SplitView interaction contract', () => {
  let container: HTMLDivElement;
  let root: Root;
  let width: number;
  let resized: () => void;
  let changed: ReturnType<typeof vi.fn>;
  let resizing: ReturnType<typeof vi.fn>;
  const part = (name: string) => container.querySelector<HTMLElement>(`[data-openbitfun-component="split-view"][data-openbitfun-part="${name}"]`)!;
  const render = (props: Partial<SplitViewProps> = {}) => act(() => root.render(<SplitView
    primary={<textarea aria-label="Draft" defaultValue="unsent" />}
    secondary={<iframe title="Content" />}
    rightSize={400} minLeftSize={300} minRightSize={200}
    onRightSizeChange={changed} onResizeStateChange={resizing}
    dividerLabel="Resize panes" dividerActions={<button>Swap</button>} {...props}
  />));
  const key = (target: HTMLElement, value: string, shiftKey = false) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })));
  const pointer = (type: string, x: number, pointerId = 1) => act(() => {
    const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    part('resizeHandle').dispatchEvent(event);
  });

  beforeEach(() => {
    width = 1001;
    changed = vi.fn(); resizing = vi.fn();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
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

  it('clamps display to a smaller container without overwriting the preferred width', () => {
    render({ rightSize: 600 });
    width = 701; act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('400px');
    width = 1001; act(() => resized());
    expect(part('root').style.getPropertyValue('--_split-view-right-size')).toBe('600px');
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

  it.each(['pointercancel', 'lostpointercapture', 'Escape', 'mode'])('cancels without persisting on %s', reason => {
    render(); pointer('pointerdown', 600); pointer('pointermove', 550);
    act(() => vi.advanceTimersByTime(16));
    if (reason === 'Escape') key(part('resizeHandle'), 'Escape');
    else if (reason === 'mode') render({ mode: 'secondary' });
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
