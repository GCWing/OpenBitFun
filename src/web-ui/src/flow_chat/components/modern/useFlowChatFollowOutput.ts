import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  isViewportDiagnosticsEnabled,
  roundViewportPx,
  traceViewport,
  traceViewportRepeating,
} from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
import {
  isTailFollowDiagnosticsEnabled,
  noteTailFollowStep,
} from '@/infrastructure/diagnostics/flowChatTailFollowDiagnostics';
import {
  nextEasedScrollTopPx,
  shouldEaseTailFollow,
} from '../../utils/flowChatTailEase';
import { getMotionAwareScrollBehavior } from '../../utils/motionPreference';
import type { FlowChatViewportOwnerApi } from './useFlowChatViewportOwner';
import {
  contentEndScrollTop,
  FLOWCHAT_AT_CONTENT_END_THRESHOLD_PX,
  isTailBlankMeasurable,
  nextTailFollowState,
  resolveAnimatedJumpBehavior,
  resolveTailDepartureCrossing,
  shouldResumeFollowAfterDeparture,
  tailHoldMaxGapPx,
  type TailFollowState,
} from './flowChatTailFollow';

export type FollowOutputEnterReason =
  | 'jump-to-latest'
  | 'new-turn'
  | 'session-open'
  | 'streaming-resumed'
  | 'tail-caught-up'
  | 'turns-rolled-back';
export type FollowOutputExitReason =
  | 'session-changed'
  | 'user-scroll'
  | 'scroll-to-turn'
  | 'scroll-to-index';

/**
 * Why a watch over a reader who owns the viewport ended.
 *
 * These are follow taking it back, a reader replacing a reveal, or the
 * transcript going away. A *crossing* is deliberately not on this list: the
 * reader can climb out of the reserved blank and scroll back down into it any
 * number of times before either happens, and each is another chance for output
 * to catch up with them.
 */
type TailWatchOutcome =
  /** Something handed the viewport back — a new Turn, a jump, a snap, this. */
  | 'followed-again'
  | 'navigated'
  | 'reader-took-over'
  | 'session-changed'
  | 'unmounted';

type TailWatchOrigin = 'new-turn-reveal' | 'user-departure';

interface UseFlowChatFollowOutputOptions {
  activeSessionId?: string;
  latestTurnId: string | null;
  /**
   * Turns in the session ledger, so that an arrival can be told from a
   * truncation. `latestTurnId` alone cannot: a rollback moves it backwards to a
   * Turn that has been there all along, which is a change and not an arrival.
   */
  dialogTurnCount: number;
  virtualItemCount: number;
  isStreaming: boolean;
  isViewportActive: boolean;
  /** Restored history presentations must not start by pinning the tail. */
  startAtTailOnMount?: boolean;
  /** The native host has temporarily withdrawn the scroller from layout. */
  isViewportSuspended?: () => boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Height of the resident tail spacer currently rendered below the content. */
  getTailSpacerPx: () => number;
  /** One-shot scroll placing the end of real content at the viewport bottom. */
  scrollToContentEnd: (behavior: ScrollBehavior) => void;
  /** Reveal a rendered new Turn by placing the viewport at the physical bottom once. */
  revealNewTurnTail: (turnId: string) => boolean;
  /** True while the transcript is still hidden for the opening reveal. */
  isOpeningViewport: () => boolean;
  /** Immediate position readback after an opening follow correction. */
  onOpeningOffset?: (actualOffsetPx: number) => void;
  /**
   * Who is moving the viewport. Every write below goes through it, so that
   * nothing else has to carry a private opinion about when this hook is busy.
   */
  viewportOwner: FlowChatViewportOwnerApi;
  /**
   * Which transcript this hook belongs to, for the trail only.
   *
   * The list is keyed on the session, so every switch is a fresh instance with
   * a fresh scroller — and two of them can overlap, or a second pane can hold
   * one of its own. Read on its own, `followOutput.enter` followed by a
   * boundary ask that passes the "is follow following" gate reads as an exit
   * that left no trace; with this it reads as two instances, which is a
   * different fault entirely.
   */
  viewportId?: number;
}

export interface ViewportResizeInput {
  /** Change in the scroller's client height; `0` on a reflow-only callback. */
  viewportHeightDeltaPx: number;
  /**
   * Whether the viewport was resting at the end of the transcript *before* the
   * resize. Afterwards that is unknowable — a viewport on the content end and
   * one parked deliberately above it are the same geometry.
   */
  wasAtTail: boolean;
}

interface UseFlowChatFollowOutputResult {
  isFollowingOutput: boolean;
  enterFollowOutput: (reason: FollowOutputEnterReason) => void;
  exitFollowOutput: (reason: FollowOutputExitReason) => void;
  scheduleFollowToLatest: () => void;
  /** Whether follow-output owns the viewport now, not one render ago. */
  isFollowingOutputNow: () => boolean;
  /**
   * Whether the frame loop is actively moving the viewport right now.
   *
   * Not the same question as ownership, which outlives the loop on purpose so
   * that streaming can resume following after the settle budget runs out.
   */
  isFollowCorrectingViewport: () => boolean;
  handleUserScrollIntent: () => void;
  /** Turns were rolled back out of the session; end on the new tail. */
  handleTurnsRolledBack: () => void;
  handleScroll: () => void;
  /**
   * The viewport was resized; keep whatever was on the bottom edge there.
   */
  handleViewportResize: (input: ViewportResizeInput) => void;
  /** Offset the follow rule owns, or `null` when it does not own the viewport. */
  getFollowTargetScrollTop: () => number | null;
}

const BOTTOM_EPSILON_PX = 2;

/**
 * How long a programmatic smooth scroll of ours may own the viewport before the
 * follow loop resumes writing.
 *
 * The loop assigns `scrollTop` outright, which cancels an in-flight smooth
 * scroll on the very next frame — every `'smooth'` request in this hook was in
 * practice a jump until it yielded.
 *
 * A backstop rather than the actual terminator: the yield normally ends when
 * the animation stops moving the viewport, and this only covers an animation
 * that never finishes at all. It was a *frame* count and could not be — 45
 * frames is 0.75s at 60Hz and 0.52s on a busy 200Hz display, so the duration a
 * caller was buying depended on the machine. Measured: a jump to latest issued
 * for 8717px animated 5480 of them and was finished by the loop in one 3290px
 * write, 38% short.
 */
const SMOOTH_SCROLL_YIELD_MS = 1_200;

/**
 * How long the viewport may sit still before our animated scroll counts as over.
 *
 * A duration and not a frame count, for the same reason the backstop above is:
 * this was two frames, and two frames is 33ms at 60Hz and 10ms at 200Hz, where
 * a smooth scroll has not visibly started. Measured on WebView2: a jump issued
 * for 9734px was taken back 21ms after it was asked for, having animated
 * nothing at all, and the reader saw an instant jump where the whole point was
 * an animation.
 *
 * The number comes from the shape of the curve rather than from the platform's
 * startup latency, which is the shorter of the two. A programmatic smooth
 * scroll eases in: measured, 2px in its first 50ms against 9734px to travel.
 * With scroll offsets quantised to 0.8px on that display, the early frames
 * genuinely do not move, and visible increments arrive up to ~40ms apart. This
 * is that, doubled.
 *
 * What it costs is the follow resuming this late after an animation that ends
 * somewhere other than its target — which only happens while streaming moves
 * the target underneath it, and is then a dozen pixels the ease absorbs.
 * Arriving ends the yield immediately and does not wait for this.
 */
export const SMOOTH_SCROLL_STALL_MS = 120;

/**
 * Frames the follow target keeps being re-asserted after a non-streaming entry,
 * refreshed whenever it actually moves.
 *
 * A session opens against an unsettled transcript: item heights are still
 * estimates and `isPartial` sessions page older Turns in, so the end of content
 * can travel thousands of pixels after the first alignment. The browser used to
 * absorb that for free — a bottom-aligned scroll was clamped at `scrollHeight -
 * clientHeight`, so any target at or past the end snapped onto it. The resident
 * tail spacer removes that clamp, so the settle has to be explicit.
 */
const SETTLE_FRAMES = 90;

export function useFlowChatFollowOutput({
  activeSessionId,
  latestTurnId,
  dialogTurnCount,
  virtualItemCount,
  isStreaming,
  isViewportActive,
  startAtTailOnMount = true,
  isViewportSuspended = () => false,
  scrollerRef,
  getTailSpacerPx,
  scrollToContentEnd,
  revealNewTurnTail,
  isOpeningViewport,
  onOpeningOffset,
  viewportOwner,
  viewportId = 0,
}: UseFlowChatFollowOutputOptions): UseFlowChatFollowOutputResult {
  const [isFollowingOutput, setIsFollowingOutput] = useState(false);
  const isFollowingOutputRef = useRef(false);
  const isStreamingRef = useRef(isStreaming);
  const isViewportActiveRef = useRef(isViewportActive);
  const latestTurnIdRef = useRef(latestTurnId);
  const isViewportSuspendedRef = useRef(isViewportSuspended);
  isViewportSuspendedRef.current = isViewportSuspended;
  const onOpeningOffsetRef = useRef(onOpeningOffset);
  onOpeningOffsetRef.current = onOpeningOffset;
  const followFrameRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef(activeSessionId);
  const previousLatestTurnIdRef = useRef<string | null>(latestTurnId);
  const previousDialogTurnCountRef = useRef(dialogTurnCount);
  const hasMountedRef = useRef(false);
  const wasStreamingRef = useRef(isStreaming);

  const followStateRef = useRef<TailFollowState>({ target: 0 });
  const followPhaseRef = useRef<'idle' | 'revealing-tail' | 'following-tail'>('idle');
  /**
   * A Turn that arrived while it was not in the transcript on screen.
   *
   * Submitting from inside a history window is the case: the session gains the
   * Turn a beat before the presentation is restored to the live tail, so the
   * one moment the arrival is *detectable* is not a moment it can be answered.
   * The answer is deferred rather than dropped — kept until the Turn can
   * actually be revealed, which is what the reader is waiting to see.
   */
  const pendingNewTurnIdRef = useRef<string | null>(null);
  const settleFramesRef = useRef(0);
  /** When the yield to our own animated scroll lapses, if it has not ended. */
  const smoothScrollUntilMsRef = useRef(0);
  /** Where the viewport was on the previous frame of that yield. */
  const smoothScrollLastTopRef = useRef(0);
  /** When that yield last saw the viewport move, which is what ends it. */
  const smoothScrollLastMoveAtMsRef = useRef(0);
  /** Where the animation started, so the trace can say how far it got. */
  const smoothScrollFromPxRef = useRef(0);

  /*
   * Deliberately *not* mirrored from `isFollowingOutput` here.
   *
   * Every other ref on this line is a prop, and a prop is whatever the render
   * that assigned it was given — consistent by construction. Ownership is not:
   * it is written imperatively by `enterFollowOutput` and `exitFollowOutput`,
   * and the state is only how the rest of the component hears about it. Between
   * the two, React is free to render the value from *before* the update — an
   * update scheduled from a passive effect sits at a lower priority than a
   * synchronous render, which then renders without it — and the assignment took
   * ownership away from a writer that had just taken it, with nothing anywhere
   * saying so.
   *
   * Measured on session open, which is the entry that comes from a mount
   * effect and so hits this every time: `followOutput.enter` recorded at 31976,
   * the first frame of the loop stood down 345ms later with `not-following` and
   * its 90-frame budget untouched, and no `followOutput.exit` in the trail
   * because nothing exited. The register still held `follow-output`, so the
   * 22301px prepend that landed in between was left to a writer that was no
   * longer running — `followTargetPx: null` while `heldBy: follow-output` — and
   * the session was revealed at offset 0 of a window starting eight Turns above
   * the tail.
   */
  isStreamingRef.current = isStreaming;
  isViewportActiveRef.current = isViewportActive;
  latestTurnIdRef.current = latestTurnId;

  const stopFollowFrame = useCallback(() => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
  }, []);

  /**
   * Whether the frame loop is actively moving the viewport.
   *
   * Ownership is the other question and outlives this one: the loop stops once
   * the settle budget runs out, and follow keeps the viewport so that streaming
   * can resume. Reading ownership as "something is correcting this" hands the
   * viewport to a loop that is not running — measured, a drag came to rest
   * 813px into the reserved blank with `isFollowingOutput` true, the loop
   * asleep, and nothing to bring it back.
   */
  const isFollowCorrectingViewport = useCallback(() => (
    isFollowingOutputRef.current && followFrameRef.current !== null
  ), []);

  const readContentEndScrollTop = useCallback((scroller: HTMLElement) => (
    contentEndScrollTop({
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      tailSpacerPx: getTailSpacerPx(),
    })
  ), [getTailSpacerPx]);

  /**
   * The state the follow rule would hold for the current geometry, ignoring any
   * offset it was holding. Used to resolve explicit follow targets and to
   * resume on the live content end.
   */
  const resolveFollowState = useCallback((scroller: HTMLElement): TailFollowState => {
    const desired = readContentEndScrollTop(scroller);
    return { target: desired };
  }, [readContentEndScrollTop]);

  const resolveFollowTargetScrollTop = useCallback((scroller: HTMLElement) => (
    resolveFollowState(scroller).target
  ), [resolveFollowState]);

  /*
   * ---------------------------------------------------------------------------
   * A viewport in the reader's hands, watched for output catching up with them.
   *
   * The same crossing has two origins. A new Turn reveal deliberately starts in
   * the resident blank while follow-output still owns the viewport; a user
   * departure starts after a gesture releases it. In both cases output reaching
   * the fixed viewport bottom is the event that may start ordinary tail follow.
   *
   * "Still looking at the blank" is `scrollTop > contentEnd`, because
   * `contentEnd` is by definition the offset that puts the end of real content
   * on the viewport's bottom edge. This watch only handles output catching up
   * with a stationary reader; it never turns a user's resting position into a
   * follow target.
   *
   * The watch therefore runs for as long as the reader holds the viewport, not
   * for one crossing. `blankWasVisible` is the whole state it keeps between
   * samples, and the rule is the obvious one: the blank was on screen and now it
   * is not. Scoping it to a single crossing was tried and is wrong — a reader
   * who climbs out of the blank, reads for a while and scrolls back down to sit
   * in it again is in exactly the position the rule exists for, and had already
   * spent the one crossing it was given.
   *
   * `content-caught-up` is what hands the viewport back, subject to
   * `shouldResumeFollowAfterDeparture`; `reader-left-blank` is a reader who
   * really did go and read history, and only clears the latch. Both raw deltas
   * and the gesture claim are traced at each crossing rather than only the
   * verdict, so the tie-break can still be revisited from a trail.
   * ---------------------------------------------------------------------------
   */
  const tailWatchRef = useRef<{
    origin: TailWatchOrigin;
    openedAtMs: number;
    /** Blank on screen when the watch opened. */
    exitBlankPx: number;
    exitScrollTopPx: number;
    exitContentEndPx: number;
    exitStreaming: boolean;
    /** Previous sample, so a crossing can be attributed to whatever moved. */
    lastScrollTopPx: number;
    lastContentEndPx: number;
    /** Whether the reserved blank was on screen as of the previous sample. */
    blankWasVisible: boolean;
    samples: number;
    crossings: number;
  } | null>(null);

  const closeTailWatch = useCallback((
    outcome: TailWatchOutcome,
    extra?: Record<string, unknown>,
  ) => {
    const watch = tailWatchRef.current;
    if (!watch) return;
    tailWatchRef.current = null;
    const scroller = scrollerRef.current;
    const scrollTopPx = scroller?.scrollTop ?? watch.lastScrollTopPx;
    const contentEndPx = scroller
      ? readContentEndScrollTop(scroller)
      : watch.lastContentEndPx;
    traceViewport({
      location: 'followOutput.tailWatchEnded',
      message: outcome === 'reader-took-over'
        ? 'the reader replaced the passive new Turn reveal'
        : 'the tail watch ended',
      data: () => ({
        outcome,
        origin: watch.origin,
        viewportId,
        forMs: Math.round(performance.now() - watch.openedAtMs),
        samples: watch.samples,
        crossings: watch.crossings,
        blankAtExitPx: roundViewportPx(watch.exitBlankPx),
        blankNowPx: roundViewportPx(scrollTopPx - contentEndPx),
        // The two movements, over the whole life of the watch.
        contentGrewPx: roundViewportPx(contentEndPx - watch.exitContentEndPx),
        readerMovedPx: roundViewportPx(scrollTopPx - watch.exitScrollTopPx),
        streamingAtExit: watch.exitStreaming,
        streamingNow: isStreamingRef.current,
        ...(extra ?? {}),
      }),
    });
  }, [readContentEndScrollTop, scrollerRef, viewportId]);
  /*
   * Held by identity for the unmount cleanup below.
   *
   * That cleanup must run when the transcript goes away and at no other time,
   * and depending on the callback would instead run it whenever the callback is
   * rebuilt — which is whenever `getTailSpacerPx` changes identity, and so
   * potentially on every render of whoever owns this hook. A watch lives for as
   * long as the reader keeps the viewport and spans many renders by
   * construction, so an effect that tears down with the callback closes every
   * one of them a frame after it opens.
   */
  const closeTailWatchRef = useRef(closeTailWatch);
  closeTailWatchRef.current = closeTailWatch;

  /**
   * Start watching a viewport the reader has taken.
   *
   * Opened whether or not blank is on screen at the time. Where the reader was
   * standing when they took it settles nothing — they can scroll down into the
   * blank at any point afterwards, and the whole question is where they are when
   * output next reaches the bottom edge.
   */
  const openTailWatch = useCallback((origin: TailWatchOrigin) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const contentEndPx = readContentEndScrollTop(scroller);
    const blankPx = scroller.scrollTop - contentEndPx;
    traceViewport({
      location: 'followOutput.tailWatch',
      message: origin === 'new-turn-reveal'
        ? 'the new Turn is revealed in the blank and watched for output catching up'
        : 'the reader has the viewport and is watched for output catching up',
      data: () => ({
        origin,
        viewportId,
        blankPx: roundViewportPx(blankPx),
        blankVisible: blankPx > 0,
        scrollTopPx: roundViewportPx(scroller.scrollTop),
        contentEndPx: roundViewportPx(contentEndPx),
        clientHeightPx: scroller.clientHeight,
        isStreaming: isStreamingRef.current,
      }),
    });
    tailWatchRef.current = {
      origin,
      openedAtMs: performance.now(),
      exitBlankPx: blankPx,
      exitScrollTopPx: scroller.scrollTop,
      exitContentEndPx: contentEndPx,
      exitStreaming: isStreamingRef.current,
      lastScrollTopPx: scroller.scrollTop,
      lastContentEndPx: contentEndPx,
      blankWasVisible: blankPx > 0,
      samples: 0,
      crossings: 0,
    };
  }, [readContentEndScrollTop, scrollerRef, viewportId]);

  /**
   * Stand the frame loop down for an animated scroll this hook is about to
   * issue. Taken from the viewport as it is now, so the first frame of the
   * yield can tell travel from a stall.
   */
  const beginSmoothScrollYield = useCallback(() => {
    const nowMs = performance.now();
    smoothScrollUntilMsRef.current = nowMs + SMOOTH_SCROLL_YIELD_MS;
    smoothScrollLastMoveAtMsRef.current = nowMs;
    smoothScrollLastTopRef.current = scrollerRef.current?.scrollTop ?? 0;
    smoothScrollFromPxRef.current = smoothScrollLastTopRef.current;
  }, [scrollerRef]);

  /**
   * Take the viewport back, and say why.
   *
   * Every way this ends looks the same from outside — the follow simply starts
   * writing again — and they are not the same fact. `stalled` after no travel
   * at all is an animation that never ran, which is what a reader reports as
   * the jump to latest having lost its animation; the same reason after most
   * of the distance is the ordinary end of one.
   */
  const endSmoothScrollYield = useCallback((
    reason: 'arrived' | 'stalled' | 'backstop' | 'superseded',
  ) => {
    if (smoothScrollUntilMsRef.current !== 0 && reason !== 'superseded') {
      const travelledPx = (scrollerRef.current?.scrollTop ?? 0) - smoothScrollFromPxRef.current;
      traceViewportRepeating(`smoothYield|${reason}|${Math.abs(travelledPx) < 1}`, {
        location: 'followOutput.animatedScrollEnded',
        message: 'the frame loop took the viewport back from its own animation',
        travelPx: travelledPx,
        data: () => ({
          reason,
          travelledPx: roundViewportPx(travelledPx),
          fromPx: roundViewportPx(smoothScrollFromPxRef.current),
          scrollTopPx: roundViewportPx(scrollerRef.current?.scrollTop ?? 0),
        }),
      });
    }
    smoothScrollUntilMsRef.current = 0;
  }, [scrollerRef]);

  /**
   * Issue the one-shot content-end scroll, yielding the frame loop to it when
   * it is animated. Without the yield the next frame overwrites `scrollTop` and
   * the animation never plays.
   */
  const runContentEndScroll = useCallback((behavior: ScrollBehavior) => {
    const resolvedBehavior = getMotionAwareScrollBehavior(
      behavior === 'smooth' ? 'smooth' : 'auto',
    );
    if (resolvedBehavior === 'smooth') {
      beginSmoothScrollYield();
    } else {
      // An instant scroll of ours replaces whatever was travelling.
      endSmoothScrollYield('superseded');
    }
    scrollToContentEnd(resolvedBehavior);
  }, [beginSmoothScrollYield, endSmoothScrollYield, scrollToContentEnd]);

  /**
   * Decide how a jump to latest travels, and record the decision.
   *
   * Traced because the two outcomes are indistinguishable afterwards — an
   * animation that was never issued and one the loop cut short both end as a
   * viewport that arrived without moving through anything — and they call for
   * opposite fixes. This line says which one a reader is describing.
  */
  const resolveJumpBehavior = useCallback((scroller: HTMLElement, targetPx: number) => {
    const distanceBehavior = resolveAnimatedJumpBehavior({
      fromPx: scroller.scrollTop,
      targetPx,
      clientHeight: scroller.clientHeight,
    });
    const behavior = getMotionAwareScrollBehavior(distanceBehavior);
    const distancePx = Math.abs(targetPx - scroller.scrollTop);
    traceViewportRepeating(`follow|jumpBehavior|${behavior}`, {
      location: 'followOutput.jumpBehavior',
      message: behavior === 'smooth'
        ? 'the jump to latest is near enough to animate'
        : distanceBehavior === 'smooth'
          ? 'the jump to latest lands outright because reduced motion is enabled'
          : 'the jump to latest is too far to animate, so it lands outright',
      travelPx: targetPx - scroller.scrollTop,
      data: () => ({
        behavior,
        distanceBehavior,
        viewportId,
        distancePx: roundViewportPx(distancePx),
        viewports: scroller.clientHeight > 0
          ? Math.round((distancePx / scroller.clientHeight) * 10) / 10
          : null,
        clientHeightPx: scroller.clientHeight,
      }),
    });
    return behavior;
  }, [viewportId]);

  /** Move the viewport to whatever the follow state currently owns. */
  const applyFollowTarget = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || isViewportSuspendedRef.current()) {
      return;
    }

    const remembered = followStateRef.current;
    const desired = readContentEndScrollTop(scroller);
    /*
     * While the transcript is opening it is still hidden, so nothing is gained
     * by remembering an earlier offset: drop the memory and track the content
     * end exactly. The virtualizer writes `scrollTop` too during this window — it
     * compensates a history prepend from the item index before the prepended
     * heights reach the DOM — and any accommodation of that is both invisible
     * and, once paging stops, permanent. The gap tolerance is a *streaming*
     * allowance: blank below the live output is acceptable only because more
     * output is about to fill it.
     */
    const previous: TailFollowState = isOpeningViewport()
      ? { target: desired }
      : remembered;
    const next = nextTailFollowState(previous, {
      desiredScrollTop: desired,
      maxGapPx: tailHoldMaxGapPx(scroller.clientHeight, getTailSpacerPx()),
    });
    followStateRef.current = next;
    // Content is still moving, so keep the settle window open.
    if (Math.abs(next.target - previous.target) > BOTTOM_EPSILON_PX) {
      settleFramesRef.current = SETTLE_FRAMES;
    }

    let actualOffsetPx = scroller.scrollTop;
    let writeGranted = true;
    const onTarget = Math.abs(next.target - actualOffsetPx) <= BOTTOM_EPSILON_PX;
    /*
     * What the loop decided this frame, coalesced by the decision.
     *
     * A frame that writes nothing is the interesting one: it means the follow
     * rule believes the viewport is already where it belongs, and the reader is
     * looking at something else. Measured on a reopened session, that is the
     * whole fault — a history window arrived above a viewport at 0 during the
     * opening reveal, and whether the loop then aimed at the new content end or
     * was still reading an unmeasured 0 could not be told apart from outside.
     */
    if (isViewportDiagnosticsEnabled()) {
      // Guarded rather than left to the coalescer, which is the rule for
      // anything on this path: it runs on every frame of every follow, and even
      // the key would be a string built sixty times a second for a switch that
      // is off.
      traceViewportRepeating(
        `follow|frame|${onTarget}|${isOpeningViewport()}`,
        {
          location: 'followOutput.frame',
          message: onTarget
            ? 'the viewport is already on the offset the follow rule owns'
            : 'the follow rule is moving the viewport to the offset it owns',
          travelPx: next.target - scroller.scrollTop,
          data: () => ({
            viewportId,
            onTarget,
            phase: followPhaseRef.current,
            isOpening: isOpeningViewport(),
            desiredPx: roundViewportPx(desired),
            targetPx: roundViewportPx(next.target),
            scrollTopPx: roundViewportPx(scroller.scrollTop),
            scrollRangePx: roundViewportPx(scroller.scrollHeight),
            settleFrames: settleFramesRef.current,
            smoothYieldActive: smoothScrollUntilMsRef.current !== 0,
          }),
        },
      );
    }
    if (smoothScrollUntilMsRef.current !== 0) {
      /*
       * An animated scroll of ours is in flight and heading for this same
       * target. Track the state, but leave the writing to it.
       *
       * It ends when the viewport stops moving for `SMOOTH_SCROLL_STALL_MS`,
       * which is the animation's own answer rather than a guess at how long it
       * takes: the browser scales the duration with the distance, and a jump to
       * latest from the top of a transcript takes longer than anything else
       * this issues. Arriving ends it too, and sooner.
       */
      const nowMs = performance.now();
      if (scroller.scrollTop !== smoothScrollLastTopRef.current) {
        smoothScrollLastTopRef.current = scroller.scrollTop;
        smoothScrollLastMoveAtMsRef.current = nowMs;
      }
      if (onTarget) {
        endSmoothScrollYield('arrived');
      } else if (nowMs >= smoothScrollUntilMsRef.current) {
        endSmoothScrollYield('backstop');
      } else if (nowMs - smoothScrollLastMoveAtMsRef.current >= SMOOTH_SCROLL_STALL_MS) {
        endSmoothScrollYield('stalled');
      } else {
        return;
      }
      /*
       * The animation is over, and the target has moved on under it — it aims
       * at the offset it was issued for, and content arrives while it travels.
       * Falling through rather than returning is what covers that growth on
       * this frame instead of the next one.
       */
    }

    if (!onTarget) {
      const fromPx = scroller.scrollTop;
      /*
       * Eased across the frames the follow already has, rather than written in
       * one step.
       *
       * The target moves when Markdown reflows, which is a whole line at a
       * time with nothing in between, so an outright write spends a line of
       * travel on one frame out of seven. This spends the same distance over
       * all seven. It buys latency, not speed: under steady growth the offset
       * settles where its per-frame catch-up equals the growth, so the step
       * converges on the content's growth per frame whatever the fraction is.
       *
       * Only the *write* is eased. `followStateRef` still holds the true
       * target, so the settle budget and the at-tail band both
       * keep reading the offset the follow rule owns rather than how far
       * behind its own ease is riding.
       *
       * Not while the transcript is opening. There the target is authoritative
       * and the transcript is hidden, so an ease would only make the reveal
       * wait for travel nobody can see — and the reveal is watching for the
       * viewport to reach the content end.
       */
      const step = !isOpeningViewport() && shouldEaseTailFollow({
        scrollHeightPx: scroller.scrollHeight,
        clientHeightPx: scroller.clientHeight,
      })
        ? nextEasedScrollTopPx(fromPx, next.target)
        : { offsetPx: next.target, outcome: 'snapped' as const };
      writeGranted = viewportOwner.write({ owner: 'follow-output', topPx: step.offsetPx });
      /*
       * Read back rather than taken from the step. The register can refuse
       * this write outright, and a refused follow moves nothing — believing
       * the step there would report a follow that is being outranked as the
       * smoothest one in the session, and would book the frame below forever
       * over travel that never happens.
       */
      actualOffsetPx = scroller.scrollTop;
      const movedPx = actualOffsetPx - fromPx;
      /*
       * An ease in flight is a reason to run again, and the only one it has
       * once the target stops moving: the budget is refreshed by the *target*
       * travelling, so a correction arriving on the last frame of a settle
       * would otherwise be abandoned partway. Bounded by the ease itself,
       * which halves what is left every frame and is inside `BOTTOM_EPSILON_PX`
       * within a handful of them.
       */
      if (step.outcome === 'eased' && movedPx !== 0) {
        settleFramesRef.current = Math.max(settleFramesRef.current, 1);
      }
      if (isTailFollowDiagnosticsEnabled()) {
        noteTailFollowStep('list', {
          stepPx: movedPx,
          lagPx: next.target - fromPx,
          innerScroll: true,
          snapped: step.outcome === 'snapped',
        });
      }
    }
    // Native scroll delivery can lag a frame behind this write. Publish the
    // DOM readback through the existing virtualizer observer channel so range
    // selection catches up in the same task without a synchronous flush.
    if (writeGranted && isOpeningViewport() && isFollowingOutputRef.current
      && followPhaseRef.current === 'following-tail' && isViewportActiveRef.current
      && !document.hidden && viewportOwner.currentOwner() === 'follow-output') {
      onOpeningOffsetRef.current?.(actualOffsetPx);
    }
  }, [
    endSmoothScrollYield,
    getTailSpacerPx,
    isOpeningViewport,
    readContentEndScrollTop,
    scrollerRef,
    viewportId,
    viewportOwner,
  ]);

  const runFollowFrame = useCallback(() => {
    followFrameRef.current = null;
    /*
     * Why the loop is not running, which the trail could not say.
     *
     * "The session opened on the wrong Turn" has looked identical from outside
     * whether follow was refused the viewport, was never following, or simply
     * ran out of budget — all three are a viewport that stops where it was left
     * and a log with nothing in it after `followOutput.enter`. Measured on a
     * reopened session: `enter` at session-open, a history window prepended
     * 22317px above 136ms later, and not one write for the next half second.
     */
    const standDownReason = !isFollowingOutputRef.current
      ? 'not-following'
      : followPhaseRef.current !== 'following-tail'
        ? 'revealing-tail'
      : !isViewportActiveRef.current
        ? 'viewport-inactive'
        : isViewportSuspendedRef.current()
          ? 'viewport-suspended'
        : document.hidden
          ? 'document-hidden'
          : (!isStreamingRef.current && settleFramesRef.current <= 0)
            // Streaming holds the loop open indefinitely; anything else runs
            // only until the transcript stops moving.
            ? 'settle-exhausted'
            : null;
    if (standDownReason !== null) {
      traceViewportRepeating(`follow|standDown|${standDownReason}`, {
        location: 'followOutput.frameStoodDown',
        message: 'the follow loop stopped running',
        data: () => ({
          reason: standDownReason,
          viewportId,
          settleFrames: settleFramesRef.current,
          isStreaming: isStreamingRef.current,
          isOpening: isOpeningViewport(),
          followTargetPx: roundViewportPx(followStateRef.current.target),
          scrollTopPx: roundViewportPx(scrollerRef.current?.scrollTop ?? 0),
        }),
      });
      return;
    }
    if (!isStreamingRef.current) {
      settleFramesRef.current -= 1;
    }

    applyFollowTarget();
    followFrameRef.current = requestAnimationFrame(runFollowFrame);
  }, [applyFollowTarget, isOpeningViewport, scrollerRef, viewportId]);

  const startFollowFrame = useCallback(() => {
    if (
      followFrameRef.current === null &&
      isFollowingOutputRef.current &&
      followPhaseRef.current === 'following-tail' &&
      !isViewportSuspendedRef.current() &&
      (isStreamingRef.current || settleFramesRef.current > 0)
    ) {
      followFrameRef.current = requestAnimationFrame(runFollowFrame);
    }
  }, [runFollowFrame]);

  const enterFollowOutput = useCallback((reason: FollowOutputEnterReason) => {
    if (!isViewportActiveRef.current) {
      /*
       * The one way this hook can decline to take the viewport and leave no
       * trace at all — and it leaves the transcript with no continuous writer
       * for the rest of its life, because nothing asks again until a Turn
       * arrives or the session changes. A second pane holding an inactive copy
       * of the same transcript looks exactly like this from the trail.
       */
      traceViewportRepeating(`follow|enterDeclined|${reason}`, {
        location: 'followOutput.enterDeclined',
        message: 'follow-output was asked for a viewport that is not active',
        data: () => ({
          reason,
          viewportId,
          scrollTopPx: roundViewportPx(scrollerRef.current?.scrollTop ?? 0),
        }),
      });
      return;
    }

    if (reason === 'jump-to-latest' && followPhaseRef.current === 'revealing-tail') {
      traceViewportRepeating('follow|jumpIgnored|revealing-tail', {
        location: 'followOutput.jumpIgnored',
        message: 'jump to latest was already satisfied by the new Turn reveal',
        data: () => ({ viewportId }),
      });
      return;
    }

    /* A new Turn may arrive before the live-tail projection contains it. The
     * one detectable arrival is retained until its one-shot reveal can run. */
    const revealTurnId = reason === 'new-turn' ? latestTurnIdRef.current : null;
    const revealedNewTurn = revealTurnId !== null && revealNewTurnTail(revealTurnId);
    if (reason === 'new-turn') {
      pendingNewTurnIdRef.current = revealedNewTurn ? null : revealTurnId;
      if (!revealedNewTurn) {
        /*
         * The viewport is deliberately left exactly as it was, so the only
         * evidence that a submission was answered at all is this line. A
         * deferral with no `followOutput.enter` after it is the reader's
         * "nothing happened when I sent a message".
         */
        traceViewportRepeating('follow|deferred-new-turn', {
          location: 'followOutput.deferNewTurn',
          message: 'new Turn is not in the transcript on screen yet, so the reveal waits',
          data: () => ({ turnId: revealTurnId }),
        });
        return;
      }
    }

    isFollowingOutputRef.current = true;
    setIsFollowingOutput(true);
    // Whatever this entry is, follow has the viewport, so there is nothing left
    // to watch for. The crossing route comes through here too, having already
    // traced why.
    closeTailWatch('followed-again', { enterReason: reason });
    settleFramesRef.current = SETTLE_FRAMES;
    traceViewportRepeating(`follow|enter|${reason}`, {
      location: 'followOutput.enter',
      message: 'follow-output took the viewport',
      data: () => ({
        reason,
        viewportId,
        phase: revealedNewTurn ? 'revealing-tail' : 'following-tail',
        isStreaming: isStreamingRef.current,
        scrollTopPx: roundViewportPx(scrollerRef.current?.scrollTop ?? 0),
      }),
    });
    /*
     * Ownership is taken here rather than at each write, because following is
     * continuous: between two frames of the loop the viewport is still ours,
     * and a correction slipping into that gap is the thing this prevents. A
     * refused claim is not a reason to stop following — the loop keeps its
     * state and simply writes nothing until whoever outranks it is done.
     */
    viewportOwner.claim('follow-output');

    const scroller = scrollerRef.current;
    const contentEnd = scroller ? readContentEndScrollTop(scroller) : 0;

    if (revealedNewTurn && scroller && scroller.scrollTop > contentEnd) {
      followPhaseRef.current = 'revealing-tail';
      endSmoothScrollYield('superseded');
      followStateRef.current = { target: scroller.scrollTop };
      stopFollowFrame();
      openTailWatch('new-turn-reveal');
      return;
    }

    followPhaseRef.current = 'following-tail';
    followStateRef.current = { target: contentEnd };
    {
      /*
       * Output that caught up with a stationary reader is already at the end —
       * the blank between them closing is what raised this — so the whole
       * distance left is one sample of growth, and the frame loop's ease covers
       * it on the next few frames. A one-shot scroll would spend that as a snap
       * the reader can see, for a correction they cannot.
       */
      if (reason !== 'tail-caught-up') {
        /*
         * Only a jump to latest is ever a candidate for an animation, and only
         * a near one. Every other entry reason is the transcript resuming a
         * follow it already owned, where an animation would be a movement the
         * reader did not ask for.
         */
        runContentEndScroll(
          reason === 'jump-to-latest' && scroller
            ? resolveJumpBehavior(scroller, contentEnd)
            : 'auto',
        );
      }
    }

    startFollowFrame();
  }, [
    viewportOwner,
    closeTailWatch,
    endSmoothScrollYield,
    openTailWatch,
    readContentEndScrollTop,
    revealNewTurnTail,
    resolveJumpBehavior,
    runContentEndScroll,
    scrollerRef,
    startFollowFrame,
    stopFollowFrame,
    viewportId,
  ]);

  /** Release the viewport. A user gesture replaces any reveal watch with a reader watch. */
  const exitFollowOutput = useCallback((reason: FollowOutputExitReason) => {
    /*
     * Traced whether or not there was anything to give up. An exit that finds
     * follow already released is the answer to "who ended the follow this
     * session opened with" being nobody — and gating the line on ownership is
     * what made that case indistinguishable from the exit never being reached.
     */
    traceViewportRepeating(`follow|exit|${reason}|${isFollowingOutputRef.current}`, {
      location: 'followOutput.exit',
      message: isFollowingOutputRef.current
        ? 'follow-output gave the viewport up'
        : 'follow-output was released while it held nothing',
      data: () => ({
        reason,
        viewportId,
        wasFollowing: isFollowingOutputRef.current,
        phase: followPhaseRef.current,
        scrollTopPx: roundViewportPx(scrollerRef.current?.scrollTop ?? 0),
      }),
    });
    isFollowingOutputRef.current = false;
    followPhaseRef.current = 'idle';
    setIsFollowingOutput(false);
    endSmoothScrollYield('superseded');
    viewportOwner.release('follow-output');
    stopFollowFrame();

    /*
     * A watch is open exactly while the reader holds the viewport, which is what
     * every branch below maintains. `wasFollowing` is deliberately not the gate:
     * this runs on every wheel notch rather than once per gesture, so gating on
     * it would open a watch on the notch that took the viewport and nowhere
     * else, and any exit that found follow already released — a reader scrolling
     * on from a navigation, say — would be watched by nothing.
     *
     * Re-opening is what must not happen instead. The offsets a crossing is
     * judged against are the previous sample's, and re-baselining them halfway
     * through the gesture being judged is how a reader climbing steadily reads
     * as one standing still.
     */
    if (reason === 'session-changed') {
      closeTailWatch('session-changed');
      return;
    }
    if (reason === 'scroll-to-turn' || reason === 'scroll-to-index') {
      // A navigation puts the reader somewhere they did not travel to, so the
      // watch starts again from there rather than carrying offsets across it.
      closeTailWatch('navigated', { navigationReason: reason });
    }
    if (reason === 'user-scroll' && tailWatchRef.current?.origin === 'new-turn-reveal') {
      closeTailWatch('reader-took-over');
    }
    if (tailWatchRef.current === null) {
      openTailWatch('user-departure');
    }
  }, [
    closeTailWatch,
    endSmoothScrollYield,
    openTailWatch,
    scrollerRef,
    stopFollowFrame,
    viewportId,
    viewportOwner,
  ]);

  /**
   * One sample of an open watch, from wherever the geometry can change.
   *
   * Costs a null check whenever follow owns the viewport, which is when nothing
   * is being watched. Otherwise it reads `scrollHeight` — the same measurement
   * the follow loop takes every frame while it *does* own the viewport, so this
   * is that measurement continuing across the gap where it does not.
   *
   * Defined below `enterFollowOutput` because a crossing can hand the viewport
   * back, which is the whole point of watching.
   */
  const sampleTailWatch = useCallback(() => {
    const watch = tailWatchRef.current;
    if (!watch) return;
    const scroller = scrollerRef.current;
    if (!scroller || isViewportSuspendedRef.current()) return;

    const scrollTopPx = scroller.scrollTop;
    const contentEndPx = readContentEndScrollTop(scroller);
    const blankPx = scrollTopPx - contentEndPx;
    const contentDeltaPx = contentEndPx - watch.lastContentEndPx;
    const scrollDeltaPx = scrollTopPx - watch.lastScrollTopPx;
    watch.lastScrollTopPx = scrollTopPx;
    watch.lastContentEndPx = contentEndPx;
    watch.samples += 1;

    /*
     * Geometry read from two different moments, so neither the latch nor a
     * verdict can be taken from it. A history prepend is the case: it shifts the
     * viewport by the height it inserted, before that height has been measured
     * into the scroll range, and the blank between the two reads as thousands of
     * pixels. Left alone rather than cleared — a restructure says nothing about
     * where the reader was standing before it, and the next honest sample is a
     * frame away.
     */
    if (!isTailBlankMeasurable({ blankPx, tailSpacerPx: getTailSpacerPx() })) return;

    const crossing = resolveTailDepartureCrossing({
      blankPx,
      contentDeltaPx,
      scrollDeltaPx,
    });
    if (crossing === 'watching') {
      watch.blankWasVisible = true;
      return;
    }
    /*
     * The blank is gone, but it was already gone last time: the reader is above
     * the end of content and staying there, which is reading history and is not
     * a crossing of anything. Only the transition is a question.
     */
    if (!watch.blankWasVisible) return;

    // Whether the reader's hand is still on it. The claim lapses on its own,
    // so this separates a crossing during a gesture from one after it.
    const gestureLive = viewportOwner.currentOwner() === 'user-gesture';
    const resumed = shouldResumeFollowAfterDeparture({ crossing, gestureLive });
    watch.crossings += 1;
    /*
     * A crossing the gesture vetoed keeps the latch, so the next sample judges
     * the same transition again: the reader either keeps climbing, and is let go
     * by a verdict that no longer needs the veto, or stops, and is followed once
     * the claim lapses. Every other verdict is final for this crossing — coming
     * back is what the reader has to do to raise the question again.
     */
    if (!(crossing === 'content-caught-up' && gestureLive)) {
      watch.blankWasVisible = false;
    }
    traceViewport({
      location: 'followOutput.tailCrossing',
      message: resumed
        ? 'output caught up with the reader, so follow takes the viewport back'
        : 'the blank closed under the reader, and follow leaves it alone',
      data: () => ({
        crossing,
        origin: watch.origin,
        resumed,
        gestureLive,
        viewportId,
        blankPx: roundViewportPx(blankPx),
        contentDeltaPx: roundViewportPx(contentDeltaPx),
        scrollDeltaPx: roundViewportPx(scrollDeltaPx),
        scrollTopPx: roundViewportPx(scrollTopPx),
        contentEndPx: roundViewportPx(contentEndPx),
        crossingIndex: watch.crossings,
        intoWatchMs: Math.round(performance.now() - watch.openedAtMs),
      }),
    });
    if (resumed) {
      enterFollowOutput('tail-caught-up');
    }
  }, [
    enterFollowOutput,
    getTailSpacerPx,
    readContentEndScrollTop,
    scrollerRef,
    viewportId,
    viewportOwner,
  ]);

  /**
   * Re-assert ownership after a layout change. This deliberately does not force
   * the viewport to the content end: a tool-card collapse resizes the content
   * too, and the hold rule is what keeps that from dragging earlier content
   * down.
   */
  const scheduleFollowToLatest = useCallback(() => {
    if (isViewportSuspendedRef.current()) return;
    if (
      isFollowingOutputRef.current
      && isViewportActiveRef.current
      && followPhaseRef.current === 'revealing-tail'
    ) {
      // The reveal is intentionally passive: streamed growth consumes the
      // visible blank while scrollTop stays fixed. Only the crossing is sampled.
      sampleTailWatch();
      return;
    }
    if (!isFollowingOutputRef.current || !isViewportActiveRef.current) {
      /*
       * This is the transcript's content-change signal — the resize observer
       * calls it before paint on every content box change — and for a viewport
       * nobody is following it is the one place a blank closing under a
       * stationary reader can be seen at all. Without it the departure would
       * only ever be sampled when the reader moved, which is the case it is not
       * watching for.
       */
      sampleTailWatch();
      return;
    }
    settleFramesRef.current = SETTLE_FRAMES;
    applyFollowTarget();
    startFollowFrame();
  }, [applyFollowTarget, sampleTailWatch, startFollowFrame]);

  const handleUserScrollIntent = useCallback(() => {
    exitFollowOutput('user-scroll');
  }, [exitFollowOutput]);

  /**
   * Turns were rolled back out of the session.
   *
   * The ledger cannot say this on its own — a shorter `dialogTurns` is also
   * what a window re-cut and a hydration merge look like — so the rollback
   * announces it, the same way a submission does. The transcript now ends
   * somewhere else, so the answer is an ordinary content-end placement.
   *
   * This takes the viewport whether or not follow owned it. A rollback at
   * Turn N removes N and everything after it, and the reader had N on screen —
   * they clicked its own button. So the new tail is always within a Turn of
   * where they already are, and there is no history below them to be pulled out
   * of. Gating this on ownership instead made it dead code in the case it was
   * written for: reaching a Turn far enough up to want it gone means scrolling,
   * and scrolling is exactly what hands the viewport back to the reader.
   *
   * Without it the viewport anchor answers instead, and answers the wrong
   * question — it holds the reader's Turn at its offset from the viewport top,
   * so an 8-Turn session rolled back at Turn 7 came to rest showing Turns 2..6
   * with the new last Turn's answer below the fold.
   */
  const handleTurnsRolledBack = useCallback(() => {
    pendingNewTurnIdRef.current = null;
    enterFollowOutput('turns-rolled-back');
  }, [enterFollowOutput]);

  const handleScroll = useCallback(() => {
    if (isViewportSuspendedRef.current()) return;
    // Scroll events describe the resulting viewport position, but do not prove user intent.
    // Layout growth and virtualizer remeasurement can emit them while output follow still owns
    // the viewport. Explicit wheel, touch, and keyboard handlers release that ownership instead.
    //
    // The other half of the departure sampler. Without it the remembered offset
    // goes stale whenever the reader moves and the content does not, and the
    // next crossing is attributed to the wrong one — which here would mean
    // handing the viewport back to a reader who is still climbing out of it.
    sampleTailWatch();
  }, [sampleTailWatch]);

  const getFollowTargetScrollTop = useCallback(() => (
    isFollowingOutputRef.current ? followStateRef.current.target : null
  ), []);

  /**
   * Whether follow-output owns the viewport *now*.
   *
   * The `isFollowingOutput` state answers the same question one render later,
   * which is a different answer inside an event handler that just released it.
   * A reader's gesture releases ownership and then asks whether the boundary
   * they are on is worth paging: mirroring the state into a ref at render time
   * made that ask see the ownership it had itself just ended, and refuse.
   */
  const isFollowingOutputNow = useCallback(() => isFollowingOutputRef.current, []);

  /**
   * The viewport was resized. Keep whatever was on the bottom edge on the
   * bottom edge.
   *
   * A plain scroller preserves `scrollTop`, which anchors the *top* edge: the
   * bottom is where content gets revealed or swallowed. For a transcript that
   * is backwards — the interesting end is the bottom — so this anchors there
   * instead. Follow output already behaves this way for a viewport it owns;
   * this is the same rule for one it does not.
   *
   * The two halves are not equally capable, and the difference is worth
   * knowing:
   *
   * - **A height change moves no content.** Preserving `scrollTop +
   *   clientHeight` is therefore exact and needs no judgement about what the
   *   user was doing. It also preserves the distance to the content end, so a
   *   viewport that was at the end stays at the end for free. Growing the
   *   viewport is additionally a restoration: the browser used to clamp a
   *   bottom-anchored viewport at `scrollHeight - clientHeight`, and the
   *   resident spacer removed that clamp.
   * - **A width change reflows the transcript.** Where the line that was on the
   *   bottom edge went is a DOM question, and by the time a resize is observed
   *   the reflow has already happened — answering it would mean sampling an
   *   element anchor on the scroll path. The end of the transcript is the one
   *   position that can be recomputed from geometry, so that case is handled
   *   and the general one is not.
   *
   * Never animated. A height change moves the viewport by exactly the height
   * that was added or removed, so nothing appears to move at all; the rest is a
   * correction the user is already watching happen under their cursor.
   * Ownership does not change either: a gesture ending in the blank expresses
   * an intent to be at the end, a layout change expresses nothing.
   */
  const handleViewportResize = useCallback((input: ViewportResizeInput) => {
    const scroller = scrollerRef.current;
    if (!scroller || isViewportSuspendedRef.current() || isFollowingOutputRef.current) {
      // Follow re-asserts its own target through `scheduleFollowToLatest`.
      return;
    }

    traceViewportRepeating(`resize|${input.wasAtTail}|${input.viewportHeightDeltaPx !== 0}`, {
      location: 'followOutput.viewportResize',
      message: 'the scroller box changed under a viewport nobody was following',
      travelPx: input.viewportHeightDeltaPx,
      data: () => ({
        viewportHeightDeltaPx: roundViewportPx(input.viewportHeightDeltaPx),
        wasAtTail: input.wasAtTail,
        scrollTopPx: roundViewportPx(scroller.scrollTop),
        clientHeightPx: scroller.clientHeight,
      }),
    });

    if (input.viewportHeightDeltaPx !== 0) {
      viewportOwner.write({
        owner: 'layout-correction',
        topPx: Math.max(0, scroller.scrollTop - input.viewportHeightDeltaPx),
      });
    }

    const followTarget = resolveFollowTargetScrollTop(scroller);
    if (
      input.wasAtTail &&
      followTarget - scroller.scrollTop > FLOWCHAT_AT_CONTENT_END_THRESHOLD_PX
    ) {
      viewportOwner.write({ owner: 'layout-correction', topPx: followTarget });
      return;
    }

  }, [resolveFollowTargetScrollTop, scrollerRef, viewportOwner]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      if (virtualItemCount > 0 && startAtTailOnMount) {
        enterFollowOutput(isStreaming ? 'streaming-resumed' : 'session-open');
      }
      return;
    }

    if (previousSessionIdRef.current !== activeSessionId) {
      previousSessionIdRef.current = activeSessionId;
      previousLatestTurnIdRef.current = latestTurnId;
      previousDialogTurnCountRef.current = dialogTurnCount;
      exitFollowOutput('session-changed');
      // A Turn waiting to be shown belongs to the session that gained it.
      pendingNewTurnIdRef.current = null;
      if (virtualItemCount > 0 && startAtTailOnMount) {
        enterFollowOutput(isStreaming ? 'streaming-resumed' : 'session-open');
      }
      return;
    }

    /*
     * An arrival, not a change. `latestTurnId` is the ledger's last Turn and it
     * is the right identity — but a rollback truncates the ledger, which moves
     * that identity *backwards* onto a Turn that has been there all along. Read
     * as an arrival it revealed the survivor as though it were new, which is the
     * reader's "I undid my message and it jumped to the one before it".
     *
     * The ledger growing is what separates the two. Nothing else that rewrites
     * `dialogTurns` — a history page merging in above, a window re-cut, a
     * hydration — moves the last Turn, so requiring growth costs nothing and
     * excludes every truncation.
     */
    const previousDialogTurnCount = previousDialogTurnCountRef.current;
    previousDialogTurnCountRef.current = dialogTurnCount;
    const isNewTurn = Boolean(
      latestTurnId
      && latestTurnId !== previousLatestTurnIdRef.current
      && dialogTurnCount > previousDialogTurnCount,
    );
    previousLatestTurnIdRef.current = latestTurnId;
    if (virtualItemCount === 0) {
      return;
    }
    if (isNewTurn) {
      enterFollowOutput('new-turn');
      return;
    }
    /*
     * The transcript changed without a new Turn, which is the moment a deferred
     * one can become revealable — the presentation being restored to the live
     * tail is exactly that. A retry that still cannot reveal it leaves the
     * viewport alone and stays pending.
     */
    if (pendingNewTurnIdRef.current === latestTurnId && latestTurnId !== null) {
      enterFollowOutput('new-turn');
    }
  }, [
    activeSessionId,
    dialogTurnCount,
    enterFollowOutput,
    exitFollowOutput,
    isStreaming,
    startAtTailOnMount,
    latestTurnId,
    virtualItemCount,
  ]);

  useEffect(() => {
    if (!isViewportActive) {
      stopFollowFrame();
      return;
    }
    if (isFollowingOutput && isStreaming) {
      scheduleFollowToLatest();
    }
  }, [isFollowingOutput, isStreaming, isViewportActive, scheduleFollowToLatest, stopFollowFrame]);

  // Settle any blank the hold rule accumulated once output stops arriving.
  // A short new-Turn reveal keeps its blank and its fixed viewport position.
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (wasStreaming === isStreaming || isStreaming) {
      return;
    }
    if (
      !isFollowingOutputRef.current
      || followPhaseRef.current !== 'following-tail'
    ) {
      return;
    }

    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const contentEnd = readContentEndScrollTop(scroller);
    if (followStateRef.current.target - contentEnd > BOTTOM_EPSILON_PX) {
      followStateRef.current = { target: contentEnd };
      runContentEndScroll('smooth');
    }
  }, [isStreaming, readContentEndScrollTop, runContentEndScroll, scrollerRef]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scheduleFollowToLatest();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [scheduleFollowToLatest]);

  useEffect(() => stopFollowFrame, [stopFollowFrame]);
  // A watch the transcript outlived is not an outcome, and leaving it open
  // would drop it from the trail entirely.
  useEffect(() => () => closeTailWatchRef.current('unmounted'), []);

  return {
    isFollowingOutput,
    enterFollowOutput,
    exitFollowOutput,
    scheduleFollowToLatest,
    isFollowingOutputNow,
    isFollowCorrectingViewport,
    handleUserScrollIntent,
    handleTurnsRolledBack,
    handleScroll,
    handleViewportResize,
    getFollowTargetScrollTop,
  };
}
