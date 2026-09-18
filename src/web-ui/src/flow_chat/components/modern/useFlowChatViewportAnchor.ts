/**
 * The reading position, kept where the reader left it.
 *
 * A virtualizer places items in the scroll range before it knows how tall they
 * are, so every late measurement rewrites the offset of everything below it.
 * react-virtuoso's own correction for that is a scroll by the change in *total*
 * list height, which assumes the change happened above the viewport, and it is
 * gated on scroll direction and on no programmatic scroll being in flight.
 * Measured on a 27-Turn session: one item measuring 38px -> 1003px produced a
 * 965px scroll across a whole Turn, and a 1680px growth that really was above
 * the viewport produced no correction at all — `scrollTop` held at 1133 while
 * `scrollHeight` went 8393 -> 10073, sliding the transcript down by the full
 * amount.
 *
 * So the correction cannot be delegated to whatever is doing the placing. This
 * restores a relationship instead of a delta, which makes it idempotent: when
 * the placement was right the correction is zero, and when it was wrong or
 * never came, this is what makes it right.
 *
 * It is also why capture and restore are separate: the scheme this replaced
 * captured once per prepend, in the commit that changed the item list, which is
 * a frame before the heights it was meant to compensate reach the DOM.
 * Measured corrections over three reproductions: +1, 0, 0.
 *
 * This hook talks to a scroller element and the DOM inside it, and to nothing
 * else. It is deliberately independent of the virtualizer.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import {
  roundViewportPx,
  traceViewport,
  traceViewportRepeating,
} from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
import {
  ANCHOR_CORRECTION_EPSILON_PX,
  ANCHOR_MISSING_TURN_ATTEMPTS,
  ANCHOR_NOTABLE_CORRECTION_PX,
  ANCHOR_SETTLE_FRAMES,
  findRenderedTurnAnchorElement,
  readTurnAnchorOffsetPx,
  readViewportAnchorCandidates,
  selectViewportAnchor,
  shouldCaptureViewportAnchorOnScroll,
  viewportAnchorCorrectionPx,
  type ViewportAnchor,
} from './flowChatViewportAnchor';

export interface UseFlowChatViewportAnchorOptions {
  scrollerRef: RefObject<HTMLElement | null>;
  /**
   * Someone is aiming the viewport at a target of their own, so the anchor must
   * stay quiet.
   *
   * The anchor judges by geometry alone, which cannot tell a movement made on
   * purpose from a displacement to undo — so it is told. The caller answers
   * from the viewport register; this hook only needs the answer, which is what
   * keeps it independent of everything that moves the viewport.
   *
   * Deliberately *not* true of the reader scrolling. A gesture chooses a
   * position in the transcript; it does not stop the transcript from moving
   * underneath them, and undoing that is all this hook does. The reader is also
   * re-anchored on every scroll of theirs, so a correction during a gesture is
   * zero unless something else really moved.
   */
  isViewportOwnedElsewhere: () => boolean;
  /**
   * Move the viewport *by* the correction. Supplied rather than performed here
   * so that the repair is registered like every other one, without this hook
   * having to know what else writes.
   */
  shiftViewport: (byPx: number) => void;
}

/**
 * What an attempt to put the reading position back actually did.
 *
 * The settle window refreshes on evidence that the settle is still running, and
 * only a frame that got as far as looking at the DOM has any. A boolean cannot
 * carry that: `false` is a stand-down, a Turn not rendered yet, and no anchor at
 * all, and the loop used to tell those apart by reading a counter that two of
 * the three never touch. Measured: 27 seconds of `anchor.stoodDown`, one per
 * frame, with the viewport parked and follow-output resting on it.
 */
type AnchorRestoreOutcome =
  | 'corrected'
  | 'in-place'
  | 'awaiting-turn'
  | 'stood-down'
  | 'blocked'
  | 'no-anchor';

export interface FlowChatViewportAnchorApi {
  /** Anchor to wherever the viewport is now, unconditionally. */
  captureAnchor: () => void;
  /**
   * Somebody else moved the viewport to keep the reading position, and this
   * much of where it now sits is not the reader.
   *
   * The anchor measures a correction against the viewport position its offset
   * was agreed at, and treats every other change to `scrollTop` as somebody's
   * deliberate movement rather than drift. A compensation is the one movement
   * made *on the anchor's behalf*, so it has to be told, or the repair it was
   * half of gets credited away and never finishes.
   *
   * This used to be a blanket "the viewport as of now is the baseline",
   * re-taken every time a settle window opened. That also discarded whatever
   * the reader had scrolled since the last capture — and a commit opens a
   * window on almost every frame, so the discard was the common case, not the
   * rare one.
   */
  absorbViewportShift: (byPx: number) => void;
  /**
   * The reader asked to be somewhere else, so the position they were at stops
   * being the one to restore.
   *
   * A navigation is not a displacement. The anchor cannot tell the two apart by
   * geometry — both are the viewport ending up somewhere it was not — and while
   * a navigation holds the register the anchor merely stands down, which
   * postpones the correction rather than cancelling it. Measured over four
   * clicks on one Turn: the aim placed the viewport at 287px each time, and
   * each time the anchor put it back 1653px away on the first frame after the
   * hold lapsed, still anchored to the Turn the reader had jumped away from.
   *
   * So the old anchor is dropped here and a new one is taken from the placement
   * once it has been rendered, in the settle window the commit opens. Between
   * the two there is no anchor, which is the one state that cannot restore
   * anything.
   */
  reanchorAfterNavigation: () => void;
  /**
   * Account for a scroll, by whichever of three answers fits it.
   *
   * A scroll event alone cannot say whether the user moved or the transcript
   * moved under them, and the reading position has to survive either way:
   *
   * - **Captured**, when a recent intent event says the scroll was theirs. The
   *   Turn they arrived at becomes the new reading position.
   * - **Carried**, when it was not provably theirs and nobody else can account
   *   for it. The anchored Turn is kept and only its expected offset moves, so
   *   a repair that was still owed survives the scroll instead of being
   *   forgotten at the displaced position. This covers both a Turn still
   *   missing from the rendered window and a gesture whose scroll event was
   *   delivered after the intent window closed.
   * - **Left alone**, when a registered writer owns the viewport. That
   *   movement is theirs and crediting it to the reader would drag the anchor
   *   along with every follow and aim.
   */
  captureAnchorForScroll: () => void;
  /** The user did something that scrolls, by their own hand. */
  markUserScrollIntent: () => void;
  /**
   * Put the anchored Turn back where it was. False when there was no anchor to
   * work from, which is the caller's signal to fall back on something coarser.
   *
   * Call where a correction can still beat the paint: a ResizeObserver
   * callback, which the browser delivers after layout and before painting, or
   * a layout effect.
   */
  restoreAnchor: () => boolean;
  /**
   * Restore the reading position after the native host temporarily withdrew the
   * viewport from layout.
   *
   * Host recovery is not reader input. Keep its transient `scrollTop` delta
   * out of the anchor until the pre-suspension relationship is restored.
   */
  restoreAnchorAfterViewportResume: () => boolean;
  /**
   * Correct now, and hold the anchor across the settle that follows.
   *
   * One callback per change is not enough, and no callback covers all of it, so
   * every signal that the transcript moved opens a window and the anchor is
   * re-asserted on each frame of it. A frame that had to correct refreshes the
   * window, so a settle that runs long is followed to its end rather than
   * abandoned partway.
   *
   * The first correction is synchronous because the caller is where the paint
   * can still be beaten. It is not always *able* to correct there — at a
   * history junction the anchored Turn is one frame away from being rendered —
   * but where it is, the displacement and its repair are one paint instead of
   * two.
   */
  openSettleWindow: (source?: 'items' | 'resize' | 'snapshot' | 'resume') => void;
}

export function useFlowChatViewportAnchor({
  scrollerRef,
  isViewportOwnedElsewhere,
  shiftViewport,
}: UseFlowChatViewportAnchorOptions): FlowChatViewportAnchorApi {
  const shiftViewportRef = useRef(shiftViewport);
  shiftViewportRef.current = shiftViewport;
  const anchorRef = useRef<ViewportAnchor | null>(null);
  /** Consecutive attempts the anchored Turn has been missing from the window. */
  const missingTurnAttemptsRef = useRef(0);
  /**
   * The viewport position the anchor's offset was last agreed against.
   *
   * Only read while the anchored Turn is missing. It is what lets the reader go
   * on scrolling through a repair they are owed: a scroll they made is a change
   * to `scrollTop`, and crediting it to the anchor keeps the rest — the part
   * the transcript moved — outstanding.
   */
  const anchorScrollTopRef = useRef(0);
  /*
   * How long the anchored Turn has been out of the rendered window this time.
   *
   * The wait is the thing that decides whether a junction is seen. The
   * synchronous correction in the commit is the one that costs nothing — it
   * shares the paint with the displacement — and at a history junction it has
   * never once been able to run, because the virtualizer windows from a scroll
   * offset it only learns from scroll events and so renders the position the
   * reader has just been moved off. Every correction therefore falls to the
   * settle loop, and whether the reader sees it is a race: measured over five
   * junctions, four corrections shared the prepend's frame and one landed 27ms
   * into the next, visible as a 93px jump.
   *
   * `attempts` alone cannot answer how long the wait is. It counts restore
   * calls, its trace is coalesced so only the first is ever emitted, and it
   * says nothing about frames or milliseconds. These say what the wait cost, at
   * the one moment it is known: when it ends.
   */
  const missingSinceMsRef = useRef<number | null>(null);
  /** Settle frames that have run while the anchored Turn was missing. */
  const missingFramesRef = useRef(0);
  /** Reader travel credited to the anchor while it waited. */
  const carriedDuringWaitPxRef = useRef(0);
  /** The rAF timestamp of the frame a settle correction is running in, if any. */
  const correctionFrameStartMsRef = useRef<number | null>(null);
  /** When the user last did something that scrolls, by their own hand. */
  const lastUserScrollIntentAtRef = useRef(0);
  /** Frames left in which the anchor is still being re-asserted. */
  const settleFramesRef = useRef(0);
  const blockedGeometryRef = useRef<string | null>(null);
  const lastResizeGeometryRef = useRef<string | null>(null);
  const correctionStatsRef = useRef({ count: 0, reversals: 0, travelPx: 0, lastSign: 0 });
  const settleSourceRef = useRef<string>('items');
  /**
   * The next settle window takes a reading position instead of restoring one.
   *
   * Set by a navigation, consumed by the commit that renders where it landed.
   * Nothing else can say when the placement is on screen: the target is
   * commonly outside the rendered window when the aim is issued, so reading the
   * DOM in that same task anchors to whatever the reader was moved off.
   */
  const recaptureOnNextSettleRef = useRef(false);
  /**
   * A zero-sized native-host viewport is not a reader scroll. This remains set
   * while its anchor waits for a virtual row to return, so the settle frame
   * that finally sees the row does not accept host recovery as reader travel.
   */
  const isRestoringViewportResumeRef = useRef(false);
  const settleFrameRef = useRef<number | null>(null);
  /*
   * The settle loop is installed once and outlives every render, so it cannot
   * close over anything that changes identity between them.
   */
  const isViewportOwnedElsewhereRef = useRef(isViewportOwnedElsewhere);
  isViewportOwnedElsewhereRef.current = isViewportOwnedElsewhere;

  /**
   * Forget a wait, without reporting it. For the cases where the wait stopped
   * being about anything rather than ending in an answer.
   */
  const endMissingTurnWait = useCallback(() => {
    missingTurnAttemptsRef.current = 0;
    missingSinceMsRef.current = null;
    missingFramesRef.current = 0;
    carriedDuringWaitPxRef.current = 0;
  }, []);

  /**
   * What a wait for the anchored Turn cost, reported where it is known.
   *
   * Once per wait, at its end, because that is the only moment the whole of it
   * exists. `outcome` separates the Turn coming back from the anchor being
   * given up on: both end the wait, and only one of them can still repair
   * anything.
   */
  const reportMissingTurnWait = useCallback((
    scroller: HTMLElement,
    turnId: string,
    outcome: 'returned' | 'given-up',
  ) => {
    const startedAtMs = missingSinceMsRef.current;
    if (startedAtMs === null) return;
    /*
     * Read out here rather than inside the thunk. The wait ends on the next
     * line, and a `data` callback is evaluated by the trace, not by this — so
     * a thunk over the refs would report the state after the reset every time.
     */
    const waited = {
      turnId,
      outcome,
      waitedForMs: Math.round(performance.now() - startedAtMs),
      waitedFrames: missingFramesRef.current,
      waitedAttempts: missingTurnAttemptsRef.current,
      carriedPx: roundViewportPx(carriedDuringWaitPxRef.current),
      scrollTopPx: roundViewportPx(scroller.scrollTop),
      scrollRangePx: roundViewportPx(scroller.scrollHeight),
    };
    endMissingTurnWait();
    traceViewport({
      location: outcome === 'returned' ? 'anchor.turnReturned' : 'anchor.waitAbandoned',
      message: outcome === 'returned'
        ? 'the anchored Turn came back into the rendered window'
        : 'the anchored Turn never came back',
      data: () => waited,
    });
  }, [endMissingTurnWait]);

  /**
   * Where the reading position is taken from, and when.
   *
   * Traced because capture is the half of this hook that decides what every
   * correction afterwards will restore *to*, and it is otherwise invisible: a
   * correction that returns the reader to a position the transcript held for
   * one frame mid-settle looks exactly like a correction that worked. The
   * source matters as much as the value — a scroll event carries no proof of
   * whose scroll it was, and this hook's own writes produce them too.
   */
  const captureAnchorAt = useCallback((source: 'explicit' | 'scroll' | 'navigation') => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    blockedGeometryRef.current = null;
    lastResizeGeometryRef.current = null;
    correctionStatsRef.current = { count: 0, reversals: 0, travelPx: 0, lastSign: 0 };
    const previous = anchorRef.current;
    const next = selectViewportAnchor(
      readViewportAnchorCandidates(scroller),
      scroller.clientHeight,
    );
    anchorRef.current = next;
    anchorScrollTopRef.current = scroller.scrollTop;
    // A new reading position is not the old one arriving, so whatever the old
    // one was waiting for stops being a fact about anything.
    endMissingTurnWait();
    traceViewportRepeating(`anchor|captured|${source}|${next?.turnId ?? 'none'}`, {
      location: 'anchor.captured',
      message: 'reading position taken',
      data: () => ({
        source,
        turnId: next?.turnId ?? null,
        offsetFromScrollerTopPx: next === null ? null : roundViewportPx(next.offsetFromScrollerTop),
        replacedTurnId: previous?.turnId ?? null,
        replacedOffsetPx: previous === null
          ? null
          : roundViewportPx(previous.offsetFromScrollerTop),
        scrollTopPx: roundViewportPx(scroller.scrollTop),
        // Read against the offset: an anchor is only a proxy for what the
        // reader sees while it is on screen, and the offset alone cannot say
        // whether it is.
        viewportHeightPx: roundViewportPx(scroller.clientHeight),
      }),
    });
  }, [endMissingTurnWait, scrollerRef]);

  const captureAnchor = useCallback(() => {
    captureAnchorAt('explicit');
  }, [captureAnchorAt]);

  const absorbViewportShift = useCallback((byPx: number) => {
    anchorScrollTopRef.current += byPx;
  }, []);

  const reanchorAfterNavigation = useCallback(() => {
    const previous = anchorRef.current;
    anchorRef.current = null;
    endMissingTurnWait();
    recaptureOnNextSettleRef.current = true;
    traceViewport({
      location: 'anchor.releasedForNavigation',
      message: 'the reader asked to be somewhere else, so the old reading position was dropped',
      data: () => ({
        replacedTurnId: previous?.turnId ?? null,
        replacedOffsetPx: previous === null
          ? null
          : roundViewportPx(previous.offsetFromScrollerTop),
        scrollTopPx: roundViewportPx(scrollerRef.current?.scrollTop ?? 0),
      }),
    });
  }, [endMissingTurnWait, scrollerRef]);

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = performance.now();
  }, []);

  /**
   * Carry the anchor through a scroll instead of replacing it.
   *
   * Take a movement of the viewport into the anchor instead of measuring
   * against it.
   *
   * The offset and the viewport position it was agreed at are two halves of one
   * fact, and this is the only thing that advances both. A change to
   * `scrollTop` is somebody moving the viewport — the reader, most of the time
   * — and never a displacement, because a displacement moves the transcript
   * underneath a `scrollTop` that stays put. So it is subtracted from where the
   * Turn is expected to be, and whatever remains is the drift to repair.
   *
   * Two callers, one rule:
   *
   * - **`awaiting-turn`** — a scroll while the anchored Turn is missing from
   *   the rendered window, where a correction is owed and cannot yet be
   *   measured. Re-reading the anchor from the DOM there accepts the reader's
   *   movement *and* the transcript's as one, and files the displacement away
   *   as the reader's own choice. Measured at three junctions in one session:
   *   the anchor was owed 104px, then 140px, then an amount never established,
   *   and at each of them a scroll 77ms later replaced it with a Turn at its
   *   displaced position. Two of the three were never corrected at all.
   * - **`viewport-moved`** — every restore, before anything is measured. The
   *   settle loop reads the DOM directly and a commit opens a window on almost
   *   every frame, so a correction routinely runs before the scroll event
   *   carrying the reader's travel has been delivered.
   */
  const carryAnchorThroughScroll = useCallback((
    scroller: HTMLElement,
    reason: 'awaiting-turn' | 'unclaimed-scroll' | 'viewport-moved',
  ) => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const travelledPx = scroller.scrollTop - anchorScrollTopRef.current;
    anchorScrollTopRef.current = scroller.scrollTop;
    if (travelledPx === 0) return;
    if (missingSinceMsRef.current !== null) carriedDuringWaitPxRef.current += travelledPx;
    anchorRef.current = {
      ...anchor,
      offsetFromScrollerTop: anchor.offsetFromScrollerTop - travelledPx,
    };
    traceViewportRepeating(`anchor|carried|${reason}|${anchor.turnId}`, {
      location: 'anchor.carried',
      message: 'the reader scrolled and the anchor went with them',
      travelPx: travelledPx,
      data: () => ({
        reason,
        turnId: anchor.turnId,
        travelledPx: roundViewportPx(travelledPx),
        expectedOffsetPx: roundViewportPx(anchor.offsetFromScrollerTop - travelledPx),
        missingAttempts: missingTurnAttemptsRef.current,
        scrollTopPx: roundViewportPx(scroller.scrollTop),
      }),
    });
  }, []);

  const captureAnchorForScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (missingTurnAttemptsRef.current > 0) {
      carryAnchorThroughScroll(scroller, 'awaiting-turn');
      return;
    }
    const msSinceUserScrollIntent = performance.now() - lastUserScrollIntentAtRef.current;
    if (shouldCaptureViewportAnchorOnScroll(anchorRef.current !== null, msSinceUserScrollIntent)) {
      captureAnchorAt('scroll');
      return;
    }
    /*
     * Not provably the reader's — and still theirs, if nobody else can account
     * for it.
     *
     * The window is measured from the *input* event, and the scrolling it
     * authorises outlives it: a wheel notch smooth-scrolls for longer than the
     * window, and under a busy main thread the scroll event carrying the whole
     * travel is delivered after it has closed. Ignoring the event then leaves
     * the reader's own movement credited to nobody, and the next settle undoes
     * it in full. Measured over 181 seconds: fourteen gestures, one capture, and
     * seven corrections of 308px to 618px that each returned the viewport to
     * exactly where the gesture had started.
     *
     * Carrying is what "credited to nobody" was missing, and it is safe where a
     * capture is not: it keeps the anchored Turn and only moves its expected
     * offset, so a repair that was still owed survives instead of being
     * forgotten at the displaced position.
     *
     * Owned elsewhere is the case this must not touch. A registered writer
     * moving the viewport is the one other thing that changes `scrollTop`
     * without the reader, and crediting *that* to them would carry the anchor
     * along with every follow and aim.
     */
    if (!isViewportOwnedElsewhereRef.current()) {
      carryAnchorThroughScroll(scroller, 'unclaimed-scroll');
      return;
    }
    traceViewportRepeating('anchor|scroll-left-alone', {
      location: 'anchor.scrollLeftAlone',
      message: 'a scroll was neither the reader\'s nor ours to credit',
      data: () => ({
        turnId: anchorRef.current?.turnId ?? null,
        msSinceUserScrollIntent: Math.round(msSinceUserScrollIntent),
        scrollTopPx: roundViewportPx(scroller.scrollTop),
      }),
    });
  }, [captureAnchorAt, carryAnchorThroughScroll, scrollerRef]);

  const attemptRestore = useCallback((): AnchorRestoreOutcome => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor) {
      isRestoringViewportResumeRef.current = false;
      return 'no-anchor';
    }
    /*
     * Every way this declines is silent and looks like the transcript simply
     * not moving, which is why each of them is traced. Standing down for
     * another owner is the intended case; the other two are how a reading
     * position gets lost, and they have both happened.
     */
    if (isViewportOwnedElsewhereRef.current()) {
      isRestoringViewportResumeRef.current = false;
      traceViewportRepeating('anchor|owned-elsewhere', {
        location: 'anchor.stoodDown',
        message: 'anchor stood down for another owner',
        data: () => ({ turnId: anchor.turnId, scrollTopPx: roundViewportPx(scroller.scrollTop) }),
      });
      return 'stood-down';
    }
    const element = findRenderedTurnAnchorElement(scroller, anchor.turnId);
    /*
     * The anchored Turn can be absent from the rendered window, and one frame
     * of absence is not the same fact as the reader having left it behind.
     *
     * The single frame is the common case: the virtualizer chooses its window
     * from a scroll offset it only learns from scroll events, so the commit
     * that prepends history is still windowing the position the reader has just
     * been moved off, and their Turn arrives a frame later. Dropping there threw
     * away the only record of where they were reading, one frame before it
     * could have been used — measured at four junctions in a row, every one a
     * drop and not one correction.
     */
    if (!element) {
      if (missingSinceMsRef.current === null) missingSinceMsRef.current = performance.now();
      missingTurnAttemptsRef.current += 1;
      const givingUp = missingTurnAttemptsRef.current >= ANCHOR_MISSING_TURN_ATTEMPTS;
      traceViewportRepeating(`anchor|turn-not-rendered|${givingUp}`, {
        location: givingUp ? 'anchor.dropped' : 'anchor.turnNotRendered',
        message: givingUp
          ? 'anchored Turn stayed out of the rendered window, so the anchor was given up'
          : 'anchored Turn is not in the rendered window yet',
        data: () => ({
          turnId: anchor.turnId,
          attempts: missingTurnAttemptsRef.current,
          scrollTopPx: roundViewportPx(scroller.scrollTop),
          scrollRangePx: roundViewportPx(scroller.scrollHeight),
        }),
      });
      if (givingUp) {
        reportMissingTurnWait(scroller, anchor.turnId, 'given-up');
        anchorRef.current = null;
        isRestoringViewportResumeRef.current = false;
        return 'no-anchor';
      }
      return 'awaiting-turn';
    }
    // The wait is reported before the correction it made possible, so the two
    // read as cause and effect in the order they are written down.
    reportMissingTurnWait(scroller, anchor.turnId, 'returned');
    /*
     * Whatever moved the viewport since the offset was agreed is taken into the
     * anchor before anything is measured against it, and it is never a
     * displacement — a displacement moves the transcript under a `scrollTop`
     * that stays put. Almost always it is the reader, whose scroll event has
     * simply not been delivered yet: the settle loop reads the DOM directly and
     * a commit can open a window before the event arrives, so a correction gets
     * there first and undoes them.
     *
     * Taken in *here* rather than subtracted in the correction, because the
     * offset and the position it was agreed at are two halves of one fact and
     * every writer has to move both. Subtracting it left the two branches below
     * advancing only the position, and a frame with nothing to correct then
     * banked the reader's travel as a debt the next frame collected. Measured:
     * a 32px scroll and an 81px scroll, each reported back as a correction of
     * exactly itself with `scrolledSincePx: 0`.
     */
    const scrolledSincePx = scroller.scrollTop - anchorScrollTopRef.current;
    const isRestoringViewportResume = isRestoringViewportResumeRef.current;
    if (!isRestoringViewportResume) {
      carryAnchorThroughScroll(scroller, 'viewport-moved');
    }
    const rebased = anchorRef.current ?? anchor;
    const currentOffsetPx = readTurnAnchorOffsetPx(scroller, element);
    const geometry = JSON.stringify([
      rebased.turnId, rebased.offsetFromScrollerTop, currentOffsetPx,
      scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight, scroller.clientWidth,
    ]);
    if (blockedGeometryRef.current === geometry) return 'blocked';
    blockedGeometryRef.current = null;
    const correction = viewportAnchorCorrectionPx(
      rebased,
      currentOffsetPx,
    );
    /*
     * Already where it belongs, which still counts as answered — and is now the
     * common outcome rather than a rarity, since a frame in which only the
     * reader moved lands here exactly. Traced for that reason: it is reached
     * every frame of every settle, and it is where a reading position that has
     * quietly stopped meaning anything would sit unnoticed.
     */
    if (Math.abs(correction) < ANCHOR_CORRECTION_EPSILON_PX) {
      if (isRestoringViewportResume) {
        anchorScrollTopRef.current = scroller.scrollTop;
        isRestoringViewportResumeRef.current = false;
      }
      traceViewportRepeating(`anchor|in-place|${rebased.turnId}`, {
        location: 'anchor.inPlace',
        message: 'the reading position is where it belongs',
        data: () => ({
          turnId: rebased.turnId,
          anchoredOffsetPx: roundViewportPx(rebased.offsetFromScrollerTop),
          scrolledSincePx: roundViewportPx(scrolledSincePx),
          scrollTopPx: roundViewportPx(scroller.scrollTop),
        }),
      });
      return 'in-place';
    }
    /*
     * Keyed by which anchor and by whether the reader can feel it, because a
     * coalesced run collapses to its first sample and the rest becomes a sum.
     * Under one key, two rounds of diagnosis in a row read `correctionPx: 0.7`
     * against 458.7px of suppressed travel spanning three different anchors —
     * every correction that mattered was inside the summary, attributable to
     * nothing.
     */
    const felt = Math.abs(correction) >= ANCHOR_NOTABLE_CORRECTION_PX;
    traceViewportRepeating(`anchor|correcting|${felt ? 'felt' : 'rounding'}|${rebased.turnId}`, {
      location: 'anchor.correct',
      message: 'anchor requested a reading position correction',
      travelPx: correction,
      data: () => ({
        turnId: rebased.turnId,
        correctionPx: roundViewportPx(correction),
        /*
         * Where the anchored Turn is being held, against how much of the
         * scroller there is to hold it in. A correction restores a marker the
         * reader cannot see if this falls outside the viewport, and then it is
         * reporting movement that never reached the screen.
         */
        anchoredOffsetPx: roundViewportPx(rebased.offsetFromScrollerTop),
        viewportHeightPx: roundViewportPx(scroller.clientHeight),
        /*
         * The part of the drift that was somebody moving the viewport rather
         * than the transcript moving. Read against `correctionPx`: what is
         * left over is the displacement, and the two being equal and opposite
         * is a correction that would have undone a scroll.
         */
        scrolledSincePx: roundViewportPx(scrolledSincePx),
        frameStartMs: correctionFrameStartMsRef.current === null
          ? null
          : Math.round(correctionFrameStartMsRef.current),
        scrollTopPx: roundViewportPx(scroller.scrollTop),
        /*
         * The scroll range, so a correction can be told apart from the reason
         * for it. A large correction means either that whoever moved the
         * viewport last over-shot, or that the transcript above the reader
         * measured smaller than it had reserved — and those differ by whether
         * the range changed since the change that opened this settle. Without
         * it, a 412px correction and a 412px mistake read the same.
         */
        scrollRangePx: roundViewportPx(scroller.scrollHeight),
      }),
    });
    const beforePx = scroller.scrollTop;
    shiftViewportRef.current(correction);
    const appliedPx = scroller.scrollTop - beforePx;
    const residualPx = viewportAnchorCorrectionPx(rebased, readTurnAnchorOffsetPx(scroller, element));
    const improved = Math.abs(residualPx) < ANCHOR_CORRECTION_EPSILON_PX
      || Math.abs(residualPx) < Math.abs(correction);
    const stats = correctionStatsRef.current;
    const sign = Math.sign(correction);
    if (stats.lastSign !== 0 && stats.lastSign !== sign) stats.reversals += 1;
    stats.lastSign = sign;
    stats.count += 1;
    stats.travelPx += Math.abs(appliedPx);
    const magnitudeBand = Math.abs(correction) >= ANCHOR_NOTABLE_CORRECTION_PX ? 'felt' : 'rounding';
    traceViewportRepeating(`anchor|result|${rebased.turnId}|${improved}|${sign}|${magnitudeBand}`, {
      location: 'anchor.correctionResult',
      message: 'measured the result of an anchor correction',
      travelPx: appliedPx,
      data: () => ({
        turnId: rebased.turnId, source: settleSourceRef.current,
        frameStartMs: correctionFrameStartMsRef.current,
        requestedPx: roundViewportPx(correction), appliedPx: roundViewportPx(appliedPx),
        residualPx: roundViewportPx(residualPx), improved,
        correctionCount: stats.count, reversalCount: stats.reversals,
        cumulativeTravelPx: roundViewportPx(stats.travelPx),
        scrollTopPx: roundViewportPx(scroller.scrollTop), scrollHeightPx: scroller.scrollHeight,
        viewportHeightPx: scroller.clientHeight,
        anchorItemKey: element.dataset.virtualItemKey ?? null,
        renderedFirstIndex: scroller.querySelector('[data-virtual-index]')?.getAttribute('data-virtual-index') ?? null,
        renderedRowCount: scroller.querySelectorAll('[data-virtual-index]').length,
      }),
    });
    if (!improved) {
      blockedGeometryRef.current = JSON.stringify([
        rebased.turnId, rebased.offsetFromScrollerTop,
        readTurnAnchorOffsetPx(scroller, element), scroller.scrollTop,
        scroller.scrollHeight, scroller.clientHeight, scroller.clientWidth,
      ]);
    }
    /*
     * The shift put the Turn back at the stored offset, so advancing only the
     * position keeps the two halves agreeing. This is the one movement of
     * `scrollTop` that must not be taken into the offset — it is the repair.
     */
    anchorScrollTopRef.current = scroller.scrollTop;
    isRestoringViewportResumeRef.current = false;
    return improved ? 'corrected' : 'blocked';
  }, [carryAnchorThroughScroll, reportMissingTurnWait, scrollerRef]);

  const attemptRestoreRef = useRef(attemptRestore);
  attemptRestoreRef.current = attemptRestore;

  /*
   * The public answer is "did this leave the reading position where it belongs",
   * which the outcome refines rather than replaces. Callers outside the settle
   * loop only ever needed the two.
   */
  const restoreAnchor = useCallback((): boolean => {
    const outcome = attemptRestoreRef.current();
    return outcome === 'corrected' || outcome === 'in-place';
  }, []);

  const restoreAnchorAfterViewportResume = useCallback((): boolean => {
    isRestoringViewportResumeRef.current = true;
    const outcome = attemptRestoreRef.current();
    return outcome === 'corrected' || outcome === 'in-place';
  }, []);

  const openSettleWindow = useCallback((source: 'items' | 'resize' | 'snapshot' | 'resume' = 'items') => {
    const scroller = scrollerRef.current;
    if (source === 'resize' && scroller) {
      const anchor = anchorRef.current;
      const element = anchor ? findRenderedTurnAnchorElement(scroller, anchor.turnId) : null;
      const geometry = JSON.stringify([
        scroller.scrollHeight, scroller.clientWidth, scroller.clientHeight,
        anchor?.turnId, element ? readTurnAnchorOffsetPx(scroller, element) + scroller.scrollTop : null,
      ]);
      if (lastResizeGeometryRef.current === geometry) return;
      lastResizeGeometryRef.current = geometry;
    }
    settleSourceRef.current = source;
    traceViewportRepeating(`anchor|settle-open|${source}`, {
      location: 'anchor.settleOpened', message: 'opened an anchor settle window',
      data: () => ({ source, remainingFrames: settleFramesRef.current, alreadyRunning: settleFrameRef.current !== null }),
    });
    settleFramesRef.current = ANCHOR_SETTLE_FRAMES;
    if (recaptureOnNextSettleRef.current) {
      /*
       * The first commit after a navigation, which is where the placement is
       * finally on screen. Taking the reading position here rather than
       * restoring one is the whole difference between a jump that holds and a
       * jump that is undone the moment the register lets go.
       */
      recaptureOnNextSettleRef.current = false;
      captureAnchorAt('navigation');
    } else {
      // In the caller's own frame, so the displacement and its correction are
      // one paint rather than two. Callers are a layout effect or a
      // ResizeObserver callback; both still run before the browser paints.
      attemptRestoreRef.current();
    }
    if (settleFrameRef.current !== null) return;
    const step = (frameStartMs: number) => {
      settleFrameRef.current = null;
      settleFramesRef.current -= 1;
      /*
       * The frame this correction belongs to, which is the only way to tell a
       * repair the reader never saw from one they watched happen. A correction
       * whose frame started before the displacement's own frame was painted is
       * invisible; one a frame or more later is the flicker.
       */
      correctionFrameStartMsRef.current = frameStartMs;
      /*
       * A frame that made a correction refreshes the window, and so does one
       * still waiting for the anchored Turn to be rendered. "Not there yet" is
       * neither a repair nor a failure, and spending a frame on it makes the
       * settle outlast the wait only for as long as `ANCHOR_SETTLE_FRAMES` and
       * `ANCHOR_MISSING_TURN_ATTEMPTS` happen to be the same number. They are
       * independent constants describing different things; this says what was
       * meant instead of relying on them coinciding. An in-place frame is
       * already settled and must consume the remaining budget, otherwise an
       * anchor that never moves keeps this RAF loop alive forever.
       */
      const outcome = attemptRestoreRef.current();
      // Counted here rather than beside `attempts`, because it is frames the
      // wait is measured in: a Turn that arrives in the next frame costs the
      // reader nothing, and one that takes five is five painted frames of
      // being in the wrong place. A frame that stood down is none of those —
      // it never looked, and counting it reported a 28-second wait for a
      // reading position that was correct the whole time.
      if (outcome === 'awaiting-turn') missingFramesRef.current += 1;
      /*
       * Only a frame that looked can say the settle is still running. A
       * stand-down looked at nothing — the owner it deferred to is placing the
       * viewport, and while that owner rests on it, as follow-output does at
       * the tail, nothing here will ever change. Refreshing on it kept the loop
       * alive off a missing-Turn count left by the last frame that *did* look,
       * and that count can only advance on a frame that does not stand down:
       * the one condition jammed the loop and made its only exit unreachable.
       */
      if (outcome === 'corrected' || outcome === 'awaiting-turn') {
        settleFramesRef.current = ANCHOR_SETTLE_FRAMES;
      }
      correctionFrameStartMsRef.current = null;
      if (settleFramesRef.current > 0) {
        settleFrameRef.current = requestAnimationFrame(step);
      } else {
        traceViewportRepeating(`anchor|settle-ended|${outcome}`, {
          location: 'anchor.settleEnded', message: 'anchor settle window ended',
          data: () => ({ source: settleSourceRef.current, outcome, ...correctionStatsRef.current }),
        });
      }
    };
    settleFrameRef.current = requestAnimationFrame(step);
  }, [captureAnchorAt, scrollerRef]);

  useEffect(() => () => {
    if (settleFrameRef.current !== null) {
      cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = null;
    }
  }, []);

  return useMemo(() => ({
    captureAnchor,
    absorbViewportShift,
    reanchorAfterNavigation,
    captureAnchorForScroll,
    markUserScrollIntent,
    restoreAnchor,
    restoreAnchorAfterViewportResume,
    openSettleWindow,
  }), [
    absorbViewportShift,
    captureAnchor,
    captureAnchorForScroll,
    markUserScrollIntent,
    openSettleWindow,
    reanchorAfterNavigation,
    restoreAnchor,
    restoreAnchorAfterViewportResume,
  ]);
}
