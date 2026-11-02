// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { useFlowChatLeadingExtent } from './useFlowChatLeadingExtent';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { useFlowChatViewportOwner } from './useFlowChatViewportOwner';
import { readingLinePxForViewport } from './flowChatTailFollow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

// Real extent, follow and ownership hooks with supplied browser geometry.
// This checks the feedback loop and idle behavior, not visual acceptance.
describe('follow and leading extent after completion', () => {
  it.each([-2, -0.25, 0.25, 2])('settles with a %s px virtual/DOM difference and still follows late rendered output', difference => {
    const host = document.createElement('div');
    const scroller = document.createElement('div');
    const extent = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper'; row.dataset.virtualItemKey = 'block:answer';
    document.body.append(host, scroller); scroller.append(extent); extent.append(row);
    const root = createRoot(host);
    cleanups.push(() => { act(() => root.unmount()); host.remove(); scroller.remove(); });
    const frames = new Map<number, FrameRequestCallback>();
    let now = 0, frameId = 0, actualOffset = 0, naturalTarget = 1800, streaming = true, writes = 0;
    const line = readingLinePxForViewport(800, 160);
    const maxOffset = () => Math.max(naturalTarget, Number.parseFloat(extent.style.minHeight || '800') - 800);
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 800 },
      scrollHeight: { get: () => maxOffset() + 800 },
      scrollTop: {
        get: () => Math.min(actualOffset, maxOffset()),
        set: (value: number) => { actualOffset = Math.max(0, Math.min(value, maxOffset())); },
      },
    });
    const domRead = vi.fn(() => ({ top: 1700 + difference - scroller.scrollTop,
      bottom: naturalTarget + line - scroller.scrollTop,
      height: naturalTarget + line - 1700 - difference }) as DOMRect);
    row.getBoundingClientRect = domRead;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    const items = [{ type: 'model-round', turnId: 'turn', data: { id: 'answer' },
      timeline: { key: 'answer', kind: 'content' } }] as unknown as VirtualItem[];
    let follow: ReturnType<typeof useFlowChatFollowOutput>;
    function Harness() {
      const ref = useRef<HTMLElement | null>(scroller);
      const extentRef = useRef<HTMLElement | null>(extent);
      const [, publishOffset] = useState(0);
      const leading = useFlowChatLeadingExtent({ scope: 'completion', items,
        virtualizer: { getItemBounds: () => ({ startPx: 1700, endPx: naturalTarget + line }) },
        scrollerRef: ref, extentRef, onAnchorRebased: () => {} });
      const owner = useFlowChatViewportOwner(ref);
      follow = useFlowChatFollowOutput({ virtualItemCount: 1, isStreaming: streaming, isViewportActive: true,
        scrollerRef: ref, viewportOwner: owner, isOpeningViewport: () => false,
        readLayoutTarget: () => { leading.refresh(1000); return scroller.scrollHeight - scroller.clientHeight; },
        placeSubmittedMessage: () => null, hasRenderedOutput: () => true,
        cancelPendingPlacement: () => {}, cancelNavigation: () => {},
        onViewportOffset: offset => {
          writes++;
          const before = domRead.mock.calls.length;
          leading.capture(offset);
          expect(domRead.mock.calls.length).toBe(before);
          // The real list publishes follow offsets to the virtualizer, which
          // may render again even after all content has stopped changing.
          publishOffset(value => value + 1);
        },
      });
      return null;
    }
    const render = () => act(() => root.render(<Harness />));
    const tick = () => {
      now += 16;
      const batch = [...frames.values()]; frames.clear();
      act(() => batch.forEach(callback => callback(now)));
    };
    const settle = () => { for (let i = 0; i < 180 && frames.size; i++) tick(); };
    render(); settle();
    expect(scroller.scrollTop).toBe(1800); expect(frames.size).toBe(0);
    naturalTarget = 2400; render(); tick();
    streaming = false; render(); settle();
    expect(scroller.scrollTop).toBe(2400); expect(frames.size).toBe(0);
    // Completion compacts a card, while its leading content still exists.
    naturalTarget = 2200; render(); settle();
    const completedWrites = writes;
    for (let i = 0; i < 120; i++) { render(); tick(); }
    expect(scroller.scrollTop).toBe(2400);
    expect(writes).toBe(completedWrites); expect(frames.size).toBe(0);
    expect(follow!.isFollowingOutputNow()).toBe(true);
    // Buffered/typewriter output can finish after runtime completion.
    naturalTarget = 2500; render(); settle();
    expect(scroller.scrollTop).toBe(2500); expect(frames.size).toBe(0);
    act(() => follow!.handleUserScrollIntent('before'));
    scroller.scrollTop = 2000;
    naturalTarget = 2800; render(); settle();
    expect(scroller.scrollTop).toBe(2000);
    expect(follow!.isFollowingOutputNow()).toBe(false);
  });
});
