// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isSubmittedMessageScrollIntentPending, registerSubmittedMessageScrollIntent } from '../../services/submittedMessageScrollIntent';
import { VirtualMessageList, type VirtualMessageListRef } from './VirtualMessageList';
import { getVirtualItemStableKey } from './virtualItemIdentity';
import type { VirtualItem } from '../../store/modernFlowChatStore';
import type { FlowToolItem, Session } from '../../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ items: [] as VirtualItem[], session: null as Session | null, processing: false }));
vi.mock('../../store/modernFlowChatStore', () => {
  const store = Object.assign((select: (state: unknown) => unknown) => select({ visibleTurnInfo: null }),
    { getState: () => ({ setVisibleTurnInfo() {} }) });
  return { useVirtualItems: () => state.items, useActiveSession: () => state.session,
    useModernFlowChatStore: store, useModernFlowChatStoreApi: () => store };
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
    data-item-type={item.type} data-timeline-kind={item.timeline?.kind} data-turn-id={item.turnId} data-virtual-index={index}
    data-virtual-item-key={getVirtualItemStableKey(item)} data-markdown-section-start={item.timeline?.markdownSection?.start} />,
}));

// Full list, virtualizer, viewport owners and follow controller. Only row
// contents and jsdom's absent layout engine are supplied by this fixture.
describe('completed history with the production timeline projection', () => {
  let root: Root, host: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>, frameId: number, now: number;
  let observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element>; sizes: WeakMap<Element, string> }>;
  let writes: number[];
  const listRef = createRef<VirtualMessageListRef>();
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
    if (element.hasAttribute('data-flowchat-scroller')) return 600;
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
  function turn(id: string, answerHeight: number, blocks = 10): VirtualItem[] {
    const members = Array.from({ length: blocks }, (_, index) => ({
      id: `answer-${id}-${index}`, type: 'text', status: 'completed', isStreaming: false,
      content: `Completed paragraph ${index}. `.repeat(8), timestamp: 1,
    }));
    const items = [
      { type: 'user-message', turnId: id, data: { id: `user-${id}`, content: id } },
      { type: 'model-round', turnId: id,
        data: { id: `round-${id}`, items: members, status: 'completed', isComplete: true, isStreaming: false },
        isLastRound: true, isTurnComplete: true },
    ] as VirtualItem[];
    heights.set(`block:user-message:${id}:user-${id}`, 44);
    members.forEach((item, index) => heights.set(`block:${id}:${item.id}`, index === blocks - 1 ? answerHeight : 100));
    heights.set(`block:${id}:round-${id}:footer`, 32);
    return items;
  }
  const render = () => act(() => root.render(<VirtualMessageList ref={listRef} latestTurnId="latest" />));
  const tick = () => {
    now += 16;
    const pending = [...frames.values()]; frames.clear();
    act(() => pending.forEach(callback => callback(now)));
  };
  const resize = () => act(() => {
    for (const observer of [...observers]) {
      // ResizeObserver delivers changed boxes, not every observed node on every
      // frame. Collect sizes before calling back, since callbacks can mutate DOM.
      const measured = new WeakMap<HTMLElement, number>();
      const entries = [...observer.targets].filter(target => target.isConnected).flatMap(target => {
        const blockSize = height(target as HTMLElement, measured);
        const inlineSize = 900;
        const size = `${inlineSize}:${blockSize}`;
        if (observer.sizes.get(target) === size) return [];
        observer.sizes.set(target, size);
        return [{ target, borderBoxSize: [{ inlineSize, blockSize }],
          contentRect: target.getBoundingClientRect() } as ResizeObserverEntry];
      });
      if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
  });
  const latest = () => host.querySelector<HTMLElement>('[data-virtual-item-key="block:latest:answer-latest-9"]');

  beforeEach(() => {
    activateSurface('local'); state.processing = false; writes = [];
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
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return height(this); });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return height(this); });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.hasAttribute('data-flowchat-scroller') ? height(this.firstElementChild as HTMLElement) : height(this);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function () {
      const range = Math.max(0, this.scrollHeight - this.clientHeight);
      return reversed(this) ? Math.max(-range, Math.min(0, offsets.get(this) ?? 0)) : Math.min(offsets.get(this) ?? 0, range);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (value) {
      if (this.hasAttribute('data-flowchat-scroller')) writes.push(value);
      const range = Math.max(0, this.scrollHeight - this.clientHeight);
      offsets.set(this, reversed(this) ? Math.max(-range, Math.min(0, value)) : Math.max(0, Math.min(value, range)));
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const measured = new WeakMap<HTMLElement, number>();
      const scroller = this.closest<HTMLElement>('[data-flowchat-scroller]');
      const top = this === scroller ? 0 : contentTop(this, measured) - (scroller?.scrollTop ?? 0);
      return { x: 0, y: top, left: 0, right: 900, top, bottom: top + height(this, measured), height: height(this, measured), width: 900, toJSON() {} };
    });
    state.items = turn('latest', 180);
    state.session = { sessionId: 'history-session', config: {}, dialogTurns: [], isHistorical: false } as unknown as Session;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove(); activateSurface('local');
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  const pages = [
    { page: 'whole older turn', partial: false, addsTurn: true },
    { page: 'older turn plus missing earlier blocks', partial: true, addsTurn: true },
    { page: 'missing earlier blocks within the loaded head', partial: true, addsTurn: false },
  ];
  it('presents an empty projected tail and accepts navigation into earlier history', () => {
    state.items = [];
    render();
    for (let index = 0; index < 45; index++) tick();
    expect(host.querySelector('[data-testid="flowchat-message-list-empty"]')).not.toBeNull();
    act(() => expect(listRef.current!.prepareTurnNavigation('previous', { behavior: 'auto' })).toBe('pending'));
    state.items = turn('previous', 180);
    render(); resize();
    for (let index = 0; index < 45; index++) tick();
    expect(host.querySelector('[data-turn-id="previous"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.virtual-message-list')!.dataset.openViewportSettled).toBe('true');
  });
  it('publishes the latest committed history window without a mutation-phase snapshot on paging', () => {
    const onSnapshot = vi.fn();
    const list = (startOrdinal: number) => <VirtualMessageList ref={listRef} latestTurnId="latest"
      historyWindow={{ startOrdinal, endOrdinalExclusive: 80 }} onViewportSnapshot={onSnapshot} />;
    act(() => root.render(list(79)));
    for (let index = 0; index < 45; index++) tick();
    onSnapshot.mockClear();
    act(() => root.render(list(74)));
    expect(onSnapshot).not.toHaveBeenCalled();
    // A second commit before the scheduled frame must not publish old metadata.
    act(() => root.render(list(68)));
    expect(onSnapshot).not.toHaveBeenCalled();
    tick();
    expect(onSnapshot.mock.calls.at(-1)?.[0].historyWindow.startOrdinal).toBe(68);
    onSnapshot.mockClear();
    act(() => root.render(null));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0][0].historyWindow.startOrdinal).toBe(68);
  });
  it('bounds DOM residency within a huge complete tail without moving its painted end on prepend', () => {
    const tail = turn('latest', 180, 800);
    state.items = tail;
    render();
    for (let i = 0; i < 45; i++) tick();
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const last = host.querySelector<HTMLElement>('[data-virtual-item-key="block:latest:answer-latest-799"]')!;
    const top = last.getBoundingClientRect().top;
    expect(host.querySelector('[data-virtual-item-key="block:user-message:latest:user-latest"]')).toBeNull();
    expect(host.querySelector<HTMLElement>('.virtual-message-list')!.dataset.openViewportSettled).toBe('true');
    expect(host.querySelectorAll('.virtual-item-wrapper').length).toBeLessThan(40);
    expect(top).toBeLessThan(600);
    expect(last.getBoundingClientRect().bottom).toBeGreaterThan(0);
    writes = [];
    state.items = [...turn('older', 100, 800), ...tail];
    render(); resize(); tick();
    expect(host.querySelector('[data-virtual-item-key="block:latest:answer-latest-799"]')).toBe(last);
    expect(last.getBoundingClientRect().top).toBeCloseTo(top, 1);
    expect(scroller.scrollTop).toBe(0);
    expect(writes).toEqual([]);
    expect(host.querySelectorAll('.virtual-item-wrapper').length).toBeLessThan(40);
  });
  it.each(['local', 'peer-history'].flatMap(surface => pages.flatMap(page =>
    [false, true].map(reading => ({ surface, ...page, reading })))),
  )('holds the painted row for $page on $surface, reading=$reading', ({ surface, partial, addsTurn, reading }) => {
    activateSurface(surface);
    const previous = turn('previous', 700);
    const tail = turn('latest', 1400);
    // Relay records are paged newest first. The first loaded Turn can still
    // lack earlier blocks even though its user message and status are present.
    const partialPrevious = previous.map(item => item.type === 'model-round'
      ? { ...item, data: { ...item.data, items: item.data.items.slice(6) } } : item);
    state.items = [...(partial ? partialPrevious : previous), ...tail];
    render();
    for (let i = 0; i < 45; i++) tick();
    expect(host.querySelector('[data-open-viewport-settled="true"]')).not.toBeNull();
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    if (reading) act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -160 }));
      scroller.scrollTop -= 160;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const row = latest()!;
    expect(row).not.toBeNull();
    const top = row.getBoundingClientRect().top;
    state.items = [...(addsTurn ? turn('earliest', 900) : []), ...previous, ...tail];
    render();
    expect(latest()).toBe(row);
    expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
    for (let frame = 0; frame < 30; frame++) {
      resize(); tick();
      if (frame === 2) act(() => scroller.dispatchEvent(new Event('scroll')));
      if (frame === 5) act(() => vi.advanceTimersByTime(200));
      expect(latest()).toBe(row);
      expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
    }
  });

  it('renders inserted blocks below the reading edge even when that edge needs no displacement', () => {
    const previous = turn('previous', 700);
    const tail = turn('latest', 1400);
    state.items = [...previous.map(item => item.type === 'model-round'
      ? { ...item, data: { ...item.data, items: item.data.items.slice(6) } } : item), ...tail];
    render();
    for (let i = 0; i < 45; i++) tick();
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -4000 }));
      scroller.scrollTop = reversed(scroller) ? -(scroller.scrollHeight - scroller.clientHeight) : 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    for (let frame = 0; frame < 5; frame++) {
      resize(); tick();
      act(() => { scroller.scrollTop = -(scroller.scrollHeight - scroller.clientHeight); scroller.dispatchEvent(new Event('scroll')); });
    }
    const row = host.querySelector<HTMLElement>('[data-virtual-item-key="block:user-message:previous:user-previous"]')!;
    expect(row).not.toBeNull();
    const top = row.getBoundingClientRect().top;
    state.items = [...previous, ...tail];
    render();
    expect(row.isConnected).toBe(true);
    expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
    expect(host.querySelector('[data-virtual-item-key="block:previous:answer-previous-0"]')).not.toBeNull();
  });

  it.each(['local', 'peer-history'].flatMap(surface => ['text', 'tools'].map(content => ({ surface, content }))))(
    'keeps the visible $content of a short single Turn in place on $surface', ({ surface, content }) => {
    activateSurface(surface);
    const complete = turn('latest', 20).map(item => item.type === 'model-round' && content === 'tools'
      ? { ...item, data: { ...item.data, items: item.data.items.map((member, index): FlowToolItem => ({
        id: member.id, type: 'tool', timestamp: 1, status: 'completed',
        toolName: index >= 6 && index <= 8 ? 'ComputerUse' : 'DesktopCard',
        toolCall: { id: member.id, input: { action: index === 6 ? 'list_windows'
          : index === 7 || index === 8 ? 'get_app_state' : 'update' } },
        toolResult: { success: true, result: {} },
      })) } } : item);
    for (let index = 0; index < 10; index++) heights.set(`block:latest:answer-latest-${index}`, 20);
    heights.set('block:latest:group:round-latest:interface:answer-latest-7', 32);
    state.items = complete;
    render();
    for (let i = 0; i < 45; i++) tick();
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const row = latest()!;
    const user = host.querySelector<HTMLElement>('[data-item-type="user-message"]')!;
    expect(user.getBoundingClientRect().top).toBeCloseTo(8, 1);
    expect(row.getBoundingClientRect().bottom).toBeLessThan(scroller.clientHeight);
    if (content === 'tools') expect(host.querySelector('[data-timeline-kind="group-header"]')).not.toBeNull();
    const top = row.getBoundingClientRect().top;
    expect(scroller.dataset.flowchatScrollOrigin).toBe('end');
    expect(scroller.scrollTop).toBe(0);
    writes = [];
    // Each admitted history unit is complete. Older Turns insert outside the
    // tail's CSS reservation, leaving the complete short Turn at the top.
    for (const count of [1, 2]) {
      state.items = [...Array.from({ length: count }, (_, i) => turn(`older-${i}`, 700)).flat(), ...complete];
      render();
      // ModernFlowChatContainer retries this when Turn summaries change.
      act(() => { expect(listRef.current!.scrollToTurnEnd('latest')).toBe(true); });
      expect(latest()).toBe(row);
      expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
      resize(); tick();
      expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
      for (const previous of host.querySelectorAll<HTMLElement>('.virtual-item-wrapper:not([data-turn-id="latest"])')) {
        expect(previous.getBoundingClientRect().bottom).toBeLessThanOrEqual(scroller.getBoundingClientRect().top + 8);
      }
    }
    for (let frame = 0; frame < 30; frame++) {
      // Late measurements of newly inserted predecessors, including a card
      // still partly visible above the formerly first output, cannot restart ease.
      if (frame === 3) heights.set('block:older-0:answer-older-0-5', 164.25);
      if (frame === 8) heights.set('block:older-0:answer-older-0-5', 28.5);
      // Native layout already holds the output before React/observers run.
      expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
      resize(); tick();
      if (frame === 2) act(() => scroller.dispatchEvent(new Event('scroll')));
      expect(latest()).toBe(row);
      expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
    }
    expect(writes).toEqual([]); // No height-delta write, easing or delayed repair.
    // A real runtime start hands the same DOM to live output. Ordinary history
    // hydration above did not change origin or manufacture a follow animation.
    state.processing = true;
    render(); resize();
    for (let frame = 0; frame < 40; frame++) tick();
    expect(scroller.dataset.flowchatScrollOrigin).toBe('start');
    expect(latest()).toBe(row);
    const beforeGrowth = scroller.scrollTop;
    heights.set('block:latest:answer-latest-9', 700);
    resize();
    expect(scroller.scrollTop).toBeCloseTo(beforeGrowth, 1);
    const target = scroller.scrollHeight - scroller.clientHeight;
    tick();
    expect(scroller.scrollTop).toBeGreaterThan(beforeGrowth);
    expect(scroller.scrollTop).toBeLessThan(target);
  });

  it('lets an edge gesture request older history without turning a stationary bubble into an anchor', () => {
    const complete = turn('latest', 20);
    for (let index = 0; index < 10; index++) heights.set(`block:latest:answer-latest-${index}`, 20);
    state.items = complete;
    render();
    for (let i = 0; i < 45; i++) tick();
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const row = latest()!;
    const top = row.getBoundingClientRect().top;
    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })));
    state.items = [...turn('older', 700), ...complete];
    render();
    for (let frame = 0; frame < 30; frame++) {
      expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
      resize(); tick();
      if (frame === 2) act(() => scroller.dispatchEvent(new Event('scroll')));
      if (frame === 5) act(() => vi.advanceTimersByTime(200));
    }
    expect(row.isConnected).toBe(true);
    expect(scroller.scrollTop).toBe(0);
  });

  it.each(['local', 'peer-history'])('keeps the native origin after hydration clears its historical flag on %s', surface => {
    activateSurface(surface);
    state.session!.isHistorical = true;
    render();
    for (let frame = 0; frame < 45; frame++) tick();
    const row = latest()!;
    const top = row.getBoundingClientRect().top;
    writes = [];
    state.session = { ...state.session!, isHistorical: false };
    state.items = [...turn('older', 3000), ...state.items];
    render(); resize(); tick();
    expect(latest()).toBe(row);
    expect(row.getBoundingClientRect().top).toBeCloseTo(top, 1);
    expect(host.querySelector<HTMLElement>('[data-flowchat-scroller]')!.dataset.flowchatScrollOrigin).toBe('end');
    expect(writes).toEqual([]);
  });

  it('navigates in chronological coordinates and restores an existing bookmark in native history', () => {
    state.items = [...Array.from({ length: 30 }, (_, i) => turn(`old-${i}`, 500)).flat(), ...turn('latest', 900)];
    render();
    for (let frame = 0; frame < 45; frame++) tick();
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    expect(host.querySelectorAll('.virtual-item-wrapper').length).toBeLessThan(40);
    act(() => { expect(listRef.current!.navigateToTurn('old-12', { behavior: 'auto' })).toBe(true); });
    for (let frame = 0; frame < 20; frame++) { resize(); tick(); act(() => scroller.dispatchEvent(new Event('scroll'))); }
    const user = host.querySelector<HTMLElement>('[data-virtual-item-key="block:user-message:old-12:user-old-12"]')!;
    expect(user).not.toBeNull();
    expect(user.getBoundingClientRect().top).toBeCloseTo(8, 1);
    const snapshot = listRef.current!.captureViewportSnapshot()!;
    expect(snapshot.scrollTopPx).toBeGreaterThan(0); // Existing persisted convention.
    act(() => listRef.current!.scrollToLatestEndPosition());
    for (let frame = 0; frame < 80; frame++) { if (frame < 3) resize(); tick(); }
    expect(scroller.scrollTop).toBe(0);
    act(() => listRef.current!.prepareItemNavigation());
    for (let frame = 0; frame < 20; frame++) {
      act(() => { listRef.current!.restoreViewportSnapshot(snapshot); });
      resize(); tick();
    }
    const restored = listRef.current!.captureViewportSnapshot()!;
    expect(restored.anchorItemKey).toBe(snapshot.anchorItemKey);
    expect(restored.anchorOffsetPx).toBeCloseTo(snapshot.anchorOffsetPx!, 1);
  });


  it('restores whole-text legacy/live bookmark coordinates after history starts sectioning', () => {
    state.items = turn('latest', 6000, 1);
    const source = state.items[1] as Extract<VirtualItem, { type: 'model-round' }>;
    source.data.items[0] = { ...source.data.items[0], isMarkdown: true,
      content: 'A complete Markdown paragraph.\n\n'.repeat(700) } as typeof source.data.items[number];
    render();
    for (let frame = 0; frame < 45; frame++) tick();
    expect(host.querySelector('[data-markdown-section-start]')).not.toBeNull();
    const snapshot = JSON.parse(JSON.stringify({ sessionId: state.session!.sessionId,
      presentationMode: 'tail', viewportMode: 'history-reading', historyWindow: null,
      anchorTurnId: 'latest', anchorItemKey: 'block:latest:answer-latest-0',
      anchorOffsetPx: -1200, scrollTopPx: 1244, isAtTail: false, capturedAtMs: 1 }));
    act(() => listRef.current!.prepareItemNavigation());
    for (let frame = 0; frame < 20; frame++) {
      act(() => { listRef.current!.restoreViewportSnapshot(snapshot); });
      resize(); tick();
    }
    expect(host.querySelector('[data-markdown-section-start]')).toBeNull();
    const restored = listRef.current!.captureViewportSnapshot()!;
    expect(restored.anchorItemKey).toBe(snapshot.anchorItemKey);
    expect(restored.anchorOffsetPx).toBeCloseTo(-1200, 1);
  });

  it('hands a long historical viewport to resumed output without remounting the visible tail', () => {
    state.items = [...Array.from({ length: 30 }, (_, i) => turn(`old-${i}`, 500)).flat(), ...turn('latest', 900)];
    render();
    for (let frame = 0; frame < 45; frame++) tick();
    const row = latest()!;
    const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
    const bottom = row.getBoundingClientRect().bottom;
    state.processing = true;
    render();
    expect(scroller.dataset.flowchatScrollOrigin).toBe('start');
    expect(latest()).toBe(row);
    for (let frame = 0; frame < 10; frame++) {
      resize(); tick();
      expect(latest()).toBe(row);
    }
    // Live output now owns its usual reading line, with the same concrete row.
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom);
    expect(row.getBoundingClientRect().bottom).toBeGreaterThan(0);
  });


  it.each(['local', 'peer-history'])('places an explicitly submitted message once after leaving native history on %s', surface => {
    activateSurface(surface);
    state.items = [...Array.from({ length: 20 }, (_, i) => turn(`old-${i}`, 500)).flat(), ...turn('latest', 900)];
    render();
    for (let frame = 0; frame < 45; frame++) tick();
    const oldRow = latest()!;
    let intent!: NonNullable<ReturnType<typeof registerSubmittedMessageScrollIntent>>;
    act(() => { intent = registerSubmittedMessageScrollIntent(getActiveSurfaceScope(), 'history-session', 'submitted', 'user-submitted')!; });
    expect(latest()).toBe(oldRow);
    state.items = [...state.items, turn('submitted', 0)[0]];
    render();
    for (let frame = 0; frame < 10; frame++) { resize(); tick(); }
    const user = host.querySelector<HTMLElement>('[data-virtual-item-key="block:user-message:submitted:user-submitted"]')!;
    expect(user).not.toBeNull();
    expect(user.getBoundingClientRect().top).toBeCloseTo(8, 1);
    expect(host.querySelector<HTMLElement>('[data-flowchat-scroller]')!.dataset.flowchatScrollOrigin).toBe('start');
    expect(isSubmittedMessageScrollIntentPending(intent)).toBe(false);
  });

});
