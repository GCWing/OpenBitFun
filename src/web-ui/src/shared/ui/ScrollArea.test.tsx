// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollArea, type ScrollAreaProps } from '@openbitfun/ui';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('shared ScrollArea edge fades', () => {
  let root: Root;
  let host: HTMLDivElement;
  let viewport: HTMLDivElement | null;
  let metrics: Record<string, number>;
  let resizeCallbacks: Array<() => void>;
  let disconnected: number;

  const setViewport = (element: HTMLDivElement | null) => {
    viewport = element;
    if (!element) return;
    for (const name of Object.keys(metrics)) {
      Object.defineProperty(element, name, { configurable: true, get: () => metrics[name] });
    }
  };

  const render = (props: Partial<ScrollAreaProps> = {}) => act(() => root.render(
    <ScrollArea ref={setViewport} orientation="both" edgeFade="vertical" {...props}>
      <div data-testid="spacer">Content</div>
    </ScrollArea>,
  ));
  const resize = () => act(() => resizeCallbacks.forEach(callback => callback()));
  const scroll = (top: number) => act(() => {
    metrics.scrollTop = top;
    viewport!.dispatchEvent(new Event('scroll'));
  });
  const edges = () => [viewport?.dataset.openbitfunFadeTop, viewport?.dataset.openbitfunFadeBottom];

  beforeEach(() => {
    metrics = { clientHeight: 100, clientWidth: 200, offsetHeight: 100, offsetWidth: 200, scrollHeight: 300, scrollTop: 0 };
    resizeCallbacks = [];
    disconnected = 0;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      observe() {}
      unobserve() {}
      disconnect() { disconnected += 1; }
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    viewport = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows only edges that hide more content and handles overscroll', () => {
    render();
    expect(edges()).toEqual(['false', 'true']);
    scroll(60);
    expect(edges()).toEqual(['true', 'true']);
    scroll(200);
    expect(edges()).toEqual(['true', 'false']);
    scroll(-8);
    expect(edges()).toEqual(['false', 'true']);
    scroll(210);
    expect(edges()).toEqual(['true', 'false']);
  });

  it('refreshes hidden, resized, and virtualized content without another scroll', async () => {
    metrics.clientHeight = 0;
    render();
    expect(edges()).toEqual(['false', 'false']);
    metrics.clientHeight = 100;
    resize();
    expect(edges()).toEqual(['false', 'true']);
    metrics.scrollHeight = 80;
    resize();
    expect(edges()).toEqual(['false', 'false']);
    metrics.scrollHeight = 350;
    await act(async () => {
      viewport!.firstElementChild!.textContent = 'Streaming content';
      await Promise.resolve();
    });
    expect(edges()).toEqual(['false', 'true']);
  });

  it('keeps the native viewport ref, scroll handler, and both scrollbar gutters', () => {
    metrics.offsetWidth = 210;
    metrics.offsetHeight = 114;
    const onScroll = vi.fn();
    render({ onScroll, 'data-openbitfun-component': 'inline-diff-preview', 'data-openbitfun-part': 'content' });
    expect(host.firstElementChild).toBe(viewport);
    expect(viewport?.children).toHaveLength(1);
    expect(viewport?.dataset.openbitfunComponent).toBe('inline-diff-preview');
    expect(viewport?.style.getPropertyValue('--_scroll-area-inline-gutter')).toBe('10px');
    expect(viewport?.style.getPropertyValue('--_scroll-area-block-gutter')).toBe('14px');
    scroll(50);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary viewports alone and cleans up when the effect is disabled', () => {
    render({ edgeFade: 'none' });
    expect(resizeCallbacks).toHaveLength(0);
    expect(edges()).toEqual([undefined, undefined]);
    render();
    expect(edges()).toEqual(['false', 'true']);
    render({ edgeFade: 'none' });
    expect(disconnected).toBe(1);
    expect(edges()).toEqual([undefined, undefined]);
    expect(viewport?.style.getPropertyValue('--_scroll-area-inline-gutter')).toBe('');
    scroll(50);
    expect(edges()).toEqual([undefined, undefined]);
    render({ orientation: 'horizontal' });
    expect(resizeCallbacks).toHaveLength(1);
  });
});
