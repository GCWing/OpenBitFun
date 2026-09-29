// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
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
