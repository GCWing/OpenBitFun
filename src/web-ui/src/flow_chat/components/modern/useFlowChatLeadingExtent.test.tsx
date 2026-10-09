// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import { useFlowChatLeadingExtent } from './useFlowChatLeadingExtent';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import { readingLinePxForViewport } from './flowChatTailFollow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Supplied measurements test extent/identity contracts, not rendered visuals.
const item = (id: string, kind = 'content') => ({ type: 'model-round', turnId: 'turn', data: { id },
  timeline: { key: id, kind, ...(kind.startsWith('group-') ? { group: { groupId: 'group' } } : {}) },
}) as unknown as VirtualItem;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

function setup() {
  const host = document.createElement('div');
  const scroller = document.createElement('div');
  const extent = document.createElement('div');
  document.body.append(host, scroller); scroller.append(extent);
  const root = createRoot(host);
  let contentEnd = 3300;
  const height = 800, line = readingLinePxForViewport(height, 160);
  Object.defineProperties(scroller, {
    clientHeight: { get: () => height },
    scrollHeight: { get: () => Math.max(contentEnd + height - line, Number.parseFloat(extent.style.minHeight || '0')) },
  });
  let items = [item('header', 'group-header'), item('member', 'group-members'), item('after')];
  let bounds = [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: 3240 }, { startPx: 3240, endPx: 3300 }];
  let api: ReturnType<typeof useFlowChatLeadingExtent>;
  let rebases = 0;
  function Test({ scope }: { scope: string }) {
    api = useFlowChatLeadingExtent({ scope, items, virtualizer: { getItemBounds: index => bounds[index] ?? null },
      scrollerRef: { current: scroller }, extentRef: { current: extent }, onAnchorRebased: () => { rebases++; } });
    return null;
  }
  const render = (scope = 'session:turn') => act(() => root.render(<Test scope={scope} />));
  render();
  cleanups.push(() => { act(() => root.unmount()); host.remove(); scroller.remove(); });
  return {
    get api() { return api!; }, extent, scroller, line, get rebases() { return rebases; }, render,
    layout(nextItems: VirtualItem[], nextBounds: typeof bounds, end: number) {
      items = nextItems; bounds = nextBounds; contentEnd = end; render();
    },
  };
}

describe('desktop leading extent lifecycle', () => {
  it.each([-2, -0.25, 0.25, 2])('does not turn a stable %s px cache/DOM difference into repeated travel', difference => {
    const view = setup();
    view.layout([item('header', 'group-header'), item('after')],
      [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: 2100 }], 2100);
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper'; row.dataset.virtualItemKey = 'block:header';
    row.getBoundingClientRect = () => ({
      top: 2000 + difference - view.scroller.scrollTop,
      bottom: 2040 + difference - view.scroller.scrollTop,
      height: 40,
    }) as DOMRect;
    view.extent.append(row);
    view.scroller.scrollTop = 1980;
    view.api.refresh(1000);
    view.api.capture(1980);
    // No output, resize, input, or row movement: just accepted follow
    // readbacks followed by layout notifications after runtime completion.
    for (let frame = 0; frame < 80; frame++) {
      view.api.refresh(1000);
      view.scroller.scrollTop = view.scroller.scrollHeight - view.scroller.clientHeight;
      view.api.capture(view.scroller.scrollTop);
    }
    expect(view.scroller.scrollTop).toBe(1980);
    expect(view.extent.style.minHeight).toBe('2780px');
  });
  it('bridges mount, cache catch-up, and recycling without moving a stationary anchor', () => {
    const view = setup();
    const entries = [item('header', 'group-header'), item('after')];
    const bounds = [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: 2100 }];
    view.layout(entries, bounds, 2100);
    view.scroller.scrollTop = 1980;
    view.api.refresh(1000); view.api.capture(1980);
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper'; row.dataset.virtualItemKey = 'block:header';
    let start = 1998.75;
    row.getBoundingClientRect = () => ({ top: start - view.scroller.scrollTop,
      bottom: start + 40 - view.scroller.scrollTop, height: 40 }) as DOMRect;
    view.extent.append(row);
    view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2780px');
    expect(view.api.snapshot()).toEqual({ key: 'block:header', offset: 18.75 });
    // Delayed virtual measurements change; mounted content did not move.
    view.layout(entries, bounds.map(b => ({ startPx: b.startPx + 3, endPx: b.endPx + 3 })), 2100);
    view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2780px');
    row.remove(); view.api.refresh(1000); view.api.capture(1980);
    expect(view.extent.style.minHeight).toBe('2780px');
    view.extent.append(row); view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2780px');
    // A genuine displacement above the leading row still moves its floor.
    start += 120;
    view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2900px');
    for (let i = 0; i < 20; i++) view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2900px');
  });
  it('reads DOM geometry only on layout or exact reader capture, never on follow frames', () => {
    const view = setup();
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper'; row.dataset.virtualItemKey = 'block:member';
    const read = vi.fn(() => ({ top: 2039.75 - view.scroller.scrollTop,
      bottom: 3239.75 - view.scroller.scrollTop, height: 1200 }) as DOMRect);
    row.getBoundingClientRect = read; view.extent.append(row);
    view.api.refresh(1000); read.mockClear();
    for (let offset = 2100; offset <= 2400; offset += 10) view.api.capture(offset);
    expect(read).not.toHaveBeenCalled();
    expect(view.api.snapshot()).toEqual({ key: 'block:member', offset: -360.25 });
    view.api.capture(2500, true); expect(read).toHaveBeenCalledTimes(1);
    expect(view.api.snapshot()).toEqual({ key: 'block:member', offset: -460.25 });
  });
  it('reserves the reader position before shrink and lets regrowth consume it', () => {
    const view = setup();
    view.api.refresh(1000);
    view.scroller.scrollTop = 1980;
    view.api.capture(1980);
    expect(view.extent.style.minHeight).toBe('2780px');
    view.layout([item('header', 'group-header'), item('after')],
      [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: 2100 }], 2100);
    // Before any resize callback, the range already prevents native clamp.
    expect(view.scroller.scrollHeight - view.scroller.clientHeight).toBe(1980);
    expect(view.api.snapshot()).toEqual({ key: getVirtualItemStableKey(item('header', 'group-header')), offset: 20 });
    view.api.refresh(1000);
    expect(view.scroller.scrollHeight - 800).toBe(1980);
    for (const end of [2200, 2300, 2500, 3000]) {
      view.layout([item('header', 'group-header'), item('after')],
        [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: end }], end);
      view.api.refresh(1000);
      expect(view.scroller.scrollHeight - 800).toBeCloseTo(Math.max(1980, end - view.line));
    }
  });
  it('uses the surviving header instead of pinning the following block to its former low position', () => {
    const view = setup();
    view.api.refresh(1000); view.api.capture(2800);
    view.layout([item('header', 'group-header'), item('after')],
      [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: 2100 }], 2100);
    expect(view.api.snapshot()).toEqual({ key: 'block:header', offset: 8 });
    view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2792px');
    expect(view.rebases).toBe(1);
    view.api.refresh(1000);
    expect(view.rebases).toBe(1);
  });
  it('aligns a newly mounted fallback header to its actual top despite rounded virtual bounds', () => {
    const view = setup();
    view.scroller.scrollTop = 2800;
    view.api.refresh(1000); view.api.capture(2800);
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper'; row.dataset.virtualItemKey = 'block:header';
    row.getBoundingClientRect = () => ({ top: 1998.75 - view.scroller.scrollTop,
      bottom: 2038.75 - view.scroller.scrollTop, height: 40 }) as DOMRect;
    view.extent.append(row);
    view.layout([item('header', 'group-header'), item('after')],
      [{ startPx: 2000, endPx: 2040 }, { startPx: 2040, endPx: 2100 }], 2100);
    view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2790.75px');
    expect(view.api.snapshot()).toEqual({ key: 'block:header', offset: 8 });
    expect(view.rebases).toBe(1);
    view.api.refresh(1000);
    expect(view.extent.style.minHeight).toBe('2790.75px');
    expect(view.rebases).toBe(1);
  });
  it('releases the prior position on reader travel and on new turn/session/history scope', () => {
    const view = setup();
    view.api.refresh(1000); view.api.capture(2800); view.api.capture(2200);
    expect(view.extent.style.minHeight).toBe('3000px');
    view.render('session:new-turn'); view.api.refresh(1200);
    expect(view.api.snapshot()).toBeNull();
    expect(view.extent.style.minHeight).toBe('2000px');
    view.render('history'); view.api.refresh(null);
    expect(view.extent.style.minHeight).toBe('');
  });
});
