// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer, type FlowChatVirtualizer } from './useFlowChatVirtualizer';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { useFlowChatViewportOwner } from './useFlowChatViewportOwner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('measured history with real virtualization and follow (supplied DOM geometry)', () => {
  let host: HTMLDivElement, root: Root, api: FlowChatVirtualizer;
  let follow: ReturnType<typeof useFlowChatFollowOutput>;
  let frames: Map<number, FrameRequestCallback>, frameId: number, now: number;
  let opening: boolean;
  const heights = new Map<number, number>();
  const items = Array.from({ length: 34 }, (_, index) => index);
  function Harness() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const followRef = useRef<typeof follow>();
    const owner = useFlowChatViewportOwner(scrollerRef);
    api = useFlowChatVirtualizer({
      items, scrollerRef, headerRef, getItemKey: String,
      estimateItemHeightPx: () => 80, startAtTailOnMount: true,
      scrollPaddingStartPx: 0, writeViewport: owner.write,
      shiftViewport: delta => owner.shift(delta) || followRef.current?.shiftLayout(delta) === true,
      reconcileOpeningMeasurement: () => {
        if (!opening || !followRef.current?.isFollowingOutputNow()) return false;
        followRef.current.scheduleFollowToLatest();
        return true;
      },
    });
    follow = useFlowChatFollowOutput({
      activeSessionId: 'peer-session', virtualItemCount: items.length,
      isViewportActive: true, isStreaming: false, startAtTailOnMount: true,
      scrollerRef, viewportOwner: owner,
      isOpeningViewport: () => opening,
      readLayoutTarget: () => Math.max(0, (scrollerRef.current?.scrollHeight ?? 0) - 500),
      onViewportOffset: offset => api.syncViewportOffset(offset),
      placeSubmittedMessage: () => null, hasRenderedOutput: () => false,
      cancelPendingPlacement: () => {}, cancelNavigation: api.cancelAim,
    });
    followRef.current = follow;
    return <div ref={scrollerRef} data-scroller>
      <div ref={headerRef} />
      <div data-items style={{ paddingTop: api.paddingTopPx, paddingBottom: api.paddingBottomPx }}>
        {api.rows.map(row => <div key={row.key} data-virtual-index={row.index} ref={api.measureRowElement} />)}
      </div>
    </div>;
  }
  const tick = () => {
    now += 16;
    const callbacks = [...frames.values()]; frames.clear();
    act(() => callbacks.forEach(callback => callback(now)));
  };
  beforeEach(() => {
    heights.clear(); frames = new Map(); frameId = 0; now = 0; opening = true;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback); return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const height = this.offsetHeight;
      return { top: 0, bottom: height, height, width: this.offsetWidth } as DOMRect;
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      if (this.hasAttribute('data-scroller')) return 500;
      return this.hasAttribute('data-virtual-index') ? heights.get(Number(this.dataset.virtualIndex)) ?? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      const content = this.querySelector<HTMLElement>('[data-items]');
      return content ? Number.parseFloat(content.style.paddingTop || '0')
        + Number.parseFloat(content.style.paddingBottom || '0')
        + [...content.children].reduce((total, row) => total + (row as HTMLElement).offsetHeight, 0) : 0;
    });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    act(() => root.render(<Harness />));
    for (let i = 0; i < 8; i++) tick();
    opening = false;
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it.each([-50, 120])('keeps the visible tail still when an older row measures %+dpx after reveal', delta => {
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    const tail = host.querySelector('[data-virtual-index="33"]');
    const previousOffset = scroller.scrollTop;
    const previousTailTop = api.getItemBounds(33)!.startPx - previousOffset;
    const row = api.rows.find(candidate => candidate.endPx < previousOffset)!;
    expect(row).toBeDefined();
    heights.set(row.index, 80 + delta);
    act(() => api.measureRenderedItems());
    // Before any RAF/native scroll/resize notification, history displacement
    // must already be repaired. Easing it paints a jump and then a slide back.
    expect(api.getItemBounds(33)!.startPx - scroller.scrollTop).toBe(previousTailTop);
    expect(scroller.scrollTop).toBe(previousOffset + delta);
    expect(host.querySelector('[data-virtual-index="33"]')).toBe(tail);
    act(() => follow.scheduleFollowToLatest());
    for (let i = 0; i < 8; i++) tick();
    expect(scroller.scrollTop).toBe(previousOffset + delta);
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(200);
    });
    expect(host.querySelector('[data-virtual-index="33"]')).toBe(tail);
  });

  it('still eases actual output growth in the visible last row', () => {
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    const before = scroller.scrollTop;
    heights.set(33, 180);
    act(() => { api.measureRenderedItems(); follow.scheduleFollowToLatest(); });
    expect(scroller.scrollTop).toBe(before);
    tick();
    expect(scroller.scrollTop).toBeGreaterThan(before);
    expect(scroller.scrollTop).toBeLessThan(before + 100);
  });
});
