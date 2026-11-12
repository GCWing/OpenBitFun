// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { VirtualMessageList } from './VirtualMessageList';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { Session } from '../../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ items: [] as VirtualItem[], session: null as Session | null, processing: false }));
vi.mock('../../store/modernFlowChatStore', () => {
  const store = Object.assign((select: (state: unknown) => unknown) => select({ visibleTurnInfo: null }),
    { getState: () => ({ setVisibleTurnInfo() {} }) });
  return { useVirtualItems: () => state.items, useActiveSession: () => state.session,
    useModernFlowChatStore: store, useModernFlowChatStoreApi: () => store };
});
vi.mock('../../timeline/useConversationTimeline', async () => {
  const { FlowChatReaderState } = await import('../../timeline/readerState');
  const reader = new FlowChatReaderState();
  return { useConversationTimeline: (items: VirtualItem[]) => ({ items, reader }) };
});
vi.mock('../../hooks/useActiveSessionState', () => ({ useActiveSessionState: () => ({ isProcessing: state.processing }) }));
vi.mock('../../store/chatInputStateStore', () => ({ useChatInputState: (select: (state: unknown) => unknown) => select({ inputHeight: 100 }) }));
vi.mock('../../hooks/useScrollToTurnHeader', () => ({ useScrollToTurnHeader: () => ({ shouldShowButton: false, handleClick() {} }) }));
vi.mock('./RuntimeStatusSlot', () => ({ RuntimeStatusSlot: () => null }));
vi.mock('../ScrollToLatestBar', () => ({ ScrollToLatestBar: () => null }));
vi.mock('../ScrollToTurnHeaderButton', () => ({ ScrollToTurnHeaderButton: () => null }));
vi.mock('./VirtualItemRenderer', () => ({
  VirtualItemRenderer: ({ item, index, measureRef }: {
    item: VirtualItem; index: number; measureRef: (element: HTMLElement | null) => void;
  }) => <div ref={measureRef} className="virtual-item-wrapper"
    data-item-type={item.type} data-turn-id={item.turnId} data-virtual-index={index}
    data-virtual-item-key={getVirtualItemStableKey(item)} />,
}));

// Full list, virtualizer, viewport owners and follow controller. Only row
// contents and jsdom's absent layout engine are supplied by this fixture.
describe('settled transcript resizing (real controllers, supplied DOM geometry)', () => {
  let root: Root, host: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>, frameId: number, now: number;
  let observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; sizes: WeakMap<Element, string> }>;
  let columnWidth = 900;
  let viewportHeight = 600;
  let containerFirst = false;
  const heights = new Map<string, number>();
  const offsets = new WeakMap<HTMLElement, number>();
  const px = (value: string) => Number.parseFloat(value || '0') || 0;
  const reversed = (element: HTMLElement) => element.dataset.flowchatScrollOrigin === 'end';
  // Cache only within one synchronous geometry read. DOM/style and supplied
  // row heights can change between any two reads, so no frame-level cache is safe.
  function height(element: HTMLElement, measured = new WeakMap<HTMLElement, number>()): number {
    const cached = measured.get(element);
    if (cached !== undefined) return cached;
    const result = measureHeight(element, measured);
    measured.set(element, result);
    return result;
  }
  function measureHeight(element: HTMLElement, measured: WeakMap<HTMLElement, number>): number {
    if (element.hasAttribute('data-flowchat-scroller')) return viewportHeight;
    if (element.dataset.virtualItemKey) return heights.get(element.dataset.virtualItemKey) ?? 100;
    if (element.style.height) return px(element.style.height);
    const scroller = element.closest<HTMLElement>('[data-flowchat-scroller]');
    if (scroller && reversed(scroller)) {
      const minimum = px(scroller.style.getPropertyValue('--_flow-chat-history-turn-min-height'));
      if (element.classList.contains('virtual-message-list__footer-block')) {
        const turn = element.parentElement!;
        const preceding = [...turn.children].filter(child => child !== element).reduce((sum, child) => sum + height(child as HTMLElement, measured), 0);
        const natural = [...element.children].reduce((sum, child) => sum + height(child as HTMLElement, measured), 0);
        return Math.max(natural, minimum - preceding);
      }
      if (element.dataset.historyTail === 'true') return Math.max(minimum, [...element.children].reduce((sum, child) => sum + height(child as HTMLElement, measured), 0));
    }
    return Math.max(element.classList.contains('virtual-message-list__extent') && reversed(element.parentElement!) ? 600 : px(element.style.minHeight), px(element.style.paddingTop) + px(element.style.paddingBottom)
      + [...element.children].reduce((sum, child) => sum + height(child as HTMLElement, measured), 0));
  }
  function contentTop(element: HTMLElement, measured: WeakMap<HTMLElement, number>): number {
    let top = 0;
    let current = element;
    while (current.parentElement && !current.hasAttribute('data-flowchat-scroller')) {
      let sibling = current.previousElementSibling;
      while (sibling) { top += height(sibling as HTMLElement, measured); sibling = sibling.previousElementSibling; }
      current = current.parentElement;
      top += px(current.style.paddingTop);
      if (current.hasAttribute('data-flowchat-scroller') && reversed(current)) top += 600 - height(current.firstElementChild as HTMLElement, measured);
    }
    return top;
  }
  function turn(id: string, answerHeight: number): VirtualItem[] {
    const items = [
      { type: 'user-message', turnId: id, data: { id: `user-${id}`, content: id } },
      { type: 'model-round', turnId: id, data: { id: `answer-${id}`, items: [], content: id }, isLastRound: true, isTurnComplete: true },
    ] as VirtualItem[];
    heights.set(getVirtualItemStableKey(items[0]), 44);
    heights.set(getVirtualItemStableKey(items[1]), answerHeight);
    return items;
  }
  const render = (contentWidth = 900, measurementSuspended = false) => act(() => root.render(
    <VirtualMessageList latestTurnId="latest" contentWidth={contentWidth} measurementSuspended={measurementSuspended} />,
  ));
  const tick = () => {
    now += 16;
    const pending = [...frames.values()]; frames.clear();
    act(() => pending.forEach(callback => callback(now)));
  };
  const resize = () => act(() => {
    for (const observer of (containerFirst ? [...observers].reverse() : [...observers])) {
      // ResizeObserver delivers changed boxes, not every observed node on every
      // frame. Collect sizes before calling back, since callbacks can mutate DOM.
      const measured = new WeakMap<HTMLElement, number>();
      const entries = [...observer.targets].filter(target => target.isConnected).flatMap(target => {
        const blockSize = height(target as HTMLElement, measured);
        const inlineSize = target.classList.contains('virtual-item-wrapper') ? columnWidth : 900;
        const size = `${inlineSize}:${blockSize}`;
        if (observer.sizes.get(target) === size) return [];
        observer.sizes.set(target, size);
        return [{ target, borderBoxSize: [{ inlineSize, blockSize }],
          contentRect: target.getBoundingClientRect() } as ResizeObserverEntry];
      });
      if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
  });
  const latest = () => host.querySelector<HTMLElement>('[data-virtual-item-key="model-round:latest:answer-latest"]');

  beforeEach(() => {
    activateSurface('local'); columnWidth = 900; viewportHeight = 600; containerFirst = false;
    state.processing = false;
    frames = new Map(); frameId = 0; now = 0; observers = []; heights.clear();
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal('ResizeObserver', class {
      targets = new Set<Element>();
      sizes = new WeakMap<Element, string>();
      constructor(public callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); this.sizes.delete(target); }
      disconnect() { this.targets.clear(); this.sizes = new WeakMap(); }
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return Math.round(height(this)); });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return Math.round(height(this)); });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return Math.round(this.hasAttribute('data-flowchat-scroller') ? height(this.firstElementChild as HTMLElement) : height(this));
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function () {
      const range = Math.max(0, this.scrollHeight - this.clientHeight);
      return reversed(this) ? Math.max(-range, Math.min(0, offsets.get(this) ?? 0)) : Math.min(offsets.get(this) ?? 0, range);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (value) {
      const range = Math.max(0, this.scrollHeight - this.clientHeight);
      offsets.set(this, reversed(this) ? Math.max(-range, Math.min(0, value)) : Math.max(0, Math.min(value, range)));
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const measured = new WeakMap<HTMLElement, number>();
      const scroller = this.closest<HTMLElement>('[data-flowchat-scroller]');
      const top = this === scroller ? 0 : contentTop(this, measured) - (scroller?.scrollTop ?? 0);
      return { x: 0, y: top, left: 0, right: 900, top, bottom: top + height(this, measured), height: height(this, measured), width: this.classList.contains('virtual-item-wrapper') ? columnWidth : 900, toJSON() {} };
    });
    state.items = turn('latest', 180);
    state.session = { sessionId: 'history-session', config: {}, dialogTurns: [], isHistorical: false } as unknown as Session;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); activateSurface('local');
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it.each(['local', 'peer-resume'].flatMap(surface => [false, true].map(live => ({ surface, live }))))(
    'observes suspended mounts after same-size resume without output or scroll on $surface (live=$live)', ({ surface, live }) => {
    activateSurface(surface);
    state.processing = live;
    const completedItems = turn('latest', 180);
    state.items = completedItems.slice(0, 1);
    render();
    for (let frame = 0; frame < 60; frame++) { resize(); tick(); }
    expect(host.querySelector('[data-open-viewport-settled="true"]')).not.toBeNull();

    viewportHeight = 0;
    resize();
    // The final answer mounts while minimized. No more output follows it.
    state.items = completedItems;
    state.processing = false;
    render();
    for (let frame = 0; frame < 4; frame++) tick();
    const row = latest()!;
    expect(row).not.toBeNull();
    expect(observers.some(observer => observer.targets.has(row))).toBe(false);

    viewportHeight = 600;
    resize();
    // Positive geometry schedules recovery, but measurements stay suspended
    // until that frame. Neither the viewport dimensions nor props changed.
    expect(observers.some(observer => observer.targets.has(row))).toBe(false);
    tick();
    expect(latest()).toBe(row);
    expect(observers.some(observer => observer.targets.has(row))).toBe(true);
  });

  it.each(['local', 'peer-scroll'].flatMap(surface => [0, 250].map(delayMs => ({ surface, delayMs }))))(
    'keeps visible rows still while wheeling into rows never measured on $surface (scroll delay=$delayMs ms)', ({ surface, delayMs }) => {
    activateSurface(surface);
    state.processing = true;
    const rows = [{ type: 'user-message', turnId: 'latest', data: { id: 'user-latest', content: 'latest' } }] as VirtualItem[];
    heights.set(getVirtualItemStableKey(rows[0]), 44);
    for (let index = 0; index < 90; index += 1) {
      const row = { type: 'model-round', turnId: 'latest', data: { id: `tool-${index}`, items: [], content: `tool ${index}` }, isLastRound: index === 89, isTurnComplete: true } as VirtualItem;
      rows.push(row);
      // Estimates miss in both directions: short tool rows and tall output.
      heights.set(getVirtualItemStableKey(row), index % 7 === 3 ? 640.5 : index % 3 === 0 ? 34 : 96.25);
    }
    state.items = [...turn('older', 400), ...rows];
    render();
    for (let frame = 0; frame < 60; frame++) { resize(); tick(); }
    state.processing = false;
    render();
    for (let frame = 0; frame < 30; frame++) { resize(); tick(); }
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const visibleRows = () => new Map([...host.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-virtual-item-key]')]
      .map(row => [row.dataset.virtualItemKey!, row.getBoundingClientRect().top - scroller.getBoundingClientRect().top] as const)
      .filter(([, top]) => top > -400 && top < viewportHeight));
    const unexplained: string[] = [];
    for (const delta of [...Array(40).fill(-260), ...Array(40).fill(260)]) {
      const before = visibleRows();
      act(() => { scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true })); });
      // A busy main thread delivers the scroll after the gesture window closed.
      now += delayMs;
      act(() => {
        scroller.scrollTop += delta;
        scroller.dispatchEvent(new Event('scroll'));
      });
      resize(); tick();
      for (const [key, top] of visibleRows()) {
        const previous = before.get(key);
        if (previous !== undefined && Math.abs(top - previous + delta) > 1) unexplained.push(`${key}:${(top - previous + delta).toFixed(1)}`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  it.each(['local', 'peer-stream'])('keeps one viewport observer while output streams on %s', surface => {
    activateSurface(surface);
    state.processing = true;
    const [user, answer] = turn('latest', 180);
    state.items = [user, answer];
    render();
    for (let frame = 0; frame < 60; frame++) { resize(); tick(); }
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const viewportObservers = observers.filter(observer => observer.targets.has(scroller));
    expect(viewportObservers.length).toBeGreaterThan(0);
    const created = observers.length;
    // Each flush replaces the live round and the item array; the Turn
    // boundary (its user message) is unchanged.
    for (let flush = 0; flush < 12; flush += 1) {
      const streamed = { ...answer, data: { ...(answer as { data: object }).data, content: `latest ${flush}` } } as VirtualItem;
      state.items = [user, streamed];
      render();
      tick();
    }
    // A rebound observer is a new instance and re-measures every mounted row.
    expect(observers.filter(observer => observer.targets.has(scroller))).toEqual(viewportObservers);
    expect(observers.length).toBe(created);
  });

  it.each(['local', 'peer-resize'].flatMap(surface => [false, true].map(first => ({ surface, first }))))(
    'keeps a loaded transcript fixed on $surface, container observer first=$first', ({ surface, first }) => {
    containerFirst = first;
    activateSurface(surface);
    state.items = [...Array.from({ length: 16 }, (_, index) => turn(`old-${index}`, 400.25 + index * 23.5)).flat(), ...turn('latest', 1400.25)];
    render();
    for (let i = 0; i < 60; i++) { resize(); tick(); }
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    expect(host.querySelector('[data-open-viewport-settled="true"]')).not.toBeNull();
    const row = latest()!;
    const bottom = row.getBoundingClientRect().bottom;
    const assertPlacement = () => {
      expect(latest()).toBe(row);
      expect(Math.abs(row.getBoundingClientRect().bottom - bottom)).toBeLessThanOrEqual(1);
    };
    for (const width of [800, 700, 600, 800, 1000, 900]) {
      render(900, true); // The persisted preference stays unchanged during the CSS preview.
      columnWidth = width;
      for (const item of state.items) {
        if (item.type === 'model-round') heights.set(getVirtualItemStableKey(item), (item.turnId === 'latest' ? 1400.25 : 600.25) * 900 / width);
      }
      resize(); assertPlacement(); // Before any RAF or native scroll event.
      tick(); assertPlacement();
      render(width, false); assertPlacement();
      resize(); tick();
      // No new output arrives after this completed reflow.
      assertPlacement();
      for (let i = 0; i < 60; i++) {
        resize(); tick();
        assertPlacement();
        if (i === 2) act(() => scroller.dispatchEvent(new Event('scroll')));
      }
    }
  });

  it.each(['local', 'peer-resize'].flatMap(surface => [false, true].map(first => ({ surface, first }))))(
    'keeps the reading row fixed on $surface, container observer first=$first', ({ surface, first }) => {
    containerFirst = first;
    activateSurface(surface);
    state.items = [...Array.from({ length: 16 }, (_, index) => turn(`old-${index}`, 400.25 + index * 23.5)).flat(), ...turn('latest', 1400.25)];
    render();
    for (let i = 0; i < 60; i++) { resize(); tick(); }
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -250 }));
      scroller.scrollTop -= 250;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const row = latest()!;
    const top = row.getBoundingClientRect().top;
    for (const width of [700, 1000, 650, 900]) {
      render(900, true);
      columnWidth = width;
      for (const item of state.items) {
        if (item.type === 'model-round' && item.turnId !== 'latest') {
          heights.set(getVirtualItemStableKey(item), 600.25 * 900 / width);
        }
      }
      resize();
      expect(latest()).toBe(row);
      expect(Math.abs(row.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1);
      render(width, false);
      for (let frame = 0; frame < 20; frame++) {
        resize(); tick();
        expect(latest()).toBe(row);
        expect(Math.abs(row.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1);
      }
    }
  });
});
