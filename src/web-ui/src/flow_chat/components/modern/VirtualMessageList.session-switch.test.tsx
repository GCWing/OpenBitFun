// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { VirtualMessageList } from './VirtualMessageList';
import { retainedTranscriptRowSizes } from '../../timeline/retainedViewMemory';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { Session } from '../../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ items: [] as VirtualItem[], session: null as Session | null, processing: false }));
const counters = vi.hoisted(() => ({ corrections: 0, commits: 0, firstCommitRows: 0, mounts: 0, unmounts: 0 }));
vi.mock('../../store/modernFlowChatStore', () => {
  const store = Object.assign((select: (state: unknown) => unknown) => select({ visibleTurnInfo: null }),
    { getState: () => ({ setVisibleTurnInfo() {} }) });
  return { useVirtualItems: () => state.items, useActiveSession: () => state.session,
    useModernFlowChatStore: store, useModernFlowChatStoreApi: () => store };
});
vi.mock('../../timeline/useConversationTimeline', async () => {
  const { FlowChatReaderState } = await import('../../timeline/readerState');
  const readers = new Map<string, InstanceType<typeof FlowChatReaderState>>();
  const readerFor = (sessionId = '') => {
    let reader = readers.get(sessionId);
    if (!reader) readers.set(sessionId, reader = new FlowChatReaderState());
    return reader;
  };
  return { useConversationTimeline: (items: VirtualItem[], sessionId?: string) => ({ items, reader: readerFor(sessionId) }) };
});
// Count the size corrections the virtualizer accepts: a row whose measured
// height differs from the size it had reserved for it.
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  class CountingVirtualizer<S extends Element, I extends Element> extends actual.Virtualizer<S, I> {
    constructor(options: ConstructorParameters<typeof actual.Virtualizer<S, I>>[0]) {
      super(options);
      const resize = this.resizeItem;
      this.resizeItem = (index, size) => {
        const item = this.measurementsCache[index];
        const cache = (this as unknown as { itemSizeCache: Map<unknown, number> }).itemSizeCache;
        if (item && (cache.get(item.key) ?? item.size) !== size) counters.corrections += 1;
        resize(index, size);
      };
    }
  }
  return { ...actual, Virtualizer: CountingVirtualizer };
});
vi.mock('../../hooks/useActiveSessionState', () => ({ useActiveSessionState: () => ({ isProcessing: state.processing }) }));
vi.mock('../../store/chatInputStateStore', () => ({ useChatInputState: (select: (state: unknown) => unknown) => select({ inputHeight: 100 }) }));
vi.mock('../../hooks/useScrollToTurnHeader', () => ({ useScrollToTurnHeader: () => ({ shouldShowButton: false, handleClick() {} }) }));
vi.mock('./RuntimeStatusSlot', () => ({ RuntimeStatusSlot: () => null }));
vi.mock('../ScrollToLatestBar', () => ({ ScrollToLatestBar: () => null }));
vi.mock('../ScrollToTurnHeaderButton', () => ({ ScrollToTurnHeaderButton: () => null }));
vi.mock('./VirtualItemRenderer', async () => {
  const { useLayoutEffect } = await import('react');
  return {
    VirtualItemRenderer: ({ item, index, measureRef }: {
      item: VirtualItem; index: number; measureRef: (element: HTMLElement | null) => void;
    }) => {
      useLayoutEffect(() => { counters.mounts += 1; return () => { counters.unmounts += 1; }; }, []);
      return <div ref={measureRef} className="virtual-item-wrapper"
        data-item-type={item.type} data-turn-id={item.turnId} data-virtual-index={index}
        data-virtual-item-key={getVirtualItemStableKey(item)} />;
    },
  };
});

// Full list, virtualizer, viewport owners and follow controller. Only row
// contents and jsdom's absent layout engine are supplied by this fixture,
// which is the one `VirtualMessageList.resize.test.tsx` uses.
describe('switching between long sessions (real controllers, supplied DOM geometry)', () => {
  let root: Root, host: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>, frameId: number, now: number;
  let observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; sizes: WeakMap<Element, string> }>;
  let columnWidth = 900;
  let viewportWidth = 900;
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
    if (element.dataset.virtualItemKey) return (heights.get(element.dataset.virtualItemKey) ?? 100) * 900 / columnWidth;
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
  let paneGeometry: React.MutableRefObject<{ width: number; height: number } | undefined> | undefined;
  let contentPresented = true, viewportActive = true;
  const render = (contentWidth = 900) => act(() => root.render(
    <React.Profiler id="flowchat" onRender={() => {
      counters.commits += 1;
      if (counters.commits === 1) counters.firstCommitRows = host.querySelectorAll('[data-virtual-item-key]').length;
    }}>
      <VirtualMessageList latestTurnId={`${state.session?.sessionId}-latest`} contentWidth={contentWidth}
        viewportRectRef={paneGeometry} contentPresented={contentPresented} isViewportActive={viewportActive} />
    </React.Profiler>,
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
        const inlineSize = target.classList.contains('virtual-item-wrapper') ? columnWidth : viewportWidth;
        const size = `${inlineSize}:${blockSize}`;
        if (observer.sizes.get(target) === size) return [];
        observer.sizes.set(target, size);
        return [{ target, borderBoxSize: [{ inlineSize, blockSize }],
          contentRect: target.getBoundingClientRect() } as ResizeObserverEntry];
      });
      if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
  });

  beforeEach(() => {
    paneGeometry = undefined;
    contentPresented = viewportActive = true;
    activateSurface('local'); columnWidth = viewportWidth = 900; viewportHeight = 600; containerFirst = false;
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
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () { return this.classList.contains('virtual-item-wrapper') ? columnWidth : viewportWidth; });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () { return this.classList.contains('virtual-item-wrapper') ? columnWidth : viewportWidth; });
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
      const width = this.classList.contains('virtual-item-wrapper') ? columnWidth : viewportWidth;
      return { x: 0, y: top, left: 0, right: width, top, bottom: top + height(this, measured), height: height(this, measured), width, toJSON() {} };
    });
    Object.assign(counters, { corrections: 0, commits: 0, firstCommitRows: 0, mounts: 0, unmounts: 0 });
    retainedTranscriptRowSizes.clear();
    sessions = undefined!;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); activateSurface('local');
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });


  // Two long transcripts whose real heights are far from their estimates.
  function session(id: string, turns: number) {
    const items = Array.from({ length: turns }, (_, index) => turn(`${id}-${index === turns - 1 ? 'latest' : index}`,
      380.5 + ((index * 7919) % 13) * 97.25)).flat();
    return { items, session: { sessionId: id, config: {}, dialogTurns: [], isHistorical: false } as unknown as Session };
  }
  type SessionId = 'a' | 'b' | 'c' | 'd' | 'e';
  let sessions: Record<SessionId, ReturnType<typeof session>>;
  const settled = () => host.querySelector('[data-open-viewport-settled="true"]') !== null;
  /** Open a session and run frames until the opening reveal settles; return what that cost. */
  function open(id: SessionId) {
    sessions ??= {} as typeof sessions;
    sessions[id] ??= session(id, 24);
    const mountedBefore = host.querySelectorAll('[data-virtual-item-key]').length;
    Object.assign(counters, { corrections: 0, commits: 0, mounts: 0, unmounts: 0 });
    state.items = sessions[id].items;
    state.session = sessions[id].session;
    render();
    let frames = 0;
    for (; frames < 120 && (!settled() || frames < 4); frames++) { resize(); tick(); }
    for (let frame = 0; frame < 8; frame++) { resize(); tick(); }
    const latestRow = host.querySelector<HTMLElement>(`[data-virtual-item-key="model-round:${id}-latest:answer-${id}-latest"]`);
    // Rows of this session that mounted and were unmounted again while it opened.
    const churn = counters.unmounts - mountedBefore;
    return { ...counters, churn, frames, settled: settled(), latestBottom: latestRow?.getBoundingClientRect().bottom ?? null };
  }

  // Measured baseline before retention, per open in this fixture:
  // native history 7 corrections / 6 commits / 7 mounts / 3 dropped rows,
  // live 6 / 6 / 6 / 2. Reopening cost exactly the same as a first open.
  it('reopens a recent native-history session from its measured sizes', () => {
    const firstA = open('a');
    const firstB = open('b');
    const reopenA = open('a');
    const reopenB = open('b');
    // A new session can already reserve the pane's observed box, while only a
    // reopened session owns measured row sizes.
    expect(firstB.commits).toBeLessThan(firstA.commits);
    for (const [first, reopen] of [[firstA, reopenA], [firstB, reopenB]]) {
      expect(first.settled && reopen.settled).toBe(true);
      expect(first.corrections).toBeGreaterThan(0);
      // No mounted row disagrees with what it reserved, so nothing re-measures
      // into a new window and no row mounts only to be dropped again.
      expect(reopen.corrections).toBe(0);
      expect(reopen.churn).toBe(0);
      expect(first.churn).toBeGreaterThan(0);
      expect(reopen.mounts).toBeLessThan(first.mounts);
      expect(reopen.commits).toBeLessThanOrEqual(first.commits);
      // The same placement the first open settled on.
      expect(reopen.latestBottom).toBeCloseTo(first.latestBottom!, 0);
    }
  });

  it('reopens a recent live session without correcting any mounted row', () => {
    state.processing = true;
    const firstA = open('a');
    open('b');
    const reopenA = open('a');
    expect(firstA.settled && reopenA.settled).toBe(true);
    expect(firstA.corrections).toBeGreaterThan(0);
    expect(reopenA.corrections).toBe(0);
    expect(reopenA.mounts).toBeLessThan(firstA.mounts);
    expect(reopenA.commits).toBeLessThan(firstA.commits);
    expect(reopenA.latestBottom).toBeCloseTo(firstA.latestBottom!, 0);
  });

  it.each([false, true])('reserves the pane through a loading gap without sharing row sizes (live=%s)', live => {
    state.processing = live;
    paneGeometry = { current: undefined };
    const first = open('a');
    expect(paneGeometry.current).toEqual({ width: 900, height: 600 });
    act(() => root.render(null));
    const next = open('b');
    expect(next.settled).toBe(true);
    expect(next.corrections).toBeGreaterThan(0);
    expect(first.firstCommitRows).toBe(0);
    expect(next.firstCommitRows).toBeGreaterThan(0);
    expect(next.latestBottom).toBeCloseTo(first.latestBottom!, 0);

    // Another pane has its own geometry owner, even in the same document.
    const firstPane = paneGeometry;
    act(() => root.render(null));
    paneGeometry = { current: undefined };
    viewportHeight = 420; viewportWidth = columnWidth = 600;
    expect(open('c').settled).toBe(true);
    expect(paneGeometry.current).toEqual({ width: 600, height: 420 });
    expect(firstPane.current).toEqual({ width: 900, height: 600 });
  });

  it('prepares one history margin leaf per idle frame only after visible presentation', () => {
    const idle = new Map<number, IdleRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => { idle.set(++id, callback); return id; });
    vi.stubGlobal('cancelIdleCallback', (key: number) => idle.delete(key));
    contentPresented = false;
    const opened = open('a');
    expect(opened.settled).toBe(true);
    expect(idle.size).toBe(0);
    const rows = () => host.querySelectorAll('[data-virtual-item-key]').length;
    const before = rows();
    contentPresented = true; render(); tick(); tick();
    expect(idle.size).toBe(1);
    const deliver = (remaining: number) => act(() => {
      const [key, callback] = idle.entries().next().value!;
      idle.delete(key); callback({ didTimeout: false, timeRemaining: () => remaining });
    });
    deliver(0);
    expect(rows()).toBe(before);
    tick(); deliver(20);
    expect(rows()).toBeGreaterThanOrEqual(before);
    expect(rows()).toBeLessThanOrEqual(before + 1);
    const latest = host.querySelector<HTMLElement>('[data-virtual-item-key="model-round:a-latest:answer-a-latest"]')!;
    expect(latest.getBoundingClientRect().bottom).toBeCloseTo(opened.latestBottom!, 0);
    tick(); expect(idle.size).toBe(1);
    viewportActive = false; render();
    expect(idle.size).toBe(0);
  });

  it('keeps only the most recently left sessions', () => {
    const firstA = open('a');
    for (const id of ['b', 'c', 'd', 'e'] as const) open(id);
    // a was left four sessions ago and has been evicted; d is still retained.
    expect(retainedTranscriptRowSizes.size).toBe(3);
    const evictedA = open('a');
    expect(evictedA.corrections).toBeGreaterThan(0);
    expect(evictedA.corrections).toBeLessThanOrEqual(firstA.corrections);
    expect(evictedA.latestBottom).toBeCloseTo(firstA.latestBottom!, 0);
    const retainedD = open('d');
    expect(retainedD.corrections).toBe(0);
  });

  it('measures rows that changed since the session was left', () => {
    const firstA = open('a');
    open('b');
    // The latest answer grew while a was not shown.
    const latestKey = 'model-round:a-latest:answer-a-latest';
    heights.set(latestKey, heights.get(latestKey)! + 240);
    const reopenA = open('a');
    expect(reopenA.settled).toBe(true);
    expect(reopenA.corrections).toBe(1);
    expect(reopenA.corrections).toBeLessThan(firstA.corrections);
    const row = host.querySelector<HTMLElement>(`[data-virtual-item-key="${latestKey}"]`)!;
    expect(row.getBoundingClientRect().height).toBe(heights.get(latestKey));
  });

  it.each([false, true])('replaces the retained viewport reservation after a hidden resize (live=%s)', live => {
    state.processing = live;
    open('a'); open('b');
    viewportHeight = 420;
    viewportWidth = columnWidth = 600;
    const reopened = open('a');
    const fresh = open('c');
    expect(reopened.settled && fresh.settled).toBe(true);
    expect(reopened.latestBottom).toBeCloseTo(fresh.latestBottom!, 0);
    viewportHeight = 800;
    viewportWidth = 1000; columnWidth = 900;
    const grown = open('a');
    const freshGrown = open('d');
    expect(grown.settled && freshGrown.settled).toBe(true);
    expect(grown.latestBottom).toBeCloseTo(freshGrown.latestBottom!, 0);
  });
});
