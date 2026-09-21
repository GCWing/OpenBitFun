// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tailSpacerPxForViewport } from './flowChatTailFollow';
import {
  TAIL_EASE_ALPHA,
  TAIL_EASE_LINE_PX,
  TAIL_EASE_SNAP_ABOVE_PX,
} from '../../utils/flowChatTailEase';
import { SMOOTH_SCROLL_STALL_MS, useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import {
  useFlowChatViewportOwner,
  type FlowChatViewportOwnerApi,
} from './useFlowChatViewportOwner';
import { USER_DRIVEN_SCROLL_WINDOW_MS } from './flowChatViewportAnchor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Controller = ReturnType<typeof useFlowChatFollowOutput>;

const VIEWPORT = 500;
/** Input-stack footer the harness renders below the transcript. */
const BOTTOM_INSET = 100;
/** The spacer the component would render for a given viewport. */
const spacerFor = (clientHeight: number) => tailSpacerPxForViewport(clientHeight, BOTTOM_INSET);
const TAIL_SPACER = spacerFor(VIEWPORT);
/** The 60% hold gap is capped by the smaller physical spacer. */
const MAX_GAP = TAIL_SPACER;

function setScrollerMetrics(
  scroller: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
}

/**
 * `turn-N` is the Nth Turn of the session, so the ledger holds N of them.
 *
 * A Turn arriving grows the ledger, which is what every test walking `turn-1`
 * to `turn-2` means. A rollback is the one case where the identity moves and
 * the ledger does not grow, and those tests state the count themselves.
 */
const turnCountFor = (turnId: string) => Number(turnId.replace('turn-', '')) || 1;

interface HarnessProps {
  latestTurnId: string;
  /** Turns in the session ledger. Defaults to what `latestTurnId` implies. */
  dialogTurnCount?: number;
  isStreaming?: boolean;
  scroller: HTMLElement;
  scrollToContentEnd?: (behavior: ScrollBehavior) => void;
  revealNewTurnTail?: (turnId: string) => boolean;
  isOpeningViewport?: boolean;
  onOpeningOffset?: (actualOffsetPx: number) => void;
  isViewportActive?: boolean;
  isViewportSuspended?: boolean;
  startAtTailOnMount?: boolean;
  onController: (controller: Controller) => void;
  /** The register the hook writes through, for a test that has to hold it. */
  onViewportOwner?: (owner: FlowChatViewportOwnerApi) => void;
}

function Harness({
  latestTurnId,
  dialogTurnCount = turnCountFor(latestTurnId),
  isStreaming = true,
  scroller,
  scrollToContentEnd = () => {},
  revealNewTurnTail = () => false,
  isOpeningViewport = false,
  onOpeningOffset,
  isViewportActive = true,
  isViewportSuspended = false,
  startAtTailOnMount = true,
  onController,
  onViewportOwner,
}: HarnessProps) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  // The real register, not a stand-in: what this hook is allowed to write is
  // now part of its behaviour, so a permissive fake would test the wrong thing.
  const viewportOwner = useFlowChatViewportOwner(scrollerRef);
  onViewportOwner?.(viewportOwner);
  const controller = useFlowChatFollowOutput({
    activeSessionId: 'session-1',
    latestTurnId,
    dialogTurnCount,
    virtualItemCount: 2,
    isStreaming,
    isViewportActive,
    isViewportSuspended: () => isViewportSuspended,
    startAtTailOnMount,
    scrollerRef,
    // Sized from live layout, exactly as the component's state does.
    getTailSpacerPx: () => tailSpacerPxForViewport(scroller.clientHeight, BOTTOM_INSET),
    scrollToContentEnd,
    revealNewTurnTail,
    isOpeningViewport: () => isOpeningViewport,
    onOpeningOffset,
    viewportOwner,
  });
  onController(controller);
  return <div data-following={String(controller.isFollowingOutput)} />;
}

describe('useFlowChatFollowOutput', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scroller: HTMLDivElement;
  let controller: Controller | null;
  let frames: FrameRequestCallback[];
  let scrollTo: ReturnType<typeof vi.fn>;

  function runNextFrame() {
    const frame = frames.shift();
    expect(frame).toBeDefined();
    act(() => frame?.(16));
  }

  beforeEach(() => {
    container = document.createElement('div');
    scroller = document.createElement('div');
    document.body.append(container, scroller);
    // jsdom has no layout engine, so the animated scroll is a no-op here and
    // the tests place the viewport where the animation would have left it.
    scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    root = createRoot(container);
    controller = null;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    scroller.remove();
    vi.unstubAllGlobals();
  });

  it('reveals a newly submitted Turn at the physical bottom once', () => {
    const revealNewTurnTail = vi.fn(() => {
      scroller.scrollTop = 100;
      return true;
    });
    const scrollToContentEnd = vi.fn();
    const props = {
      scroller,
      scrollToContentEnd,
      revealNewTurnTail,
      onController: (next: Controller) => { controller = next; },
    };

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-1" isStreaming={false} />);
    });
    // Mount settles on the content end; only the *new Turn* must not.
    expect(scrollToContentEnd).toHaveBeenCalledWith('auto');
    scrollToContentEnd.mockClear();

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-2" isStreaming={false} />);
    });

    expect(revealNewTurnTail).toHaveBeenCalledWith('turn-2');
    expect(scrollToContentEnd).not.toHaveBeenCalled();
    expect(controller?.isFollowingOutput).toBe(true);
  });

  it('does not read a rolled-back Turn as a newly arrived one', () => {
    /*
     * Measured as a report: send a message, watch it pin, roll it back, and the
     * Turn *before* it takes the viewport top. `latestTurnId` is right — it is
     * the ledger's last Turn — but the detector asked whether the identity had
     * changed, and a truncation changes it without anything having arrived.
     */
    const revealNewTurnTail = vi.fn(() => {
      scroller.scrollTop = 100;
      return true;
    });
    const props = {
      scroller,
      revealNewTurnTail,
      onController: (next: Controller) => { controller = next; },
    };

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-2" isStreaming={false} />);
    });
    revealNewTurnTail.mockClear();

    // The rollback removes turn-2, so the ledger's last Turn is turn-1 again.
    act(() => {
      root.render(
        <Harness {...props} latestTurnId="turn-1" dialogTurnCount={1} isStreaming={false} />,
      );
    });

    expect(revealNewTurnTail).not.toHaveBeenCalled();
  });

  it('returns to the end of the transcript when a rollback takes the Turn it was following', () => {
    const scrollToContentEnd = vi.fn();
    const props = {
      scroller,
      scrollToContentEnd,
      revealNewTurnTail: () => true,
      onController: (next: Controller) => { controller = next; },
    };

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-2" isStreaming={false} />);
    });
    scrollToContentEnd.mockClear();

    act(() => {
      root.render(
        <Harness {...props} latestTurnId="turn-1" dialogTurnCount={1} isStreaming={false} />,
      );
    });
    // Nothing on its own: a shorter ledger is not a reason to move, because
    // hydration and window merges write it too.
    expect(scrollToContentEnd).not.toHaveBeenCalled();

    // The rollback says so itself, and the answer is the tail.
    act(() => { controller?.handleTurnsRolledBack(); });
    expect(scrollToContentEnd).toHaveBeenCalledWith('auto');
  });

  it('settles a rollback on the new tail even after the reader took the viewport', () => {
    /*
     * Gating this on ownership made it dead code in the case it was written
     * for. Reaching a Turn far enough up to want it gone means scrolling, and
     * scrolling is what hands the viewport back to the reader — so the answer
     * never ran, the anchor held the reader's Turn at its offset from the
     * viewport top, and an 8-Turn session rolled back at Turn 7 came to rest on
     * Turns 2..6 with the new last Turn's answer below the fold.
     *
     * Taking it is safe because a rollback at Turn N
     * removes N and everything after it, and N was on screen. The new tail is
     * within a Turn of where the reader already is.
     */
    const scrollToContentEnd = vi.fn();
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-2"
          isStreaming={false}
          scroller={scroller}
          scrollToContentEnd={scrollToContentEnd}
          onController={next => { controller = next; }}
        />,
      );
    });
    act(() => { controller?.handleUserScrollIntent(); });
    expect(controller?.isFollowingOutput).toBe(false);
    scrollToContentEnd.mockClear();

    act(() => { controller?.handleTurnsRolledBack(); });
    expect(scrollToContentEnd).toHaveBeenCalledWith('auto');
    expect(controller?.isFollowingOutput).toBe(true);
  });

  it('settles on the content end when a session opens without streaming', () => {
    const scrollToContentEnd = vi.fn();
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          isStreaming={false}
          scroller={scroller}
          scrollToContentEnd={scrollToContentEnd}
          onController={next => { controller = next; }}
        />,
      );
    });

    expect(scrollToContentEnd).toHaveBeenCalledWith('auto');
    expect(controller?.isFollowingOutput).toBe(true);
  });

  it('tracks the content end exactly while the transcript is still opening', () => {
    // The virtualizer compensates a history prepend by writing scrollTop before the
    // prepended heights reach the DOM. While opening, the transcript is hidden
    // and we are authoritative — accommodating that write would be invisible
    // now and permanent once paging stops.
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          isOpeningViewport
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();
    expect(scroller.scrollTop).toBe(1000);

    scroller.scrollTop = 1000 + 380;
    runNextFrame();
    expect(scroller.scrollTop).toBe(1000);
  });

  describe('opening offset publication', () => {
    const mountOpening = (props: Partial<HarnessProps> = {}) => {
      act(() => root.render(<Harness
        latestTurnId="turn-1"
        scroller={scroller}
        isOpeningViewport
        onController={next => { controller = next; }}
        {...props}
      />));
    };

    beforeEach(() => {
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + TAIL_SPACER, clientHeight: VIEWPORT, scrollTop: 0,
      });
    });

    it('publishes the clamped readback in the follow frame without a scroll event', () => {
      let actualTop = 0;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => actualTop,
        set: (value: number) => { actualTop = Math.min(value, 900); },
      });
      const onOpeningOffset = vi.fn();
      mountOpening({ onOpeningOffset });
      expect(onOpeningOffset).toHaveBeenCalledWith(900);
      onOpeningOffset.mockClear();
      actualTop = 0;
      runNextFrame();
      expect(onOpeningOffset).toHaveBeenCalledExactlyOnceWith(900);
      expect(scroller.scrollTop).toBe(900);
    });

    it('publishes an already-reached target and uses the latest callback', () => {
      scroller.scrollTop = 1000;
      const previous = vi.fn();
      const current = vi.fn();
      mountOpening({ onOpeningOffset: previous });
      previous.mockClear();
      mountOpening({ onOpeningOffset: current });
      current.mockClear();
      runNextFrame();
      expect(previous).not.toHaveBeenCalled();
      expect(current).toHaveBeenCalledExactlyOnceWith(1000);
    });

    it.each([0, 1000])('does not publish under a higher-priority owner at offset %s', offset => {
      scroller.scrollTop = offset;
      const onOpeningOffset = vi.fn();
      let owner: FlowChatViewportOwnerApi;
      mountOpening({ onOpeningOffset, onViewportOwner: next => { owner = next; } });
      act(() => owner.claim('one-shot-navigation', { holdForMs: 1000 }));
      expect(owner!.currentOwner()).toBe('one-shot-navigation');
      scroller.scrollTop = offset;
      onOpeningOffset.mockClear();
      act(() => controller?.scheduleFollowToLatest());
      expect(scroller.scrollTop).toBe(offset);
      expect(onOpeningOffset).not.toHaveBeenCalled();
    });

    it.each([
      { isOpeningViewport: false },
      { isViewportActive: false },
      { isViewportSuspended: true },
      { startAtTailOnMount: false },
    ])('does not publish outside active opening follow: %j', boundary => {
      const onOpeningOffset = vi.fn();
      mountOpening({ onOpeningOffset, ...boundary });
      act(() => controller?.scheduleFollowToLatest());
      expect(onOpeningOffset).not.toHaveBeenCalled();
    });

    it('stops publishing when the reader takes over', () => {
      const onOpeningOffset = vi.fn();
      mountOpening({ onOpeningOffset });
      runNextFrame();
      onOpeningOffset.mockClear();
      act(() => controller?.handleUserScrollIntent());
      scroller.scrollTop = 100;
      act(() => controller?.scheduleFollowToLatest());
      expect(scroller.scrollTop).toBe(100);
      expect(onOpeningOffset).not.toHaveBeenCalled();
    });
  });

  it('does not strand the viewport inside the tail spacer after opening', () => {
    // Regression: the gap tolerance is a streaming allowance. Applied to a
    // foreign forward move it parked the content end mid-viewport forever,
    // because nothing pulls the target back down once paging stops.
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          isOpeningViewport
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();

    scroller.scrollTop = 1000 + 380;
    runNextFrame();
    expect(scroller.scrollTop).toBe(1000);
    expect(1000).toBeLessThan(1000 + MAX_GAP);
  });

  it('defers the reveal when the new Turn is not in the live-tail projection yet', () => {
    const scrollToContentEnd = vi.fn();
    const revealNewTurnTail = vi.fn(() => false);
    const props = {
      scroller,
      scrollToContentEnd,
      revealNewTurnTail,
      onController: (next: Controller) => { controller = next; },
    };

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-1" isStreaming={false} />);
    });
    scrollToContentEnd.mockClear();
    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-2" isStreaming={false} />);
    });

    expect(revealNewTurnTail).toHaveBeenCalledWith('turn-2');
    expect(scrollToContentEnd).not.toHaveBeenCalled();
    expect(controller?.isFollowingOutput).toBe(true);
  });

  it('reveals a new Turn at physical bottom once and lets growth consume the blank', () => {
    setScrollerMetrics(scroller, {
      scrollHeight: 1200 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 700,
    });
    const revealNewTurnTail = vi.fn(() => {
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      return true;
    });
    const props = {
      scroller,
      revealNewTurnTail,
      onController: (next: Controller) => { controller = next; },
    };

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-1" isStreaming={false} />);
    });
    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-2" />);
    });

    expect(revealNewTurnTail).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(700 + TAIL_SPACER);

    setScrollerMetrics(scroller, {
      scrollHeight: 1300 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 700 + TAIL_SPACER,
    });
    act(() => controller?.scheduleFollowToLatest());
    expect(scroller.scrollTop).toBe(700 + TAIL_SPACER);
  });

  it('starts following without a snap when streamed output consumes the reveal blank', () => {
    setScrollerMetrics(scroller, {
      scrollHeight: 1200 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 700,
    });
    const revealNewTurnTail = () => {
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      return true;
    };
    const props = {
      scroller,
      revealNewTurnTail,
      onController: (next: Controller) => { controller = next; },
    };

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-1" isStreaming={false} />);
    });
    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-2" />);
    });

    const revealPosition = 700 + TAIL_SPACER;
    setScrollerMetrics(scroller, {
      scrollHeight: 1200 + TAIL_SPACER + TAIL_SPACER + 10,
      clientHeight: VIEWPORT,
      scrollTop: revealPosition,
    });
    act(() => controller?.scheduleFollowToLatest());
    expect(scroller.scrollTop).toBe(revealPosition);

    // The first queued frame may be the cancelled opening settle. The next one
    // is ordinary following and advances from the unchanged reveal position.
    runNextFrame();
    runNextFrame();
    expect(scroller.scrollTop).toBeGreaterThan(revealPosition);
  });

  it('follows content growth against the content end, not the tail spacer', () => {
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 1000,
    });

    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          onController={next => { controller = next; }}
        />,
      );
    });
    expect(controller?.isFollowingOutput).toBe(true);

    setScrollerMetrics(scroller, {
      scrollHeight: 1800 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 1000,
    });
    runNextFrame();

    expect(scroller.scrollTop).toBe(1300);
  });

  it('holds its offset when a collapse shrinks content under the viewport', () => {
    // The regression this whole mechanism exists for: a tool card collapsing
    // above the live output must not drag earlier content down.
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();
    expect(scroller.scrollTop).toBe(1000);

    setScrollerMetrics(scroller, {
      scrollHeight: 1200 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 1000,
    });
    runNextFrame();

    expect(scroller.scrollTop).toBe(1000 - (300 - MAX_GAP));
  });

  it('gives ground only past the tolerated gap after a very large collapse', () => {
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();

    setScrollerMetrics(scroller, {
      scrollHeight: 700 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 1000,
    });
    runNextFrame();

    expect(scroller.scrollTop).toBe(200 + MAX_GAP);
  });

  it('does not force the content end when a resize re-asserts follow', () => {
    const scrollToContentEnd = vi.fn();
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          scrollToContentEnd={scrollToContentEnd}
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();
    scrollToContentEnd.mockClear();

    setScrollerMetrics(scroller, {
      scrollHeight: 1200 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 1000,
    });
    act(() => controller?.scheduleFollowToLatest());

    expect(scrollToContentEnd).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(1000 - (300 - MAX_GAP));
  });

  it('settles the held blank once streaming stops', () => {
    const scrollToContentEnd = vi.fn();
    const props = {
      scroller,
      scrollToContentEnd,
      onController: (next: Controller) => { controller = next; },
    };
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-1" />);
    });
    runNextFrame();

    setScrollerMetrics(scroller, {
      scrollHeight: 1200 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 1000,
    });
    runNextFrame();
    scrollToContentEnd.mockClear();

    act(() => {
      root.render(<Harness {...props} latestTurnId="turn-1" isStreaming={false} />);
    });

    expect(scrollToContentEnd).toHaveBeenCalledWith('smooth');
  });

  it('lets explicit user scroll intent exit follow immediately', () => {
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          onController={next => { controller = next; }}
        />,
      );
    });
    act(() => controller?.enterFollowOutput('jump-to-latest'));
    expect(controller?.isFollowingOutput).toBe(true);

    act(() => controller?.handleUserScrollIntent());
    expect(controller?.isFollowingOutput).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  /** Mount on a transcript of `contentEndPx`, then jump to latest from the top. */
  function jumpToLatestAcross(contentEndPx: number) {
    const scrollToContentEnd = vi.fn();
    setScrollerMetrics(scroller, {
      scrollHeight: contentEndPx + VIEWPORT + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          scrollToContentEnd={scrollToContentEnd}
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();
    expect(scroller.scrollTop).toBe(contentEndPx);
    scroller.scrollTop = 0;
    scrollToContentEnd.mockClear();
    act(() => controller?.enterFollowOutput('jump-to-latest'));
    return scrollToContentEnd;
  }

  it('uses smooth behavior only for an explicit jump to latest', () => {
    // Well inside `FLOWCHAT_ANIMATED_JUMP_MAX_VIEWPORTS`, so the distance is not
    // what this is testing.
    expect(jumpToLatestAcross(VIEWPORT)).toHaveBeenCalledWith('smooth');
  });

  it('lands a near jump immediately when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    expect(jumpToLatestAcross(VIEWPORT)).toHaveBeenCalledWith('auto');
  });

  it('lands a jump too far to follow rather than animate part of it', () => {
    /*
     * The animation cannot finish this and the frame loop takes the viewport
     * back wherever it has got to — measured, a jump issued for 8717px animated
     * 5480 of them and was finished in one 3290px write. The reader sees two
     * thirds of a scroll and then a jump, which is worse than either.
     *
     * It would not be worth watching even if it did finish: three screens on,
     * the transcript in between is going past faster than anyone can read it,
     * so the continuity an animation exists to show is not there to see.
     */
    expect(jumpToLatestAcross(VIEWPORT * 10)).toHaveBeenCalledWith('auto');
  });

  it('yields the frame loop to its own animated scroll instead of overwriting it', () => {
    // The loop assigns scrollTop outright, which cancels an in-flight smooth
    // scroll on the very next frame: `jump-to-latest` asked for an animation
    // and got a jump.
    setScrollerMetrics(scroller, {
      scrollHeight: 1500 + TAIL_SPACER,
      clientHeight: VIEWPORT,
      scrollTop: 0,
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          onController={next => { controller = next; }}
        />,
      );
    });
    runNextFrame();
    expect(scroller.scrollTop).toBe(1000);

    scroller.scrollTop = 0;
    act(() => controller?.enterFollowOutput('jump-to-latest'));
    runNextFrame();

    expect(scroller.scrollTop).toBe(0);
  });

  describe('standing down for its own animated scroll', () => {
    /**
     * A clock the test moves by hand.
     *
     * The stand-down ends on a *duration* without travel, so a test that runs
     * its frames in microseconds of real time proves nothing about it either
     * way. Every frame below states how much time it took.
     */
    let nowMs = 0;
    let nowSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      nowMs = 1_000;
      nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    /*
     * A viewport tall enough that the jump below is one the follow rule agrees
     * to animate at all: only a jump inside
     * `FLOWCHAT_ANIMATED_JUMP_MAX_VIEWPORTS` is animated, and everything in
     * this block is about what happens *during* an animation, so it has to be
     * given one. The distance is left where it was so the frame counts below
     * still mean what their comments say.
     */
    const TALL_VIEWPORT = 1_600;
    const CONTENT_END = 4_500;

    /**
     * Mounts a transcript whose content ends at `CONTENT_END`, settles there,
     * and then issues an animated jump to latest from the top.
     *
     * jsdom does not animate, so the animation is played by hand below. That is
     * the point of these tests: what ends the stand-down is the viewport having
     * stopped moving, and only a test that moves it can tell that apart from a
     * budget running out.
     */
    function jumpToLatestFromTheTop() {
      setScrollerMetrics(scroller, {
        scrollHeight: CONTENT_END + TALL_VIEWPORT + spacerFor(TALL_VIEWPORT),
        clientHeight: TALL_VIEWPORT,
        scrollTop: 0,
      });
      act(() => {
        root.render(
          <Harness
            latestTurnId="turn-1"
            scroller={scroller}
            onController={next => { controller = next; }}
          />,
        );
      });
      runNextFrame();
      expect(scroller.scrollTop).toBe(CONTENT_END);
      scroller.scrollTop = 0;
      act(() => controller?.enterFollowOutput('jump-to-latest'));
    }

    /** One frame, `forMs` after the last, in which the animation moved `byPx`. */
    function animateFrame(byPx: number, forMs = 5) {
      nowMs += forMs;
      scroller.scrollTop += byPx;
      runNextFrame();
    }

    it('stays out of the way for as long as the animation is still travelling', () => {
      // The stand-down used to be 45 frames, which is 0.75s at 60Hz and 0.52s
      // on a busy 200Hz display — measured, a jump issued for 8717px animated
      // 5480 of them and was finished by the loop in one 3290px write.
      jumpToLatestFromTheTop();

      for (let frame = 0; frame < 60; frame += 1) {
        animateFrame(50);
        expect(scroller.scrollTop).toBe(50 * (frame + 1));
      }
    });

    it('sits through the frames a smooth scroll takes to visibly start', () => {
      /*
       * The regression this pair of constants exists for. A programmatic smooth
       * scroll eases in — measured on WebView2, 2px in its first 50ms against
       * 9734px to travel — and with scroll offsets quantised to 0.8px the early
       * frames genuinely do not move. Counting two still *frames* took the
       * viewport back 21ms after asking for the animation, and the reader saw
       * an instant jump.
       */
      jumpToLatestFromTheTop();

      for (let frame = 0; frame < 20; frame += 1) {
        animateFrame(0);
      }
      expect(scroller.scrollTop).toBe(0);

      // 100ms in, still inside the window, and the animation finally shows.
      animateFrame(0.8);
      expect(scroller.scrollTop).toBe(0.8);
    });

    it('resumes once the animation stops moving the viewport', () => {
      jumpToLatestFromTheTop();
      animateFrame(50);

      // Still inside the window a stalling animation is given.
      animateFrame(0, SMOOTH_SCROLL_STALL_MS - 10);
      expect(scroller.scrollTop).toBe(50);

      animateFrame(0, 20);
      expect(scroller.scrollTop).toBe(CONTENT_END);
    });

    it('takes the viewport back on the backstop when the animation never ends', () => {
      jumpToLatestFromTheTop();
      // Travelling the whole time, so nothing but the backstop can end this.
      for (let frame = 0; frame < 12; frame += 1) {
        animateFrame(1, 100);
      }

      expect(scroller.scrollTop).toBe(CONTENT_END);
    });
  });

  describe('easing the follow across the frames it has', () => {
    /** Mounts a streaming transcript resting exactly on its content end. */
    function followFromContentEnd() {
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: 1000,
      });
      act(() => {
        root.render(
          <Harness
            latestTurnId="turn-1"
            scroller={scroller}
            onController={next => { controller = next; }}
          />,
        );
      });
    }

    /** Grows real content by `byPx`, which is what moves the follow target. */
    function growContentBy(byPx: number) {
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + byPx + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: scroller.scrollTop,
      });
    }

    it('spends a line of growth over the frames that were empty', () => {
      // Markdown reflows a line at a time, so an outright write puts all 24px
      // on one frame out of seven and none on the rest.
      followFromContentEnd();
      growContentBy(TAIL_EASE_LINE_PX);

      runNextFrame();

      expect(scroller.scrollTop).toBeCloseTo(1000 + TAIL_EASE_LINE_PX * TAIL_EASE_ALPHA, 5);
      expect(scroller.scrollTop - 1000).toBeLessThan(TAIL_EASE_LINE_PX);
    });

    it('keeps stepping until it has landed on the target', () => {
      followFromContentEnd();
      growContentBy(TAIL_EASE_LINE_PX);

      let previousPx = 1000;
      for (let frame = 0; frame < 20; frame += 1) {
        runNextFrame();
        // Every step is under a line: that is the bar the ease has to clear to
        // be worth having, since a line is what it set out to replace.
        expect(scroller.scrollTop - previousPx).toBeLessThan(TAIL_EASE_LINE_PX);
        previousPx = scroller.scrollTop;
      }

      // Inside the loop's own `BOTTOM_EPSILON_PX`, where it stops writing at
      // all — the ease converges on the target rather than stalling short of
      // it or ringing around it.
      expect(1000 + TAIL_EASE_LINE_PX - scroller.scrollTop).toBeLessThan(2);
      expect(scroller.scrollTop).toBeLessThanOrEqual(1000 + TAIL_EASE_LINE_PX);
    });

    it('jumps when an ease would open with a bigger step than the jump it replaces', () => {
      // A burst arriving further behind than four lines: a quarter of that is
      // already worse than having simply gone the whole way.
      followFromContentEnd();
      growContentBy(TAIL_EASE_SNAP_ABOVE_PX + 100);

      runNextFrame();

      expect(scroller.scrollTop).toBe(1000 + TAIL_EASE_SNAP_ABOVE_PX + 100);
    });

    it('does not ease while the transcript is still opening', () => {
      // The reveal waits for the viewport to reach the content end, and while
      // it waits nothing is painted — so an ease there is travel nobody sees,
      // holding open the one phase whose whole point is to be over.
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: 1000,
      });
      act(() => {
        root.render(
          <Harness
            latestTurnId="turn-1"
            scroller={scroller}
            isOpeningViewport
            onController={next => { controller = next; }}
          />,
        );
      });
      growContentBy(TAIL_EASE_LINE_PX);

      runNextFrame();

      expect(scroller.scrollTop).toBe(1000 + TAIL_EASE_LINE_PX);
    });

    it('goes the whole way at once when content shrinks under the viewport', () => {
      // Easing down through a shrink reads as the transcript being clawed
      // backwards, which is worse than the jump it would replace.
      followFromContentEnd();
      setScrollerMetrics(scroller, {
        scrollHeight: 700 + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: 1000,
      });

      runNextFrame();

      // Past the tolerated gap, so the hold rule gives ground — in one step.
      expect(scroller.scrollTop).toBe(200 + MAX_GAP);
    });
  });

  describe('new Turn reveal ownership', () => {
    function revealLatestTurn() {
      const scrollToContentEnd = vi.fn();
      setScrollerMetrics(scroller, {
        scrollHeight: 1200 + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: 700,
      });
      const props = {
        scroller,
        scrollToContentEnd,
        revealNewTurnTail: () => {
          scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
          return true;
        },
        onController: (next: Controller) => { controller = next; },
      };
      act(() => {
        root.render(<Harness {...props} latestTurnId="turn-1" isStreaming={false} />);
      });
      scrollToContentEnd.mockClear();
      act(() => {
        root.render(<Harness {...props} latestTurnId="turn-2" isStreaming={false} />);
      });
      return scrollToContentEnd;
    }

    it('ignores a delayed jump-to-latest while the one-shot reveal is active', () => {
      const scrollToContentEnd = revealLatestTurn();
      const revealPosition = scroller.scrollTop;

      act(() => controller?.enterFollowOutput('jump-to-latest'));

      expect(scrollToContentEnd).not.toHaveBeenCalled();
      expect(scroller.scrollTop).toBe(revealPosition);
    });

    it('releases reveal ownership on user intent', () => {
      revealLatestTurn();

      act(() => controller?.handleUserScrollIntent());

      expect(controller?.isFollowingOutput).toBe(false);
    });
  });

  describe('user-controlled reserved blank', () => {
    it('keeps a reader in the blank after their scroll ends', () => {
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: 0,
      });
      act(() => {
        root.render(
          <Harness
            latestTurnId="turn-1"
            isStreaming={false}
            scroller={scroller}
            onController={next => { controller = next; }}
          />,
        );
      });
      act(() => controller?.handleUserScrollIntent());
      scrollTo.mockClear();

      scroller.scrollTop = 1000 + TAIL_SPACER;
      act(() => controller?.handleScroll());

      expect(scroller.scrollTop).toBe(1000 + TAIL_SPACER);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(controller?.isFollowingOutput).toBe(false);
    });
  });

  describe('anchoring the viewport bottom across a resize', () => {
    /** Mounts at the content end, then hands the viewport to the user. */
    function restAtContentEnd() {
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + spacerFor(VIEWPORT),
        clientHeight: VIEWPORT,
        scrollTop: 0,
      });
      act(() => {
        root.render(
          <Harness
            latestTurnId="turn-1"
            isStreaming={false}
            scroller={scroller}
            onController={next => { controller = next; }}
          />,
        );
      });
      runNextFrame();
      expect(scroller.scrollTop).toBe(1000);
      act(() => controller?.handleUserScrollIntent());
    }

    /** Content and footer stay at 1500; only the viewport, and so the spacer, change. */
    function resizeViewportTo(clientHeight: number, scrollTop: number) {
      setScrollerMetrics(scroller, {
        scrollHeight: 1500 + spacerFor(clientHeight),
        clientHeight,
        scrollTop,
      });
    }

    it('keeps content against the viewport bottom when the viewport grows', () => {
      // A viewport 200px taller lowers the content end by 200px. Without the
      // clamp the spacer removed, the resting viewport is left that far into
      // the blank.
      restAtContentEnd();
      resizeViewportTo(VIEWPORT + 200, 1000);

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 200,
        wasAtTail: true,
      }));

      expect(scroller.scrollTop).toBe(800);
    });

    it('keeps content against the viewport bottom when the viewport shrinks', () => {
      // The opposite direction: the content end moves down past the viewport,
      // cutting off the bottom of what was on screen.
      restAtContentEnd();
      resizeViewportTo(VIEWPORT - 200, 1000);

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: -200,
        wasAtTail: true,
      }));

      expect(scroller.scrollTop).toBe(1200);
    });

    it('anchors the bottom for a viewport reading history too', () => {
      // The rule is not about the tail. A plain scroller preserves scrollTop
      // and reveals or swallows content at the bottom edge; for a transcript
      // the bottom edge is the one worth holding still.
      restAtContentEnd();
      resizeViewportTo(VIEWPORT + 200, 600);

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 200,
        wasAtTail: false,
      }));

      expect(scroller.scrollTop).toBe(400);
    });

    it('does not drag a viewport reading history to the tail', () => {
      restAtContentEnd();
      resizeViewportTo(VIEWPORT - 200, 600);

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: -200,
        wasAtTail: false,
      }));

      // Bottom-anchored, and nowhere near the content end at 1200.
      expect(scroller.scrollTop).toBe(800);
    });

    it('corrects instantly, since the content does not appear to move', () => {
      restAtContentEnd();
      scrollTo.mockClear();
      resizeViewportTo(VIEWPORT + 200, 1000);

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 200,
        wasAtTail: true,
      }));

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('does not hand the viewport back to follow', () => {
      // A gesture ending in the blank means "take me to the end"; a layout
      // change means nothing at all.
      restAtContentEnd();
      resizeViewportTo(VIEWPORT + 200, 1000);

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 200,
        wasAtTail: true,
      }));

      expect(controller?.isFollowingOutput).toBe(false);
    });

    it('follows the content end while a reflow keeps moving it', () => {
      // A width change reflows every item, and arithmetic cannot track where
      // the bottom line went. The end of the transcript is the one position
      // that can be recomputed, so a viewport resting on it is put back on it —
      // repeatedly, because the virtualizer re-estimates over several passes.
      restAtContentEnd();

      // Narrower: the same text wraps into 300px more content.
      setScrollerMetrics(scroller, {
        scrollHeight: 1800 + spacerFor(VIEWPORT),
        clientHeight: VIEWPORT,
        scrollTop: 1000,
      });
      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 0,
        wasAtTail: true,
      }));
      expect(scroller.scrollTop).toBe(1300);

      // Re-measurement adds another 200px above the viewport.
      setScrollerMetrics(scroller, {
        scrollHeight: 2000 + spacerFor(VIEWPORT),
        clientHeight: VIEWPORT,
        scrollTop: 1300,
      });
      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 0,
        wasAtTail: true,
      }));
      expect(scroller.scrollTop).toBe(1500);
    });

    it('leaves a reflow alone for a viewport that was not at the end', () => {
      restAtContentEnd();
      setScrollerMetrics(scroller, {
        scrollHeight: 1800 + spacerFor(VIEWPORT),
        clientHeight: VIEWPORT,
        scrollTop: 200,
      });

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 0,
        wasAtTail: false,
      }));

      expect(scroller.scrollTop).toBe(200);
    });

    it('does not pull a user-controlled blank position back to the tail', () => {
      restAtContentEnd();
      setScrollerMetrics(scroller, {
        scrollHeight: 1800 + spacerFor(VIEWPORT),
        clientHeight: VIEWPORT,
        scrollTop: 1600,
      });

      act(() => controller?.handleViewportResize({
        viewportHeightDeltaPx: 0,
        wasAtTail: false,
      }));

      expect(scroller.scrollTop).toBe(1600);
      expect(controller?.isFollowingOutput).toBe(false);
    });
  });

  describe('ownership across renders', () => {
    /*
     * Ownership is a ref because the loop reads it between renders, and it was
     * *also* assigned from the `isFollowingOutput` state on every render. Those
     * two writers disagree for exactly as long as a state update is queued, and
     * React is free to render in that window: an update scheduled from a
     * passive effect sits at a lower priority than a synchronous render, which
     * then renders the value from before it and put the ref back to `false`.
     *
     * Measured on session open, which is where this always happens — the entry
     * comes from a mount effect: `followOutput.enter` recorded, then the very
     * first frame of the loop stood down with `not-following` and its settle
     * budget untouched, and no `followOutput.exit` anywhere in the trail
     * because nothing had exited. The register still held `follow-output`, so
     * the prepend compensation for a history window that arrived 90ms later was
     * left to a writer that was no longer running, and the transcript stayed at
     * offset 0 — the top of the window, eight Turns above the tail.
     */
    it('survives a render that has not seen the entry yet', () => {
      act(() => {
        root.render(
          <Harness
            scroller={scroller}
            latestTurnId="turn-1"
            isStreaming={false}
            onController={(next) => { controller = next; }}
          />,
        );
      });
      act(() => controller?.handleUserScrollIntent());
      expect(controller?.isFollowingOutputNow()).toBe(false);

      // Outside `act`, so the state update this schedules is still queued.
      controller?.enterFollowOutput('jump-to-latest');
      expect(controller?.isFollowingOutputNow()).toBe(true);

      // A synchronous render, which does not carry the queued update.
      flushSync(() => {
        root.render(
          <Harness
            scroller={scroller}
            latestTurnId="turn-1"
            isStreaming={false}
            onController={(next) => { controller = next; }}
          />,
        );
      });

      expect(controller?.isFollowingOutputNow()).toBe(true);
    });
  });

  /*
   * Scrolling up gives the follow away, and the reserved blank is what makes
   * that too blunt on its own: a reader can leave the tail by a hundred pixels
   * and still be looking at empty space below the newest output, having missed
   * nothing. The departure watches those readers until the blank is gone, and
   * which side closed it decides who keeps the viewport.
   */
  describe('resuming a follow that output caught up with', () => {
    const CONTENT_END = 1_000;
    let viewportOwner: FlowChatViewportOwnerApi | null = null;

    /** Move the end of real content, leaving the viewport where it is. */
    function setContentEnd(contentEndPx: number) {
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        value: contentEndPx + VIEWPORT + TAIL_SPACER,
      });
    }

    /**
     * Mount a following transcript, then have the reader take the viewport from
     * `blankPx` into the reserved blank — `0` being the end of real content, on
     * the viewport's bottom edge. Returns the one-shot scroll, so a test can
     * assert nothing reached for it.
     */
    function departWithBlank(blankPx: number) {
      const scrollToContentEnd = vi.fn();
      setScrollerMetrics(scroller, {
        scrollHeight: CONTENT_END + VIEWPORT + TAIL_SPACER,
        clientHeight: VIEWPORT,
        scrollTop: CONTENT_END,
      });
      act(() => {
        root.render(
          <Harness
            latestTurnId="turn-1"
            scroller={scroller}
            scrollToContentEnd={scrollToContentEnd}
            onController={next => { controller = next; }}
            onViewportOwner={next => { viewportOwner = next; }}
          />,
        );
      });
      expect(controller?.isFollowingOutput).toBe(true);
      scrollToContentEnd.mockClear();
      frames.length = 0;

      scroller.scrollTop = CONTENT_END + blankPx;
      act(() => controller?.handleUserScrollIntent());
      expect(controller?.isFollowingOutput).toBe(false);
      return scrollToContentEnd;
    }

    it('takes the viewport back when output fills the blank under a stationary reader', () => {
      departWithBlank(100);

      // The resize observer's signal, which is the only one that arrives when
      // the content moves and the reader does not.
      setContentEnd(CONTENT_END + 150);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(true);
    });

    it('resumes where the reader is instead of scrolling them to the end', () => {
      const scrollToContentEnd = departWithBlank(100);
      setContentEnd(CONTENT_END + 150);
      act(() => controller?.scheduleFollowToLatest());

      // Nothing to travel that the follow loop is not already about to cover:
      // the blank closing *is* the two offsets meeting. What is left is the one
      // sample of growth that closed it, and the loop eases that away — a
      // quarter of the 50px on the first frame it runs, which is the one the
      // resume's own re-render asks for.
      expect(scrollToContentEnd).not.toHaveBeenCalled();
      expect(scroller.scrollTop).toBe(CONTENT_END + 100 + 50 * TAIL_EASE_ALPHA);
    });

    it('leaves the viewport with a reader whose hand is still on it', () => {
      /*
       * Measured: 320ms into a live gesture, a reader had climbed 200px while
       * content grew 237, so the crossing was attributed to the content — which
       * is correct, and acting on it would still have been wrong.
       */
      departWithBlank(400);
      viewportOwner?.claim('user-gesture', { holdForMs: USER_DRIVEN_SCROLL_WINDOW_MS });

      scroller.scrollTop = CONTENT_END + 200;
      setContentEnd(CONTENT_END + 237);
      act(() => controller?.handleScroll());

      expect(controller?.isFollowingOutput).toBe(false);
    });

    it('leaves a reader who climbed out past the content end reading history', () => {
      departWithBlank(100);

      scroller.scrollTop = CONTENT_END - 300;
      act(() => controller?.handleScroll());
      // Output arriving afterwards must not fetch them back down.
      setContentEnd(CONTENT_END + 150);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(false);
    });

    it('leaves a reader who was never in the blank where they are', () => {
      // Nothing crossed: they were above the end of content when they took the
      // viewport and they are still above it. Only a transition is a question.
      departWithBlank(0);

      setContentEnd(CONTENT_END + 150);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(false);
    });

    it('follows a reader who left the blank and came back down into it', () => {
      /*
       * The case a per-departure watch got wrong, and the reason the watch runs
       * for as long as the reader holds the viewport. Measured as a report:
       * scroll up until the blank is gone, scroll back down until it shows
       * again, wait — and nothing happened, because the one crossing the watch
       * was given had been spent on the way up.
       */
      departWithBlank(400);

      // Up and out of the blank entirely.
      scroller.scrollTop = CONTENT_END - 200;
      act(() => controller?.handleScroll());
      expect(controller?.isFollowingOutput).toBe(false);

      // Back down until the blank is on screen again, and stop.
      scroller.scrollTop = CONTENT_END + 250;
      act(() => controller?.handleScroll());
      expect(controller?.isFollowingOutput).toBe(false);

      setContentEnd(CONTENT_END + 250);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(true);
    });

    it('watches a reader who took the viewport from a follow that was already gone', () => {
      // Every wheel notch exits, and only the first finds follow to give up.
      // Gating the watch on that notch left the rest of the gesture unwatched.
      departWithBlank(0);
      act(() => controller?.handleUserScrollIntent());

      scroller.scrollTop = CONTENT_END + 250;
      act(() => controller?.handleScroll());
      setContentEnd(CONTENT_END + 250);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(true);
    });

    it('reads nothing into a viewport a history prepend has just shifted', () => {
      /*
       * Measured: a session opened on three Turns, one scroll up paged the whole
       * seven, and the prepend shifted the viewport 14252px to hold the reader's
       * Turn still — before those heights were in the scroll range, so the blank
       * between the two read as 6239px against a spacer of a few hundred. Taken
       * at face value that is a reader sitting deep in the blank, which is the
       * one state this rule acts on, and the next sample would have pulled them
       * out of the history they had just asked for.
       */
      departWithBlank(0);

      // The compensation: the viewport moves, the content end has not caught up.
      scroller.scrollTop = CONTENT_END + TAIL_SPACER + 5_000;
      act(() => controller?.handleScroll());
      // ...and now it has. Nothing crossed, because nothing was ever measured.
      setContentEnd(CONTENT_END + TAIL_SPACER + 5_000);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(false);
    });

    it('judges a vetoed crossing again rather than spending it', () => {
      /*
       * The veto is about the reader's hand being on the wheel, not about the
       * crossing being wrong. Deferring costs one sample; settling it would cost
       * the whole episode.
       */
      departWithBlank(400);
      viewportOwner?.claim('user-gesture', { holdForMs: USER_DRIVEN_SCROLL_WINDOW_MS });

      setContentEnd(CONTENT_END + 400);
      act(() => controller?.scheduleFollowToLatest());
      expect(controller?.isFollowingOutput).toBe(false);

      // The claim lapses, the reader has not moved, and output is still coming.
      viewportOwner?.release('user-gesture');
      setContentEnd(CONTENT_END + 420);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(true);
    });

    it('lets a reader who kept climbing through a vetoed crossing go', () => {
      departWithBlank(400);
      viewportOwner?.claim('user-gesture', { holdForMs: USER_DRIVEN_SCROLL_WINDOW_MS });

      setContentEnd(CONTENT_END + 400);
      act(() => controller?.scheduleFollowToLatest());
      expect(controller?.isFollowingOutput).toBe(false);

      // Still climbing, and now out-moving the content: the deferred crossing
      // resolves against them, and the latch is spent for good.
      scroller.scrollTop = CONTENT_END + 100;
      setContentEnd(CONTENT_END + 410);
      act(() => controller?.handleScroll());
      viewportOwner?.release('user-gesture');
      setContentEnd(CONTENT_END + 430);
      act(() => controller?.scheduleFollowToLatest());

      expect(controller?.isFollowingOutput).toBe(false);
    });

    it('keeps watching while the blank is only partly filled', () => {
      departWithBlank(400);

      setContentEnd(CONTENT_END + 150);
      act(() => controller?.scheduleFollowToLatest());
      expect(controller?.isFollowingOutput).toBe(false);

      setContentEnd(CONTENT_END + 400);
      act(() => controller?.scheduleFollowToLatest());
      expect(controller?.isFollowingOutput).toBe(true);
    });
  });
});
