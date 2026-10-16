// @vitest-environment jsdom
import React, { act, StrictMode, useCallback, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatVirtualizer, type FlowChatVirtualizer } from './useFlowChatVirtualizer';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { useFlowChatViewportOwner } from './useFlowChatViewportOwner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Real hooks and TanStack, supplied DOM geometry. This is an update/lifecycle
// regression, not evidence of native WebView paint or the user's exact dataset.
describe('virtual measurement cascades', () => {
  let host: HTMLDivElement;
  let root: Root;
  let api: FlowChatVirtualizer;
  let follow: ReturnType<typeof useFlowChatFollowOutput>;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  let commits: number;
  let height: number;
  let opening: boolean;
  let childReadback: boolean;
  let time: number;
  const items = Array.from({ length: 1000 }, (_, index) => index);

  function Row({ index, measure }: { index: number; measure: (element: HTMLElement | null) => void }) {
    useLayoutEffect(() => {
      if (!childReadback) return;
      const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
      scroller.scrollTop = 0;
      api.syncViewportOffset(0);
    }, []);
    return <div data-virtual-index={index} ref={measure} />;
  }

  function Harness() {
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const headerRef = useRef<HTMLDivElement | null>(null);
    const owner = useFlowChatViewportOwner(scrollerRef);
    const reconcile = useRef<() => boolean>(() => false);
    const attachScroller = useCallback((element: HTMLDivElement | null) => {
      scrollerRef.current = element;
      if (!element) return;
      let top = 0;
      Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => Math.min(top, Math.max(0, element.scrollHeight - 500)),
        set: value => { top = Math.max(0, Math.min(value, element.scrollHeight - 500)); },
      });
    }, []);
    api = useFlowChatVirtualizer({
      items, scrollerRef, headerRef, getItemKey: String,
      estimateItemHeightPx: () => 100, startAtTailOnMount: true,
      shiftViewport: owner.shift, writeViewport: owner.write,
      reconcileOpeningMeasurement: () => reconcile.current(), scrollPaddingStartPx: 0,
    });
    follow = useFlowChatFollowOutput({
      activeSessionId: 'cascade-session', virtualItemCount: items.length,
      isViewportActive: true, isStreaming: false, startAtTailOnMount: !childReadback,
      scrollerRef, viewportOwner: owner, viewportId: 987,
      readLayoutTarget: () => Math.max(0, (scrollerRef.current?.scrollHeight ?? 0) - 500),
      hasRenderedOutput: () => true, isOpeningViewport: () => opening,
      cancelNavigation: api.cancelAim, cancelPendingPlacement: () => {},
      placeSubmittedMessage: () => null,
      onViewportOffset: offset => api.syncViewportOffset(offset),
    });
    reconcile.current = () => {
      if (!opening || !follow.isFollowingOutputNow() || owner.currentOwner() !== 'follow-output') return false;
      follow.scheduleFollowToLatest();
      return true;
    };
    useLayoutEffect(() => { commits += 1; });
    return <div ref={attachScroller} data-scroller>
      <div ref={headerRef} />
      <div data-items style={{ paddingTop: api.paddingTopPx, paddingBottom: api.paddingBottomPx }}>
        {api.rows.map(row => <Row key={row.key} index={row.index} measure={api.measureRowElement} />)}
      </div>
    </div>;
  }

  beforeEach(() => {
    frames = new Map();
    frameId = 0;
    commits = 0;
    time = 0;
    height = 1;
    opening = true;
    childReadback = false;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.hasAttribute('data-scroller') ? 500 : this.hasAttribute('data-virtual-index') ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      const content = this.querySelector<HTMLElement>('[data-items]');
      return content ? Number.parseFloat(content.style.paddingTop || '0')
        + Number.parseFloat(content.style.paddingBottom || '0') + content.children.length * height : 0;
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const tick = () => act(() => {
    time += 16;
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback(time);
    }
  });
  function settle() {
    let quiet = 0;
    for (let frame = 0; frame < 120 && quiet < 3; frame++) {
      const before = commits;
      tick();
      quiet = commits === before ? quiet + 1 : 0;
    }
    expect(quiet).toBe(3);
  }

  it.each([0, 1])('converges after yielding when actual rows are %spx', rowHeight => {
    height = rowHeight;
    act(() => root.render(<Harness />));
    const initialCommits = commits;
    settle();
    expect(commits).toBeGreaterThan(initialCommits);
    expect(api.rows.at(-1)?.index).toBe(999);
    for (const row of api.rows) expect(row.endPx - row.startPx).toBe(rowHeight);
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    expect(scroller.scrollTop).toBe(Math.max(0, scroller.scrollHeight - 500));
  });

  it('also bounds physical-clamp readbacks outside opening', () => {
    opening = false;
    act(() => root.render(<Harness />));
    settle();
    expect(api.rows.length).toBeGreaterThan(0);
  });

  it('keeps ordinary opening synchronous without an extra render for the budget reset', () => {
    height = 80;
    act(() => root.render(<Harness />));
    expect(api.rows.at(-1)?.index).toBe(999);
    const before = commits;
    settle();
    expect(commits).toBe(before);
  });

  it('does not lose a descendant layout readback behind the preceding render request', () => {
    height = 100;
    childReadback = true;
    act(() => root.render(<Harness />));
    expect(api.rows[0]?.index).toBe(0);
  });

  it('uses current reader ownership instead of replaying the deferred tail placement', () => {
    act(() => root.render(<Harness />));
    const scroller = host.querySelector<HTMLElement>('[data-scroller]')!;
    act(() => {
      follow.exitFollowOutput('user-scroll');
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    settle();
    expect(follow.isFollowingOutputNow()).toBe(false);
    expect(scroller.scrollTop).toBe(0);
    expect(api.rows[0]?.index).toBe(0);
  });

  it('cancels deferred work on session remount and unmount, including StrictMode', () => {
    act(() => root.render(<StrictMode><Harness key="old" /></StrictMode>));
    expect(frames.size).toBeGreaterThan(0);
    const oldFrames = [...frames.keys()];
    height = 80;
    act(() => root.render(<StrictMode><Harness key="new" /></StrictMode>));
    for (const id of oldFrames) expect(frames.has(id)).toBe(false);
    settle();
    expect(api.rows.at(-1)?.index).toBe(999);
    act(() => root.render(null));
    expect(frames.size).toBe(0);
  });
});
