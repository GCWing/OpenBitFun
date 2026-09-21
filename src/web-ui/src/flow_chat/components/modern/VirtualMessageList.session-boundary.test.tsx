// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFlowChatInputStackFooterPx } from '../../utils/flowChatScrollLayout';
import { tailSpacerPxForViewport } from './flowChatTailFollow';
import { ONE_SHOT_NAVIGATION_HOLD_MS } from './flowChatViewportOwnership';
import { VirtualMessageList, type VirtualMessageListRef } from './VirtualMessageList';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  activeSession: null as Record<string, unknown> | null,
  scrollItemIntoView: vi.fn(),
  scrollToOffset: vi.fn(),
  cancelAim: vi.fn(),
  setVisibleTurnInfo: vi.fn(),
  handleViewportResize: vi.fn(),
  enterFollowOutput: vi.fn(),
  exitFollowOutput: vi.fn(),
  handleUserScrollIntent: vi.fn(),
  handleFollowScroll: vi.fn(),
  /**
   * The two answers to "does follow own the viewport", which the real hook
   * gives at two different moments: `isFollowingOutput` is a render value, and
   * `followsNow` is the ref a gesture clears synchronously before it asks.
   * Keeping both here is what lets a test put them out of step, which is the
   * state the paging refusal used to read from the wrong side of.
   */
  isFollowingOutput: false,
  followsNow: false,
  scheduleFollowToLatest: vi.fn(),
  startAtTailOnMount: true,
  virtualizerStartsAtTail: false,
  reconcileOpeningMeasurement: null as null | (() => boolean),
  revealNewTurnTail: null as null | ((turnId: string) => boolean),
  /**
   * The register the list built, reached through the hook it hands it to.
   *
   * Taking the viewport is what the follow hook does on entry, and the tests
   * below need the list to face a register in that state — a displacement is
   * refused by whoever holds a target, and that refusal is a contract with the
   * holder rather than a dead end.
   */
  viewportOwner: null as null | { claim: (owner: string) => boolean },
  /** False stands in for a Turn the virtualizer can place but the DOM cannot. */
  renderItemMetadata: true,
}));

/** Input-stack footer produced by the mocked 140px composer. */
const BOTTOM_INSET = computeFlowChatInputStackFooterPx(140);

/**
 * jsdom has no layout engine, so both halves of the navigation clamp have to be
 * supplied: the scroller's own box, and where a user message sits inside it.
 */
function fakeLayout(options: {
  clientWidth?: number;
  clientHeight: number;
  /** A function where the range has to grow, as it does when history arrives. */
  scrollHeight: number | (() => number);
  turnTopFromScrollerTop: number;
}) {
  const readScrollHeight = typeof options.scrollHeight === 'function'
    ? options.scrollHeight
    : () => options.scrollHeight as number;
  const originals = (['clientWidth', 'clientHeight', 'scrollHeight'] as const).map(name => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => {
        if (name === 'clientWidth') return options.clientWidth ?? 1000;
        return name === 'clientHeight' ? options.clientHeight : readScrollHeight();
      },
    });
    return [name, descriptor] as const;
  });
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function getRect(this: HTMLElement) {
    const top = this.classList.contains('virtual-item-wrapper')
      ? options.turnTopFromScrollerTop
      : 0;
    return { ...new DOMRect(0, top, 0, 40), top, bottom: top + 40 } as DOMRect;
  };

  return () => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    originals.forEach(([name, descriptor]) => {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    });
  };
}

/** Range rectangles supply navigation geometry only; jsdom cannot verify appearance. */
function searchRangeLayout(readRect: (range: Range) => DOMRect) {
  const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) { return [readRect(this)]; },
  });
  return () => {
    if (original) Object.defineProperty(Range.prototype, 'getClientRects', original);
    else delete (Range.prototype as unknown as Record<string, unknown>).getClientRects;
  };
}

/*
 * The virtualizer is mocked at FlowChat's own seam rather than at the library.
 * These tests are about which scroll the list decides to ask for, and the seam
 * is where that decision is expressed; the library's own behaviour belongs to
 * the library. Every item is rendered, which is what a list shorter than the
 * viewport would do anyway.
 */
vi.mock('./useFlowChatVirtualizer', async () => {
  // The visible range is real geometry, and the paging rule reads it. Faking it
  // would leave the rule tested against an answer no viewport can produce.
  const actual = await vi.importActual<typeof import('./useFlowChatVirtualizer')>(
    './useFlowChatVirtualizer',
  );
  return {
    ...actual,
    useFlowChatVirtualizer: (options: {
      items: Array<Record<string, unknown>>;
      getItemKey: (item: Record<string, unknown>) => string;
      scrollerRef: { current: HTMLElement | null };
      startAtTailOnMount?: boolean;
      reconcileOpeningMeasurement?: () => boolean;
    }) => {
      mocks.virtualizerStartsAtTail = options.startAtTailOnMount === true;
      mocks.reconcileOpeningMeasurement = options.reconcileOpeningMeasurement ?? null;
      const rows = options.items.map((item, index) => ({
        index,
        key: options.getItemKey(item),
        startPx: index * 40,
        endPx: index * 40 + 40,
      }));
      return {
        rows,
        paddingTopPx: 0,
        paddingBottomPx: 0,
        measureRowElement: () => {},
        getItemBounds: (index: number) => (
          index >= 0 && index < rows.length
            ? { startPx: index * 40, endPx: index * 40 + 40 }
            : null
        ),
        // The real one flushes the DOM's heights into the library's cache;
        // these rows are placed by arithmetic, so there is nothing to flush.
        measureRenderedItems: () => {},
        getVisibleItemRange: () => {
          const scroller = options.scrollerRef.current;
          return scroller
            ? actual.visibleRowRange(rows, scroller.scrollTop, scroller.clientHeight)
            : null;
        },
        scrollItemIntoView: mocks.scrollItemIntoView,
        scrollToOffset: mocks.scrollToOffset,
        cancelAim: mocks.cancelAim,
      };
    },
  };
});

vi.mock('../../store/modernFlowChatStore', () => {
  const useModernFlowChatStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ visibleTurnInfo: null }),
    { getState: () => ({ setVisibleTurnInfo: mocks.setVisibleTurnInfo }) },
  );
  return {
    useVirtualItems: () => mocks.items,
    useActiveSession: () => mocks.activeSession,
    useModernFlowChatStore,
    useModernFlowChatStoreApi: () => useModernFlowChatStore,
  };
});

vi.mock('../../hooks/useActiveSessionState', () => ({
  useActiveSessionState: () => ({ isProcessing: false }),
}));

vi.mock('../../store/chatInputStateStore', () => ({
  useChatInputState: (selector: (state: Record<string, unknown>) => unknown) => selector({
    inputHeight: 140,
  }),
}));

vi.mock('./useFlowChatFollowOutput', () => ({
  useFlowChatFollowOutput: (options: {
    viewportOwner: { claim: (owner: string) => boolean };
    revealNewTurnTail: (turnId: string) => boolean;
    startAtTailOnMount?: boolean;
  }) => {
    mocks.viewportOwner = options.viewportOwner;
    mocks.revealNewTurnTail = options.revealNewTurnTail;
    mocks.startAtTailOnMount = options.startAtTailOnMount ?? true;
    return {
      isFollowingOutput: mocks.isFollowingOutput,
      enterFollowOutput: mocks.enterFollowOutput,
      exitFollowOutput: mocks.exitFollowOutput,
      scheduleFollowToLatest: mocks.scheduleFollowToLatest,
      isFollowingOutputNow: () => mocks.followsNow,
      // Nothing streams here, so the frame loop is never correcting: the band is
      // judged on the viewport itself, exactly as it is for a resting transcript.
      isFollowCorrectingViewport: () => false,
      handleUserScrollIntent: () => {
        // What the real one does first: release, synchronously.
        mocks.followsNow = false;
        mocks.handleUserScrollIntent();
      },
      handleTurnsRolledBack: vi.fn(),
      handleScroll: mocks.handleFollowScroll,
      handleViewportResize: mocks.handleViewportResize,
      // Follow owns nothing here, which is what the real hook returns when
      // `isFollowingOutput` is false.
      getFollowTargetScrollTop: () => null,
    };
  },
}));

vi.mock('./VirtualItemRenderer', () => ({
  VirtualItemRenderer: ({ item, index, measureRef }: {
    item: any;
    index: number;
    measureRef?: (element: HTMLElement | null) => void;
  }) => (
    <div
      ref={measureRef}
      className="virtual-item-wrapper"
      data-item-type={mocks.renderItemMetadata ? item.type : undefined}
      data-turn-id={item.turnId}
      data-virtual-item-key={`${item.type}:${item.turnId}:${item.data?.id ?? item.data?.groupId ?? ''}`}
      data-virtual-index={index}
    >
      {item.data?.content ?? item.turnId}
    </div>
  ),
}));

vi.mock('../../hooks/useScrollToTurnHeader', () => ({
  useScrollToTurnHeader: () => ({ shouldShowButton: false, handleClick: vi.fn() }),
}));

vi.mock('./RuntimeStatusSlot', () => ({ RuntimeStatusSlot: () => <div data-runtime-status /> }));
vi.mock('../ScrollToLatestBar', () => ({ ScrollToLatestBar: () => null }));
vi.mock('../ScrollToTurnHeaderButton', () => ({ ScrollToTurnHeaderButton: () => null }));

function userMessage(turnId: string, id: string, content: string) {
  return {
    type: 'user-message',
    turnId,
    data: { id, content },
  };
}

function modelRound(turnId: string, id: string, content: string) {
  return {
    type: 'model-round',
    turnId,
    data: { id, content, items: [] },
    isLastRound: true,
    isTurnComplete: true,
  };
}

describe('VirtualMessageList natural scroll contract', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrames: Map<number, FrameRequestCallback>;
  let nextAnimationFrameId: number;
  let resizeObservers: TestResizeObserver[];

  class TestResizeObserver {
    readonly targets = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
      resizeObservers.push(this);
    }

    observe(target: Element) {
      this.targets.add(target);
    }

    unobserve(target: Element) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
    }

    notify() {
      this.callback([], this as unknown as ResizeObserver);
    }
  }

  /**
   * Run the opening reveal to its end, which is what mounting a transcript
   * really costs.
   *
   * The reveal holds the transcript hidden while it is placed, and the paging
   * rule refuses a boundary derived from a viewport still being placed — so a
   * test that asserts what the list asks for on mount has to get past it, the
   * same way half a second of animation frames does in the app. Frames are a
   * manual queue rather than jsdom's timer-backed ones so that draining them is
   * a step in the test rather than a wait.
   */
  async function settleOpenReveal() {
    // The reveal's own cap is 40 frames; a few more cover the commits its
    // settling schedules.
    for (let generation = 0; generation < 48; generation += 1) {
      const pending = [...animationFrames.values()];
      animationFrames.clear();
      if (pending.length === 0) return;
      await act(async () => {
        pending.forEach(frame => frame(16));
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    animationFrames = new Map();
    nextAnimationFrameId = 0;
    resizeObservers = [];
    mocks.items = [
      userMessage('turn-1', 'message-1', 'First'),
      userMessage('turn-2', 'message-2', 'Second'),
    ];
    mocks.activeSession = {
      sessionId: 'session-1',
      dialogTurns: [],
    };
    mocks.isFollowingOutput = false;
    mocks.followsNow = false;
    mocks.scrollItemIntoView.mockReset();
    mocks.scrollToOffset.mockReset();
    mocks.cancelAim.mockReset();
    mocks.handleViewportResize.mockReset();
    mocks.enterFollowOutput.mockReset();
    mocks.exitFollowOutput.mockReset();
    mocks.handleUserScrollIntent.mockReset();
    mocks.handleFollowScroll.mockReset();
    mocks.scheduleFollowToLatest.mockReset();
    mocks.startAtTailOnMount = true;
    mocks.revealNewTurnTail = null;
    mocks.viewportOwner = null;
    mocks.setVisibleTurnInfo.mockReset();
    mocks.renderItemMetadata = true;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextAnimationFrameId += 1;
      animationFrames.set(nextAnimationFrameId, callback);
      return nextAnimationFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      animationFrames.delete(id);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('reconciles opening measurements only while follow owns the active viewport', () => {
    act(() => root.render(<VirtualMessageList />));
    expect(mocks.reconcileOpeningMeasurement?.()).toBe(false);
    mocks.followsNow = true;
    mocks.viewportOwner!.claim('follow-output');
    mocks.scheduleFollowToLatest.mockClear();
    expect(mocks.reconcileOpeningMeasurement?.()).toBe(true);
    expect(mocks.scheduleFollowToLatest).toHaveBeenCalledTimes(1);
    mocks.viewportOwner!.claim('user-gesture');
    expect(mocks.reconcileOpeningMeasurement?.()).toBe(false);
    expect(mocks.scheduleFollowToLatest).toHaveBeenCalledTimes(1);
    act(() => root.render(<VirtualMessageList isViewportActive={false} />));
    expect(mocks.reconcileOpeningMeasurement?.()).toBe(false);
  });

  it('isolates the opening transcript at its boundary until reveal', async () => {
    act(() => root.render(<VirtualMessageList />));
    expect(mocks.virtualizerStartsAtTail).toBe(true);
    const list = container.querySelector<HTMLElement>('[data-testid="flowchat-message-list"]')!;
    expect(list.getAttribute('data-open-viewport-settled')).toBe('false');
    expect(list.hasAttribute('inert')).toBe(false);
    expect(container.querySelectorAll('[data-flowchat-opening-guard]')).toHaveLength(2);
    expect(list.querySelector('.virtual-message-list__opening-shield')).not.toBeNull();
    expect(list.getAttribute('aria-hidden')).toBe('true');

    await settleOpenReveal();

    expect(list.getAttribute('data-open-viewport-settled')).toBe('true');
    expect(list.hasAttribute('inert')).toBe(false);
    expect(list.hasAttribute('aria-hidden')).toBe(false);
    expect(container.querySelectorAll('[data-flowchat-opening-guard][tabindex="-1"]')).toHaveLength(2);
    expect(list.querySelector('.virtual-message-list__opening-shield')).toBeNull();
    mocks.followsNow = true;
    mocks.viewportOwner!.claim('follow-output');
    expect(mocks.reconcileOpeningMeasurement?.()).toBe(false);
  });

  it('renders only the current input layout inset in the Footer', () => {
    act(() => root.render(<VirtualMessageList />));
    const footer = container.querySelector<HTMLElement>('.message-list-footer');
    expect(footer?.style.height).toBe(`${BOTTOM_INSET}px`);
    expect(footer?.style.minHeight).toBe(`${BOTTOM_INSET}px`);
  });

  it('reserves a tail spacer from the viewport and input-stack inset', () => {
    // The session opens on the end of *real content*, which is above this
    // reservation. Nothing aligns to the last item any more: the end of the
    // scroll range is reserved blank, and opening there is opening on nothing.
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 600,
    });

    try {
      act(() => root.render(<VirtualMessageList />));

      const expectedSpacerPx = tailSpacerPxForViewport(600, BOTTOM_INSET);
      expect(expectedSpacerPx).toBeLessThan(600);
      const spacer = container.querySelector<HTMLElement>('.message-list-tail-spacer');
      expect(spacer?.style.height).toBe(`${expectedSpacerPx}px`);
      // The input-stack footer stays a separate reservation. It feeds the
      // spacer's size, but the two are never folded into one number.
      expect(container.querySelector<HTMLElement>('.message-list-footer')?.style.height)
        .toBe(`${BOTTOM_INSET}px`);
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
      }
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      }
    }
  });

  it('reveals a rendered new Turn at the physical bottom through the viewport register', () => {
    const restoreLayout = fakeLayout({
      clientHeight: 600,
      scrollHeight: 1400,
      turnTopFromScrollerTop: 500,
    });
    try {
      act(() => root.render(<VirtualMessageList />));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.scrollTop = 100;

      expect(mocks.revealNewTurnTail?.('turn-2')).toBe(true);
      expect(scroller.scrollTop).toBe(800);
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    } finally {
      restoreLayout();
    }
  });

  it('suspends viewport writers until the frame after a minimized zero-size sample resumes', () => {
    const layout = {
      clientWidth: 1000,
      clientHeight: 600,
      scrollHeight: 3000,
      turnTopFromScrollerTop: 500,
    };
    const restoreLayout = fakeLayout(layout);
    try {
      act(() => root.render(<VirtualMessageList />));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const observer = resizeObservers.find(candidate => candidate.targets.has(scroller));
      expect(observer).toBeDefined();
      if (!observer) throw new Error('Expected a ResizeObserver for the FlowChat scroller');
      const spacer = container.querySelector<HTMLElement>('.message-list-tail-spacer')!;
      const spacerBeforeMinimize = spacer.style.height;

      mocks.handleViewportResize.mockClear();
      mocks.scheduleFollowToLatest.mockClear();
      mocks.setVisibleTurnInfo.mockClear();
      animationFrames.clear();

      layout.clientWidth = 390;
      layout.clientHeight = 0;
      act(() => observer.notify());

      expect(mocks.handleViewportResize).not.toHaveBeenCalled();
      expect(mocks.scheduleFollowToLatest).not.toHaveBeenCalled();
      expect(mocks.setVisibleTurnInfo).not.toHaveBeenCalled();
      expect(spacer.style.height).toBe(spacerBeforeMinimize);
      expect(animationFrames.size).toBe(0);

      act(() => scroller.dispatchEvent(new Event('scroll')));
      expect(mocks.handleFollowScroll).not.toHaveBeenCalled();

      layout.clientWidth = 1000;
      layout.clientHeight = 700;
      act(() => observer.notify());

      // The first positive rectangle is still part of host recovery. Treating
      // it as a normal resize replays zero-height scroll events as a tail
      // follow or measurement correction before the old reading position can
      // be restored.
      expect(mocks.handleViewportResize).not.toHaveBeenCalled();
      expect(mocks.scheduleFollowToLatest).not.toHaveBeenCalled();

      const [resume] = [...animationFrames.values()];
      expect(resume).toBeDefined();
      if (!resume) throw new Error('Expected a deferred viewport recovery frame');
      act(() => resume(16));

      expect(mocks.handleViewportResize).not.toHaveBeenCalled();
      expect(mocks.scheduleFollowToLatest).toHaveBeenCalledTimes(1);
    } finally {
      restoreLayout();
    }
  });

  it('keeps the viewport fixed when advancing between two search hits on the same readable line', async () => {
    mocks.items = [userMessage('turn-1', 'message-1', 'needle and needle')];
    const restoreLayout = fakeLayout({ clientHeight: 600, scrollHeight: 2400, turnTopFromScrollerTop: 100 });
    const restoreRanges = searchRangeLayout(range => new DOMRect(range.startOffset * 8, 180, 48, 20));
    try {
      const listRef = React.createRef<VirtualMessageListRef>();
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.style.setProperty('--openbitfun-space-12', '48px');
      scroller.scrollTop = 400;
      mocks.scrollItemIntoView.mockClear();
      mocks.scrollToOffset.mockClear();
      mocks.cancelAim.mockClear();

      for (const occurrenceIndex of [0, 1, 0]) {
        act(() => listRef.current?.scrollToSearchMatch({ virtualItemIndex: 0, query: 'needle', occurrenceIndex }));
        await settleOpenReveal();
        expect(scroller.scrollTop).toBe(400);
      }
      expect(mocks.scrollItemIntoView).not.toHaveBeenCalled();
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
      expect(mocks.cancelAim).toHaveBeenCalledTimes(3);
    } finally {
      restoreRanges();
      restoreLayout();
    }
  });

  it.each([30, 405, 510, 900])('directly positions a mounted search hit at %ipx inside the readable viewport', async (hitTop) => {
    mocks.items = [userMessage('turn-1', 'message-1', 'needle')];
    const restoreLayout = fakeLayout({ clientHeight: 600, scrollHeight: 2400, turnTopFromScrollerTop: 100 });
    const restoreRanges = searchRangeLayout(() => new DOMRect(100, hitTop, 48, 20));
    try {
      const listRef = React.createRef<VirtualMessageListRef>();
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.style.setProperty('--openbitfun-space-12', '48px');
      scroller.scrollTop = 400;
      mocks.scrollItemIntoView.mockClear();
      mocks.scrollToOffset.mockClear();

      act(() => listRef.current?.scrollToSearchMatch({ virtualItemIndex: 0, query: 'needle' }));
      // One synchronous text placement, without first centering the entire row.
      expect(mocks.scrollItemIntoView).not.toHaveBeenCalled();
      expect(mocks.scrollToOffset).toHaveBeenCalledTimes(1);
      expect(mocks.scrollToOffset).toHaveBeenCalledWith(400 + hitTop + 10 - 218, {
        owner: 'one-shot-navigation',
        holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
      });
      await settleOpenReveal();
      expect(mocks.scrollToOffset).toHaveBeenCalledTimes(1);
    } finally {
      restoreRanges();
      restoreLayout();
    }
  });

  it('materializes an unmounted search row once and ends its item aim when the hit is already readable', async () => {
    mocks.items = [userMessage('turn-1', 'message-1', 'needle')];
    const restoreLayout = fakeLayout({ clientHeight: 600, scrollHeight: 2400, turnTopFromScrollerTop: 100 });
    const restoreRanges = searchRangeLayout(() => new DOMRect(100, 180, 48, 20));
    try {
      const listRef = React.createRef<VirtualMessageListRef>();
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      const wrapper = container.querySelector<HTMLElement>('.virtual-item-wrapper')!;
      wrapper.dataset.virtualIndex = '-1';
      mocks.scrollItemIntoView.mockClear();
      mocks.scrollToOffset.mockClear();
      mocks.cancelAim.mockClear();

      act(() => listRef.current?.scrollToSearchMatch({ virtualItemIndex: 0, query: 'needle' }));
      expect(mocks.scrollItemIntoView).toHaveBeenCalledTimes(1);
      wrapper.dataset.virtualIndex = '0';
      await settleOpenReveal();
      expect(mocks.scrollItemIntoView).toHaveBeenCalledTimes(1);
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
      // One cancellation replaces the previous intent; the other ends materialization.
      expect(mocks.cancelAim).toHaveBeenCalledTimes(2);
    } finally {
      restoreRanges();
      restoreLayout();
    }
  });

  it.each(['clear', 'gesture'] as const)('abandons pending search placement after %s', async (cancel) => {
    mocks.items = [userMessage('turn-1', 'message-1', 'needle')];
    const restoreLayout = fakeLayout({ clientHeight: 600, scrollHeight: 2400, turnTopFromScrollerTop: 100 });
    const restoreRanges = searchRangeLayout(() => new DOMRect(100, 900, 48, 20));
    try {
      const listRef = React.createRef<VirtualMessageListRef>();
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      const wrapper = container.querySelector<HTMLElement>('.virtual-item-wrapper')!;
      wrapper.dataset.virtualIndex = '-1';
      mocks.scrollToOffset.mockClear();
      act(() => listRef.current?.scrollToSearchMatch({ virtualItemIndex: 0, query: 'needle' }));
      act(() => {
        if (cancel === 'clear') listRef.current?.clearSearchMatch();
        else container.querySelector('[data-flowchat-scroller]')!
          .dispatchEvent(new Event('wheel'));
      });
      wrapper.dataset.virtualIndex = '0';
      await settleOpenReveal();
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    } finally {
      restoreRanges();
      restoreLayout();
    }
  });

  it('navigates a Turn with best-effort start alignment and no range reservation', () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    act(() => root.render(<VirtualMessageList ref={listRef} />));
    let accepted = false;
    act(() => {
      accepted = listRef.current?.navigateToTurn('turn-2', { behavior: 'auto' }) ?? false;
    });
    expect(accepted).toBe(true);
    expect(mocks.exitFollowOutput).toHaveBeenCalledWith('scroll-to-turn');
    // The breathing gap above a top-aligned Turn is the virtualizer's
    // `scrollPaddingStart`, so an aim re-taken while items measure keeps it.
    expect(mocks.scrollItemIntoView).toHaveBeenCalledWith(1, {
      align: 'start',
      behavior: 'auto',
      // The aim carries its owner, so the re-aims it produces are still the
      // navigation's and are refused for anything that outranks it.
      owner: 'one-shot-navigation',
      holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
    });
    expect(container.querySelector('.message-list-footer')?.getAttribute('style')).toContain(`${BOTTOM_INSET}px`);
  });

  it('top-aligns a Turn that still has a transcript below it', () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    // Content end at 3000 - 392 - 600 = 2008, well below the Turn's top at 492.
    const restoreLayout = fakeLayout({
      clientHeight: 600,
      scrollHeight: 3000,
      turnTopFromScrollerTop: 500,
    });
    try {
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      act(() => { listRef.current?.navigateToTurn('turn-2', { behavior: 'smooth' }); });

      expect(mocks.scrollItemIntoView).toHaveBeenCalledTimes(1);
      expect(mocks.scrollItemIntoView).toHaveBeenCalledWith(1, {
        align: 'start',
        // A resolvable Turn is clamped before anything moves, so the requested
        // animation survives.
        behavior: 'smooth',
        owner: 'one-shot-navigation',
        holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
      });
    } finally {
      restoreLayout();
    }
  });

  it('stops a short tail Turn at the content end rather than in the blank', () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    // Content end at 1000 - 392 - 600 = 8; top-aligning would mean 492, which
    // is a screen of reserved blank nothing is going to fill.
    const restoreLayout = fakeLayout({
      clientHeight: 600,
      scrollHeight: 1000,
      turnTopFromScrollerTop: 500,
    });
    try {
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      act(() => { listRef.current?.navigateToTurn('turn-2', { behavior: 'smooth' }); });

      // Aimed at the end of real content, read off live geometry — not at the
      // last item, whose end is the bottom of the reserved blank.
      expect(mocks.scrollItemIntoView).not.toHaveBeenCalled();
      expect(mocks.scrollToOffset).toHaveBeenCalledTimes(1);
      expect(mocks.scrollToOffset).toHaveBeenCalledWith(
        1000 - tailSpacerPxForViewport(600, BOTTOM_INSET) - 600,
        {
          behavior: 'smooth',
          owner: 'one-shot-navigation',
          // The clamp is still the navigation, so it states the same window.
          // Without one it would hold the viewport for the rest of the session.
          holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
        },
      );
    } finally {
      restoreLayout();
    }
  });

  it('reads an unrendered Turn back from the virtualizer, and corrects through it', () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    const restoreLayout = fakeLayout({
      clientHeight: 600,
      scrollHeight: 1000,
      turnTopFromScrollerTop: 500,
    });
    try {
      mocks.renderItemMetadata = false;
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 0,
      });
      // Only the virtualizer knows where the Turn is; it lands the viewport in
      // the reserved blank.
      mocks.scrollItemIntoView.mockImplementation(() => { scroller.scrollTop = 900; });

      act(() => { listRef.current?.navigateToTurn('turn-2', { behavior: 'smooth' }); });

      // Placed instantly, because an animation would not have arrived yet and
      // there would be nothing to read back.
      expect(mocks.scrollItemIntoView).toHaveBeenCalledTimes(1);
      expect(mocks.scrollItemIntoView).toHaveBeenCalledWith(1, {
        align: 'start',
        owner: 'one-shot-navigation',
        holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
      });
      // Corrected through the virtualizer, not the scroller: a direct write
      // would leave the first call's re-aim pending, and it aims at the top.
      expect(mocks.scrollToOffset).toHaveBeenCalledWith(
        1000 - tailSpacerPxForViewport(600, BOTTOM_INSET) - 600,
        {
          behavior: 'auto',
          owner: 'one-shot-navigation',
          holdForMs: ONE_SHOT_NAVIGATION_HOLD_MS,
        },
      );
    } finally {
      restoreLayout();
    }
  });

  describe('the current Turn after navigation', () => {
    let listRef: React.RefObject<VirtualMessageListRef>;
    let scroller: HTMLElement;
    let restoreLayout: () => void;

    beforeEach(async () => {
      mocks.items = Array.from({ length: 4 }, (_, index) => (
        userMessage(`turn-${index + 1}`, `message-${index + 1}`, `Message ${index + 1}`)
      ));
      restoreLayout = fakeLayout({
        clientHeight: 600,
        scrollHeight: 1000,
        turnTopFromScrollerTop: 500,
      });
      HTMLElement.prototype.getBoundingClientRect = function getRect() {
        const isItem = this.classList.contains('virtual-item-wrapper');
        // The previous Turn's last 5px remain visible above the target. Short
        // tail Turns all share the same content-end-clamped scroll position.
        const top = isItem ? Number(this.dataset.virtualIndex) * 80 - 35 : 0;
        return new DOMRect(0, top, 1000, isItem ? 40 : 600);
      };
      listRef = React.createRef<VirtualMessageListRef>();
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.scrollTop = 1000 - tailSpacerPxForViewport(600, BOTTOM_INSET) - 600;
      mocks.setVisibleTurnInfo.mockClear();
    });

    afterEach(() => restoreLayout());

    async function navigate(turnId: string) {
      act(() => { listRef.current?.navigateToTurn(turnId, { behavior: 'auto' }); });
      await settleOpenReveal();
    }

    function expectCurrent(turnId: string) {
      expect(mocks.setVisibleTurnInfo).toHaveBeenLastCalledWith(expect.objectContaining({
        turnId,
        turnIndex: Number(turnId.split('-')[1]),
        visibleTurnIds: ['turn-1', 'turn-2', 'turn-3', 'turn-4'],
      }));
    }

    it('publishes each clicked Turn even when the clamp produces no scroll event', async () => {
      const restingOffset = scroller.scrollTop;
      await navigate('turn-4');
      expectCurrent('turn-4');
      await navigate('turn-2');
      expectCurrent('turn-2');
      expect(scroller.scrollTop).toBe(restingOffset);

      // Placement and measurement scroll events must not replace the target
      // with the earlier Turn whose tail happens to intersect the viewport.
      act(() => scroller.dispatchEvent(new Event('scroll')));
      await settleOpenReveal();
      expectCurrent('turn-2');
    });

    it('does not replace a valid target with a rejected navigation', async () => {
      await navigate('turn-4');
      act(() => {
        expect(listRef.current?.navigateToTurn('missing-turn')).toBe(false);
        scroller.dispatchEvent(new Event('scroll'));
      });
      await settleOpenReveal();
      expectCurrent('turn-4');
    });

    it.each(['wheel', 'touchmove', 'keydown', 'scrollbar'])(
      'returns to viewport-derived current Turn after a %s gesture',
      async gesture => {
        await navigate('turn-4');
        expectCurrent('turn-4');
        act(() => {
          if (gesture === 'scrollbar') {
            scroller.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1005, bubbles: true }));
            scroller.dispatchEvent(new Event('scroll'));
          } else if (gesture === 'keydown') {
            scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
          } else {
            scroller.dispatchEvent(new Event(gesture, { bubbles: true }));
          }
        });
        await settleOpenReveal();
        expectCurrent('turn-1');
      },
    );

    it('replaces the target when navigating to a different item', async () => {
      await navigate('turn-4');
      act(() => { listRef.current?.scrollToIndex(1); });
      await settleOpenReveal();
      expectCurrent('turn-2');
    });

    it('waits for a distant navigation target to become visible', async () => {
      const target = container.querySelector<HTMLElement>('[data-turn-id="turn-4"]')!;
      const rect = vi.spyOn(target, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 800, 1000, 40));
      await navigate('turn-4');
      expect(mocks.setVisibleTurnInfo).toHaveBeenLastCalledWith(expect.objectContaining({
        turnId: 'turn-1',
        visibleTurnIds: ['turn-1', 'turn-2', 'turn-3'],
      }));
      rect.mockRestore();
      act(() => scroller.dispatchEvent(new Event('scroll')));
      await settleOpenReveal();
      expectCurrent('turn-4');
    });

    it('selects a prepared history target once its Turn enters the presentation', async () => {
      await navigate('turn-4');
      act(() => {
        expect(listRef.current?.prepareTurnNavigation('turn-5')).toBe('pending');
      });
      mocks.items = [...mocks.items, userMessage('turn-5', 'message-5', 'Message 5')];
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      expect(mocks.setVisibleTurnInfo).toHaveBeenLastCalledWith(expect.objectContaining({
        turnId: 'turn-5',
        turnIndex: 5,
        visibleTurnIds: ['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5'],
      }));
    });

    it('clears the target on jump to latest even without a scroll event', async () => {
      await navigate('turn-4');
      expectCurrent('turn-4');
      act(() => { listRef.current?.scrollToLatestEndPosition(); });
      await settleOpenReveal();
      expectCurrent('turn-1');
    });

    it('clears the target when follow-output takes over', async () => {
      await navigate('turn-4');
      expectCurrent('turn-4');
      mocks.followsNow = true;
      act(() => scroller.dispatchEvent(new Event('scroll')));
      await settleOpenReveal();
      expectCurrent('turn-1');
      mocks.followsNow = false;
      act(() => scroller.dispatchEvent(new Event('scroll')));
      await settleOpenReveal();
      expectCurrent('turn-1');
    });

    it('does not carry a target into another session with the same Turn IDs', async () => {
      await navigate('turn-4');
      expectCurrent('turn-4');
      mocks.activeSession = { sessionId: 'session-2', dialogTurns: [] };
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      await settleOpenReveal();
      expectCurrent('turn-1');
    });
  });

  describe('scrollbar drags release the viewport', () => {
    // Content box ends at 0 + 1384; the gutter runs from there to 1394.
    const CONTENT_BOX_WIDTH = 1384;

    function pressAt(clientX: number) {
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      Object.defineProperty(scroller, 'clientWidth', {
        configurable: true,
        value: CONTENT_BOX_WIDTH,
      });
      act(() => {
        // jsdom has no PointerEvent; only `clientX` is read.
        scroller.dispatchEvent(new MouseEvent('pointerdown', { clientX, bubbles: true }));
        scroller.dispatchEvent(new Event('scroll'));
      });
    }

    it('treats a scroll under a scrollbar press as intent', async () => {
      act(() => root.render(<VirtualMessageList />));
      await settleOpenReveal();
      pressAt(CONTENT_BOX_WIDTH + 6);
      expect(mocks.handleUserScrollIntent).toHaveBeenCalled();
    });

    it('leaves a scroll under a press on the transcript alone', async () => {
      // Layout growth and virtualizer remeasurement emit scroll events too, so
      // the press is what qualifies one — not the event itself.
      act(() => root.render(<VirtualMessageList />));
      await settleOpenReveal();
      pressAt(CONTENT_BOX_WIDTH - 200);
      expect(mocks.handleUserScrollIntent).not.toHaveBeenCalled();
    });

    it('gives up an aim still in flight, which the claim alone cannot reach', async () => {
      /*
       * The register refuses the re-aim's writes only while the gesture's hold
       * is live — 200ms after the last notch, against a five-second re-aim —
       * and the library never learns it was refused. Measured: a navigation
       * placed at 5358, the reader took over 6ms later, and the re-aim asked
       * for 7784 12ms after that.
       */
      act(() => root.render(<VirtualMessageList />));
      await settleOpenReveal();
      pressAt(CONTENT_BOX_WIDTH + 6);
      expect(mocks.cancelAim).toHaveBeenCalled();
    });

    it('disarms on release, so a later scroll is not intent', async () => {
      act(() => root.render(<VirtualMessageList />));
      await settleOpenReveal();
      pressAt(CONTENT_BOX_WIDTH + 6);
      mocks.handleUserScrollIntent.mockClear();

      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup'));
        scroller.dispatchEvent(new Event('scroll'));
      });

      expect(mocks.handleUserScrollIntent).not.toHaveBeenCalled();
    });
  });

  describe('history arriving above the viewport', () => {
    /**
     * A scroller whose range grows with the transcript, which is what makes the
     * compensation measurable at all: the reserved height and the real height
     * disagree while the arrived items are still estimates.
     */
    function withGrowingRange(
      options: { scrollHeightPx: number; growthPx: number; scrollTopPx?: number },
      run: (scroller: HTMLElement) => void,
    ) {
      let scrollHeightPx = options.scrollHeightPx;
      const restoreLayout = fakeLayout({
        clientHeight: 600,
        scrollHeight: () => scrollHeightPx,
        turnTopFromScrollerTop: 500,
      });
      try {
        act(() => root.render(<VirtualMessageList />));
        const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
        scroller.scrollTop = options.scrollTopPx ?? 500;
        scrollHeightPx += options.growthPx;
        run(scroller);
      } finally {
        restoreLayout();
      }
    }

    function prependOlderTurns(count: number) {
      mocks.items = [
        ...Array.from({ length: count }, (_unused, index) => (
          userMessage(`turn-old-${index}`, `message-old-${index}`, 'Older')
        )),
        ...mocks.items,
      ];
      act(() => root.render(<VirtualMessageList />));
    }

    it('moves the viewport by the height that was prepended', () => {
      // Three 40px items arrived above, so the reader's content is 120px lower
      // and the viewport follows it. Anything less leaves them looking at
      // history they never asked to be shown.
      withGrowingRange({ scrollHeightPx: 3000, growthPx: 120 }, scroller => {
        prependOlderTurns(3);
        expect(scroller.scrollTop).toBe(620);
      });
    });

    it('moves it even while the reader is scrolling, because that is when history arrives', () => {
      /*
       * Paging up happens only while the reader scrolls up into the boundary,
       * so a gesture that could refuse this would refuse all of it. Measured
       * before this was a displacement rather than a position: 2494px arrived,
       * `scrollTop` held at 40, the transcript jumped back thirteen Turns, and
       * the boundary never re-armed because the reader was still at the head.
       */
      withGrowingRange({ scrollHeightPx: 3000, growthPx: 80 }, scroller => {
        act(() => { scroller.dispatchEvent(new Event('wheel')); });
        prependOlderTurns(2);
        expect(scroller.scrollTop).toBe(580);
      });
    });

    it('trusts the range the transcript actually gained over the height reserved for it', () => {
      /*
       * The arrived items are estimates in the virtualizer's cache while the
       * DOM already holds their real heights, and the cache is the one that
       * over-states. Measured twice in one session: 2174px reserved against
       * 670px of real growth, then 2494px against 949px. Compensating by the
       * reserved amount walks the reader down the transcript a page at a time.
       */
      withGrowingRange({ scrollHeightPx: 3000, growthPx: 50 }, scroller => {
        prependOlderTurns(3);
        expect(scroller.scrollTop).toBe(550);
      });
    });

    it('never compensates past the end of real content', () => {
      /*
       * Content arriving above the reader cannot push them past the end of the
       * transcript, so needing more than the range can absorb is proof the
       * amount is wrong. Overshooting leaves them inside the reserved blank,
       * where the reserved blank begins — which, since
       * paging happens only while scrolling up, it then does every time.
       */
       const contentEndPx = Math.min(
         100,
         1000 - tailSpacerPxForViewport(600, BOTTOM_INSET) - 600,
       );
      withGrowingRange({ scrollHeightPx: 900, growthPx: 100, scrollTopPx: 0 }, scroller => {
        prependOlderTurns(3);
        expect(scroller.scrollTop).toBe(contentEndPx);
      });
    });

    it('leaves the viewport alone when the transcript grows at the end', () => {
      act(() => root.render(<VirtualMessageList />));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.scrollTop = 500;

      mocks.items = [...mocks.items, userMessage('turn-3', 'message-3', 'Newer')];
      act(() => root.render(<VirtualMessageList />));

      expect(scroller.scrollTop).toBe(500);
    });

    it('leaves the viewport alone when the head is trimmed', () => {
      act(() => root.render(<VirtualMessageList />));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.scrollTop = 500;

      // The item that was first is gone rather than moved, so there is no
      // arrived height to account for and nothing to compensate with.
      mocks.items = mocks.items.slice(1);
      act(() => root.render(<VirtualMessageList />));

      expect(scroller.scrollTop).toBe(500);
    });

    it('wakes the follow rule it left the displacement to', () => {
      /*
       * Refusing the shift is a contract with whoever holds a target, and
       * follow-output is the one holder that can be asleep: its ownership
       * deliberately outlives its frame loop so streaming can resume without
       * re-entering, and the loop stops once the transcript settles. So a page
       * landing after that is left to a writer that will never act.
       *
       * Measured: 22301px of history arrived above a viewport at offset 0 on
       * session open, the shift was refused with `heldBy: follow-output`, and
       * nothing moved again — the transcript was revealed at the top of the
       * window it had just pulled in, eight Turns above the tail.
       */
      withGrowingRange({ scrollHeightPx: 3000, growthPx: 120 }, scroller => {
        // Follow-output takes the viewport, exactly as entering does.
        mocks.viewportOwner?.claim('follow-output');
        mocks.scheduleFollowToLatest.mockReset();

        prependOlderTurns(3);

        // Refused, because the holder owns a target of its own...
        expect(scroller.scrollTop).toBe(500);
        // ...and asked to go and reach it.
        expect(mocks.scheduleFollowToLatest).toHaveBeenCalled();
      });
    });

    it('wakes nobody when it could put the reader back itself', () => {
      withGrowingRange({ scrollHeightPx: 3000, growthPx: 120 }, scroller => {
        mocks.scheduleFollowToLatest.mockReset();

        prependOlderTurns(3);

        expect(scroller.scrollTop).toBe(620);
        expect(mocks.scheduleFollowToLatest).not.toHaveBeenCalled();
      });
    });
  });

  describe('asking for older Turns', () => {
    /** Twenty 40px rows, seen through a 200px viewport. */
    const ROW_PX = 40;
    const VIEWPORT_PX = 200;

    /** A scroll, and the microtasks a boundary request resolves through. */
    async function scrollTo(scroller: HTMLElement, topPx: number) {
      await act(async () => {
        scroller.scrollTop = topPx;
        scroller.dispatchEvent(new Event('scroll'));
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    /**
     * A transcript with a page already behind it.
     *
     * The list opens at the top, so once the reveal is over it asks and disarms
     * `before`. That is the state both of these are about: one page dispatched,
     * and what has to happen for the next one. `asked` is cleared afterwards so
     * it counts only what the scrolls produced.
     */
    async function withPagedTranscript(
      run: (scroller: HTMLElement, asked: string[]) => Promise<void>,
    ) {
      mocks.items = Array.from({ length: 20 }, (_unused, index) => (
        userMessage(`turn-${index}`, `message-${index}`, 'Body')
      ));
      const restoreLayout = fakeLayout({
        clientHeight: VIEWPORT_PX,
        scrollHeight: 20 * ROW_PX,
        turnTopFromScrollerTop: 0,
      });
      const asked: string[] = [];
      try {
        await act(async () => {
          root.render(
            <VirtualMessageList
              onHistoryWindowBoundaryIntent={direction => {
                asked.push(direction);
                return 'applied';
              }}
            />,
          );
          await Promise.resolve();
          await Promise.resolve();
        });
        // Nothing while the transcript is still being placed: at offset 0 of an
        // unplaced viewport the head is trivially reached, and paging from
        // there prepends history under the placement.
        expect(asked).toEqual([]);
        await settleOpenReveal();
        expect(asked).toEqual(['before']);
        asked.length = 0;
        await run(container.querySelector<HTMLElement>('[data-flowchat-scroller]')!, asked);
      } finally {
        restoreLayout();
      }
    }

    it('asks again once the reader is off the boundary, still within the lead', async () => {
      /*
       * The latch re-arms on the reader being *off* the boundary, and the ask
       * goes out a screenful before they reach it — so those cannot be the same
       * predicate. When they were, one page landed and everything after it was
       * refused as `not-rearmed`: measured, six minutes of refusals while the
       * reader scrolled into a wall two Turns from the top of what was loaded.
       */
      await withPagedTranscript(async (scroller, asked) => {
        // Rows 3..7 are on screen, so nothing is reached; the head is 120px up,
        // which is inside the one-screen lead.
        await scrollTo(scroller, 120);
        expect(asked).toEqual(['before']);
      });
    });

    it('does not ask again while the reader is still on the head', async () => {
      // The latch's own job, unchanged: after a prepend the visible range reads
      // as the head for a commit, and that must not dispatch a second page.
      await withPagedTranscript(async (scroller, asked) => {
        await scrollTo(scroller, ROW_PX);
        expect(asked).toEqual([]);
      });
    });

    it('asks on a gesture that moves nothing, because at the top none of them do', async () => {
      /*
       * The deadlock this closes, measured on a tail window of three Turns that
       * fitted inside the viewport — so the whole scroll range was reserved
       * blank and the reader sat at offset 0 with the head already on screen.
       *
       * A wheel there changes no offset, so the scroller emits no `scroll`
       * event and the evaluation that hangs off it never runs. The log shows
       * twenty `user-gesture` claims across seven seconds with no scroll event,
       * no anchor capture and not one boundary evaluation; the only evaluations
       * in that session landed in the three milliseconds after follow-output
       * handed the viewport to follow-output, and were refused for exactly that
       * reason. Scrolling up did nothing, permanently.
       */
      mocks.items = Array.from({ length: 20 }, (_unused, index) => (
        userMessage(`turn-${index}`, `message-${index}`, 'Body')
      ));
      const restoreLayout = fakeLayout({
        clientHeight: VIEWPORT_PX,
        scrollHeight: 20 * ROW_PX,
        turnTopFromScrollerTop: 0,
      });
      const asked: string[] = [];
      try {
        await act(async () => {
          root.render(
            <VirtualMessageList
              onHistoryWindowBoundaryIntent={direction => {
                asked.push(direction);
                // Not applied, so the direction arms again rather than waiting
                // for a prepend that never comes — the state the reader is in.
                return 'not-ready';
              }}
            />,
          );
          await Promise.resolve();
          await Promise.resolve();
        });
        await settleOpenReveal();
        expect(asked).toEqual(['before']);
        asked.length = 0;

        const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
        // A wheel and nothing else: no scroll event, because there is nowhere
        // for the offset to go.
        await act(async () => {
          scroller.dispatchEvent(new Event('wheel'));
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(asked).toEqual(['before']);
      } finally {
        restoreLayout();
      }
    });

    it('asks as the reader, not as the ownership their own gesture just ended', async () => {
      /*
       * `exitFollowOutput` clears ownership synchronously, but the list mirrored
       * `isFollowingOutput` into a ref at render time — and no render happens
       * inside an event handler. So the gesture released the viewport and then
       * asked, and the ask was refused for an ownership that had already ended
       * one line earlier. In the log: `followOutput.exit` and
       * `historyPaging.refused: follow-output-owns-the-viewport` at the same
       * millisecond, three entries apart.
       */
      mocks.items = Array.from({ length: 20 }, (_unused, index) => (
        userMessage(`turn-${index}`, `message-${index}`, 'Body')
      ));
      // Follow owns the viewport as of the last render, and the gesture below
      // releases it without a render in between.
      mocks.isFollowingOutput = true;
      mocks.followsNow = true;
      const restoreLayout = fakeLayout({
        clientHeight: VIEWPORT_PX,
        scrollHeight: 20 * ROW_PX,
        turnTopFromScrollerTop: 0,
      });
      const asked: string[] = [];
      try {
        await act(async () => {
          root.render(
            <VirtualMessageList
              onHistoryWindowBoundaryIntent={direction => {
                asked.push(direction);
                return 'not-ready';
              }}
            />,
          );
          await Promise.resolve();
          await Promise.resolve();
        });
        await settleOpenReveal();
        // Refused on mount, correctly: follow owned it and nobody had gestured.
        expect(asked).toEqual([]);

        const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
        await act(async () => {
          scroller.dispatchEvent(new Event('wheel'));
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(asked).toEqual(['before']);
      } finally {
        restoreLayout();
      }
    });

    it('stops treating a boundary as exhausted once the window has moved', async () => {
      /*
       * `exhausted` is a fact about a start ordinal, not about the session.
       * Navigating to the first Turn asks `before`, the store answers
       * `reached-start` for `targetOrdinal: -1` — correctly — and the latch then
       * outlived that window. Measured: 3 Turns of 43 loaded, the reader jumped
       * back to the tail, and `before` stayed latched off for good.
       */
      mocks.items = Array.from({ length: 20 }, (_unused, index) => (
        userMessage(`turn-${index}`, `message-${index}`, 'Body')
      ));
      const restoreLayout = fakeLayout({
        clientHeight: VIEWPORT_PX,
        scrollHeight: 20 * ROW_PX,
        turnTopFromScrollerTop: 0,
      });
      const asked: string[] = [];
      const atFirstTurn = { startOrdinal: 0, endOrdinalExclusive: 8, targetTurnId: null, mode: 'history-window' as const };
      const atTail = { startOrdinal: 35, endOrdinalExclusive: 43, targetTurnId: null, mode: 'history-window' as const };
      const list = (window: typeof atFirstTurn) => (
        <VirtualMessageList
          presentationMode="history-window"
          historyWindow={window}
          onHistoryWindowBoundaryIntent={direction => {
            asked.push(direction);
            // Nothing before the first Turn — true of this window, and only it.
            return 'exhausted';
          }}
        />
      );

      try {
        await act(async () => {
          root.render(list(atFirstTurn));
          await Promise.resolve();
          await Promise.resolve();
        });
        await settleOpenReveal();
        expect(asked).toContain('before');
        asked.length = 0;

        // Latched: asking again from the same window changes nothing.
        const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
        await act(async () => {
          scroller.dispatchEvent(new Event('wheel'));
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(asked).toEqual([]);

        // The reader jumps back to the tail. The answer was about where they
        // were, so it does not survive their leaving.
        await act(async () => {
          root.render(list(atTail));
          await Promise.resolve();
          await Promise.resolve();
        });
        await act(async () => {
          scroller.dispatchEvent(new Event('wheel'));
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(asked).toContain('before');
      } finally {
        restoreLayout();
      }
    });
  });

  it('prepares history navigation without manufacturing bottom range', () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    act(() => root.render(<VirtualMessageList ref={listRef} />));
    expect(listRef.current?.prepareTurnNavigation('turn-2')).toBe('pending');
    expect(container.querySelector('.message-list-footer')?.getAttribute('style')).toContain(`${BOTTOM_INSET}px`);
  });

  it('captures and restores a history viewport by Turn and viewport offset', () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    const layout = {
      clientHeight: 600,
      scrollHeight: 2000,
      turnTopFromScrollerTop: 120,
    };
    const restoreLayout = fakeLayout(layout);
    try {
      act(() => root.render(
        <VirtualMessageList
          ref={listRef}
          presentationMode="history-window"
          viewportMode="history-reading"
          historyWindow={{ startOrdinal: 4, endOrdinalExclusive: 8 }}
        />,
      ));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.getBoundingClientRect = () => (
        { ...new DOMRect(0, 0, 1000, 600), top: 0, bottom: 600 } as DOMRect
      );
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 400,
      });

      const snapshot = listRef.current?.captureViewportSnapshot();
      expect(snapshot).toMatchObject({
        sessionId: 'session-1',
        presentationMode: 'history-window',
        viewportMode: 'history-reading',
        historyWindow: { startOrdinal: 4, endOrdinalExclusive: 8 },
        anchorTurnId: 'turn-1',
        anchorOffsetPx: 120,
        scrollTopPx: 400,
      });

      layout.turnTopFromScrollerTop = 260;
      let restored = false;
      act(() => {
        restored = snapshot ? listRef.current?.restoreViewportSnapshot(snapshot) ?? false : false;
      });

      expect(restored).toBe(true);
      expect(scroller.scrollTop).toBe(540);
    } finally {
      restoreLayout();
    }
  });

  it('restores the exact visible virtual row instead of the Turn header', () => {
    mocks.items = [
      userMessage('turn-1', 'message-1', 'Question'),
      modelRound('turn-1', 'round-1', 'Long answer'),
    ];
    const listRef = React.createRef<VirtualMessageListRef>();
    const restoreLayout = fakeLayout({
      clientHeight: 600,
      scrollHeight: 2000,
      turnTopFromScrollerTop: 120,
    });
    try {
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.getBoundingClientRect = () => (
        { ...new DOMRect(0, 0, 1000, 600), top: 0, bottom: 600 } as DOMRect
      );
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 400,
      });
      const [turnHeader, modelRoundElement] = Array.from(
        container.querySelectorAll<HTMLElement>('.virtual-item-wrapper'),
      );
      turnHeader.getBoundingClientRect = () => (
        { ...new DOMRect(0, -300, 1000, 40), top: -300, bottom: -260 } as DOMRect
      );
      let modelRoundTop = -80;
      modelRoundElement.getBoundingClientRect = () => (
        { ...new DOMRect(0, modelRoundTop, 1000, 900), top: modelRoundTop, bottom: modelRoundTop + 900 } as DOMRect
      );

      const snapshot = listRef.current?.captureViewportSnapshot();
      expect(snapshot).toMatchObject({
        anchorItemKey: 'model-round:turn-1:round-1',
        anchorItemType: 'model-round',
        anchorTurnId: 'turn-1',
        anchorOffsetPx: -80,
      });

      modelRoundTop = 170;
      act(() => {
        expect(snapshot && listRef.current?.restoreViewportSnapshot(snapshot)).toBe(true);
      });
      expect(scroller.scrollTop).toBe(650);
    } finally {
      restoreLayout();
    }
  });

  it('materializes and restores a saved reading position without starting tail follow', async () => {
    const listRef = React.createRef<VirtualMessageListRef>();
    const initialViewportSnapshot = {
      sessionId: 'session-1',
      presentationMode: 'tail' as const,
      viewportMode: 'live-tail' as const,
      historyWindow: null,
      anchorTurnId: 'turn-1',
      anchorOffsetPx: 120,
      scrollTopPx: 400,
      isAtTail: false,
      capturedAtMs: 1,
    };
    const layout = {
      clientHeight: 600,
      scrollHeight: 2000,
      turnTopFromScrollerTop: 260,
    };
    const restoreLayout = fakeLayout(layout);
    try {
      act(() => root.render(
        <VirtualMessageList
          ref={listRef}
          initialViewportSnapshot={initialViewportSnapshot}
        />,
      ));
      const scroller = container.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      scroller.getBoundingClientRect = () => (
        { ...new DOMRect(0, 0, 1000, 600), top: 0, bottom: 600 } as DOMRect
      );

      expect(mocks.startAtTailOnMount).toBe(false);
      expect(mocks.virtualizerStartsAtTail).toBe(false);
      expect(scroller.scrollTop).toBe(140);
      await settleOpenReveal();
      expect(container.querySelector('[data-open-viewport-settled="true"]')).not.toBeNull();
    } finally {
      restoreLayout();
    }
  });
});
