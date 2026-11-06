import { readFlowChatScrollTop } from './flowChatScrollCoordinates';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  claimSubmittedMessageScrollIntent, finishSubmittedMessageScrollIntent,
  isSubmittedMessageScrollIntentPending,
  subscribeSubmittedMessageScrollIntent, type SubmittedMessageScrollIntent,
} from '../../services/submittedMessageScrollIntent';
import { getMotionAwareScrollBehavior } from '../../utils/motionPreference';
import type { FlowChatViewportOwnerApi } from './useFlowChatViewportOwner';
import { easeFollowOffset, resolveAnimatedJumpBehavior } from './flowChatTailFollow';

export type FollowOutputEnterReason = 'jump-to-latest' | 'session-open' | 'streaming-resumed' | 'turns-rolled-back' | 'reader-at-bottom';
export type FollowOutputExitReason = 'session-changed' | 'viewport-inactive' | 'user-scroll' | 'reader-interaction' | 'scroll-to-turn' | 'scroll-to-index';
export interface ViewportResizeInput { viewportHeightDeltaPx: number; wasAtTail: boolean }

interface Options {
  /** History's native scroll origin already holds the tail through reflow. */
  nativeEndOrigin?: boolean;
  activeSessionId?: string;
  virtualItemCount: number;
  isStreaming: boolean;
  isViewportActive: boolean;
  startAtTailOnMount?: boolean;
  isViewportSuspended?: () => boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Refresh layout geometry once per layout signal; frames reuse this result. */
  readLayoutTarget: () => number;
  /** Actual reading-column geometry, including CSS-only drag previews. */
  readLayoutRevision?: () => string;
  /** Release a previous wrapping-dependent floor before resolving a reflow. */
  onLayoutReflow?: () => void;
  /** Returns the measured top placement, or null while materializing the row. */
  placeSubmittedMessage: (intent: SubmittedMessageScrollIntent) => number | null;
  hasRenderedOutput: (turnId: string) => boolean;
  cancelPendingPlacement: () => void;
  cancelNavigation: () => void;
  isOpeningViewport: () => boolean;
  /** Publish accepted writes before the virtualizer selects its next window. */
  onViewportOffset?: (offset: number) => void;
  viewportOwner: FlowChatViewportOwnerApi;
  viewportId?: number;
}

type Phase = 'reading' | 'pending-send' | 'awaiting-output' | 'following';
const EPSILON = 1;

/** One interruptible writer. Layout measures targets; RAF only spends their travel. */
export function useFlowChatFollowOutput(options: Options) {
  const current = useRef(options);
  current.current = options;
  const [isFollowingOutput, setIsFollowingOutput] = useState(false);
  const following = useRef(false);
  const phase = useRef<Phase>('reading');
  const pending = useRef<SubmittedMessageScrollIntent | null>(null);
  const placingSubmission = useRef(false);
  const submittedTurn = useRef<string | null>(null);
  const target = useRef(0);
  const layoutRevision = useRef<string>();
  const frame = useRef<number | null>(null);
  const lastFrameAt = useRef<number | null>(null);
  const lastFrameWrite = useRef<{ requested: number; actual: number } | null>(null);
  const downward = useRef<{ position: number } | null>(null);
  const initialized = useRef(false);
  const session = useRef(options.activeSessionId);
  const run = useRef<(now: number) => void>(() => {});
  const refresh = useRef<() => void>(() => {});

  const setFollowing = useCallback((value: boolean) => {
    if (following.current === value) return;
    following.current = value;
    setIsFollowingOutput(value);
  }, []);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    lastFrameAt.current = null;
    lastFrameWrite.current = null;
  }, []);
  const available = useCallback(() => {
    const o = current.current;
    return o.isViewportActive && !o.isViewportSuspended?.() && !document.hidden
      && Boolean(o.scrollerRef.current?.clientHeight);
  }, []);
  const wake = useCallback(() => {
    if (frame.current === null && following.current && available()) {
      frame.current = requestAnimationFrame(now => run.current(now));
    }
  }, [available]);
  const discardPending = useCallback(() => {
    const discarded = pending.current;
    pending.current = null;
    if (discarded) finishSubmittedMessageScrollIntent(discarded);
    const o = current.current;
    const unbound = session.current ? claimSubmittedMessageScrollIntent(session.current, o.viewportId ?? 0, true) : null;
    if (unbound) finishSubmittedMessageScrollIntent(unbound);
    if (discarded) o.cancelPendingPlacement();
  }, []);
  const exitFollowOutput = useCallback((_reason: FollowOutputExitReason) => {
    const o = current.current;
    setFollowing(false);
    phase.current = 'reading';
    downward.current = null;
    discardPending();
    stop();
    o.viewportOwner.release('follow-output');
  }, [discardPending, setFollowing, stop]);

  run.current = now => {
    frame.current = null;
    if (!following.current || !available()) { lastFrameAt.current = null; return; }
    const o = current.current;
    const scroller = o.scrollerRef.current!;
    if (phase.current === 'pending-send' || phase.current === 'awaiting-output') {
      lastFrameAt.current = null;
      return;
    }
    const from = readFlowChatScrollTop(scroller);
    // The browser may already have clamped a shrinking layout before its
    // ResizeObserver is delivered. Never animate toward an unreachable cache
    // entry, or leave an idle RAF chasing it until the next token arrives.
    const reachableTarget = o.nativeEndOrigin ? o.readLayoutTarget()
      : Math.min(target.current, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    // Native scroll offsets can quantize each write. Keep the unpainted fraction
    // of our accepted travel, or a subpixel step repeats forever near the tail.
    // A foreign placement/clamp or a refused write starts from actual geometry.
    const animationFrom = lastFrameAt.current !== null && lastFrameWrite.current?.actual === from
      ? lastFrameWrite.current.requested : from;
    const elapsed = lastFrameAt.current === null ? 16 : Math.min(64, now - lastFrameAt.current);
    lastFrameAt.current = now;
    const opening = o.isOpeningViewport();
    // A batched response can add dozens of screens in one commit. Traversing
    // them mounts invisible intermediate rows and cannot be followed by a reader.
    // Apply the same distance policy as an explicit jump to latest.
    const behavior = resolveAnimatedJumpBehavior({ fromPx: from, targetPx: reachableTarget, clientHeight: scroller.clientHeight });
    const candidate = opening || getMotionAwareScrollBehavior(behavior) === 'auto'
      ? reachableTarget : easeFollowOffset(animationFrom, reachableTarget, elapsed);
    const next = Math.abs(candidate - reachableTarget) <= EPSILON ? reachableTarget : candidate;
    if (from !== reachableTarget) {
      const requested = Math.abs(reachableTarget - from) > EPSILON ? next : reachableTarget;
      // Refusal leaves the target intact. A short live gesture can outlast the
      // reader's deliberate arrival at bottom; it still outranks every write.
      if (o.viewportOwner.write({ owner: 'follow-output', topPx: requested })) {
        const actual = readFlowChatScrollTop(scroller);
        lastFrameWrite.current = { requested, actual };
        o.onViewportOffset?.(actual);
      } else lastFrameWrite.current = null;
    }
    if (Math.abs(readFlowChatScrollTop(scroller) - reachableTarget) > EPSILON) wake();
    else lastFrameAt.current = null;
  };

  const enterFollowOutput = useCallback((reason: FollowOutputEnterReason) => {
    if (!available()) return;
    const o = current.current;
    discardPending();
    lastFrameWrite.current = null;
    downward.current = null;
    submittedTurn.current = null;
    o.cancelNavigation();
    o.viewportOwner.release('one-shot-navigation');
    if (reason !== 'reader-at-bottom') o.viewportOwner.release('user-gesture');
    o.viewportOwner.claim('follow-output');
    setFollowing(true);
    phase.current = 'following';
    target.current = o.readLayoutTarget();
    layoutRevision.current = o.readLayoutRevision?.();
    const scroller = o.scrollerRef.current!;
    const animate = reason === 'jump-to-latest' && resolveAnimatedJumpBehavior({
      fromPx: readFlowChatScrollTop(scroller), targetPx: target.current, clientHeight: scroller.clientHeight,
    }) === 'smooth';
    if (!animate && reason !== 'reader-at-bottom'
      && !(o.nativeEndOrigin && reason === 'session-open')) {
      if (o.viewportOwner.write({ owner: 'follow-output', topPx: target.current })) o.onViewportOffset?.(readFlowChatScrollTop(scroller));
    }
    if (!o.nativeEndOrigin || reason === 'jump-to-latest') wake();
  }, [available, discardPending, setFollowing, wake]);

  const trySubmission = useCallback(() => {
    // Measuring a placement synchronously notifies the virtualizer, which can
    // call follow again before this transaction has consumed its intent.
    // Treat that notification as handled; the outer placement reads the final
    // geometry after measurement and must remain the only consumer.
    if (placingSubmission.current) return true;
    const o = current.current;
    if (!o.activeSessionId || !available()) return false;
    placingSubmission.current = true;
    let placement: SubmittedMessageScrollIntent | null = null;
    try {
      const wasCancelled = Boolean(pending.current && !isSubmittedMessageScrollIntentPending(pending.current));
      if (wasCancelled) {
        pending.current = null;
        submittedTurn.current = null;
        o.cancelPendingPlacement();
      }
      const intent = claimSubmittedMessageScrollIntent(o.activeSessionId, o.viewportId ?? 0);
      if (wasCancelled && !intent) {
        // A failed or queued send no longer owns a placement. Do not let the
        // former pending-send phase resume tail following on its next signal.
        setFollowing(false);
        phase.current = 'reading';
        stop();
        o.viewportOwner.release('follow-output');
      }
      if (intent && intent !== pending.current) {
        if (pending.current) finishSubmittedMessageScrollIntent(pending.current);
        pending.current = intent;
        phase.current = 'pending-send';
        stop();
        o.cancelNavigation();
        // Submission is a new explicit placement, including from a history view.
        o.viewportOwner.release('one-shot-navigation');
        o.viewportOwner.release('user-gesture');
        o.viewportOwner.claim('follow-output');
        setFollowing(true);
      }
      if (!pending.current) return false;
      if (!pending.current.scope.isCurrent()) { exitFollowOutput('session-changed'); return false; }
      placement = pending.current;
      const placed = o.placeSubmittedMessage(placement);
      // A measurement callback may cancel, replace, or move this submission to
      // another surface/session. Never resurrect it or consume its replacement.
      if (pending.current !== placement || !placement.scope.isCurrent()
        || !isSubmittedMessageScrollIntentPending(placement)
        || current.current.activeSessionId !== placement.sessionId || !available()) return true;
      if (placed === null) return true;
      submittedTurn.current = placement.turnId;
      pending.current = null;
      finishSubmittedMessageScrollIntent(placement);
      phase.current = 'awaiting-output';
      target.current = placed;
      initialized.current = true;
      return true;
    } catch (error) {
      if (placement && pending.current === placement) {
        pending.current = null;
        finishSubmittedMessageScrollIntent(placement);
        phase.current = 'reading';
        setFollowing(false);
        current.current.viewportOwner.release('follow-output');
      }
      throw error;
    } finally {
      placingSubmission.current = false;
    }
  }, [available, exitFollowOutput, setFollowing, stop]);

  const scheduleFollowToLatest = useCallback((layoutOnly = false) => {
    if (!available()) return;
    if (trySubmission()) return;
    const o = current.current;
    if (o.nativeEndOrigin) {
      // Earlier history changes neither the native offset nor the tail. Keep
      // navigation's target current without manufacturing a scroll correction.
      target.current = o.readLayoutTarget();
      return;
    }
    const revision = o.readLayoutRevision?.();
    const reflow = layoutOnly || (layoutRevision.current !== undefined && revision !== layoutRevision.current);
    // Do not release a geometric floor underneath a higher-priority writer.
    // Keep the old revision so the next permitted layout sample can place it.
    if (reflow && following.current && o.viewportOwner.currentOwner() !== 'follow-output') return;
    layoutRevision.current = revision;
    // Releasing the old extent can synchronously clamp scrollTop. Capture the
    // previous coordinate first; translating the clamped value applies the
    // same shrink twice and paints precisely the jump-then-ease-back failure.
    const beforeLayout = readFlowChatScrollTop(o.scrollerRef.current!);
    if (reflow && following.current) o.onLayoutReflow?.();
    const next = o.readLayoutTarget();
    if (!following.current) return; // Growth can never take control from a reader.
    if (phase.current === 'awaiting-output') {
      if (!submittedTurn.current || !o.hasRenderedOutput(submittedTurn.current)) return;
      if (next <= target.current + EPSILON) return;
      phase.current = 'following';
    }
    const previousTarget = target.current;
    target.current = next;
    if (reflow || o.isOpeningViewport()) {
      // Reflow is a single layout placement. Animating it exposes the old
      // coordinates first and then drags already-visible content back.
      // Translate both coordinates so any genuine output lag remains intact.
      const topPx = o.isOpeningViewport() ? next : Math.max(0, beforeLayout + next - previousTarget);
      if (o.viewportOwner.write({ owner: 'follow-output', topPx })) o.onViewportOffset?.(readFlowChatScrollTop(o.scrollerRef.current!));
    }
    wake();
  }, [available, trySubmission, wake]);
  refresh.current = scheduleFollowToLatest;

  // A measured row wholly above the viewport moved the coordinate system,
  // not the output being followed. Translate both ends of the ongoing ease
  // before paint so any remaining stream lag stays exactly the same.
  const shiftLayout = useCallback((byPx: number): boolean => {
    const o = current.current;
    if (o.nativeEndOrigin) return false;
    if (!following.current || !available() || o.viewportOwner.currentOwner() !== 'follow-output') return false;
    const scroller = o.scrollerRef.current!;
    const next = Math.max(0, readFlowChatScrollTop(scroller) + byPx);
    // A short visible Turn keeps leading space beyond its natural content end.
    // Its predecessors already reflowed in the DOM, but that floor may still
    // describe the previous layout. Resolve it before a positive correction
    // can be clamped; easing the missing distance later would expose the shift.
    if (next > scroller.scrollHeight - scroller.clientHeight) o.readLayoutTarget();
    if (!o.viewportOwner.write({ owner: 'follow-output', topPx: next })) return false;
    target.current = Math.max(0, target.current + byPx);
    // The virtualizer publishes the actual offset after updating its size
    // cache. Publishing here would capture an anchor against the old sizes.
    return true;
  }, [available]);

  const handleScroll = useCallback(() => {
    const o = current.current;
    const demand = downward.current;
    const scroller = o.scrollerRef.current;
    if (!demand || !scroller || following.current || !available()) return;
    const position = o.viewportOwner.readReaderScrollPosition();
    // A passive layout/scroll event is not downward reader travel.
    if (position < demand.position - 0.5) { downward.current = null; return; }
    if (position > demand.position + 0.5
      && Math.abs(readFlowChatScrollTop(scroller) - o.readLayoutTarget()) <= 2) {
      enterFollowOutput('reader-at-bottom');
    }
  }, [available, enterFollowOutput]);
  const handleUserScrollIntent = useCallback((direction?: 'before' | 'after', reason: 'user-scroll' | 'reader-interaction' = 'user-scroll') => {
    exitFollowOutput(reason);
    const o = current.current;
    if (direction === 'after') {
      downward.current = { position: o.viewportOwner.readReaderScrollPosition() };
      const scroller = o.scrollerRef.current;
      if (scroller && Math.abs(readFlowChatScrollTop(scroller) - o.readLayoutTarget()) <= 2) {
        enterFollowOutput('reader-at-bottom');
      }
    }
  }, [enterFollowOutput, exitFollowOutput]);

  useLayoutEffect(() => {
    if (session.current !== options.activeSessionId) {
      exitFollowOutput('session-changed');
      session.current = options.activeSessionId;
      initialized.current = false;
    }
    if (!options.isViewportActive) {
      // Cancelling a deferred send also ends its pending-send phase. Keeping
      // that phase would strand follow on reactivation with no intent to place.
      if (phase.current === 'pending-send') exitFollowOutput('viewport-inactive');
      else { discardPending(); stop(); }
      return;
    }
    if (trySubmission()) return;
    if (!initialized.current && options.virtualItemCount > 0 && available()) {
      initialized.current = true;
      if (options.startAtTailOnMount !== false) enterFollowOutput('session-open');
    } else scheduleFollowToLatest();
  });
  useEffect(() => subscribeSubmittedMessageScrollIntent(() => refresh.current()), []);
  useEffect(() => {
    const scope = getActiveSurfaceScope();
    const cancel = () => exitFollowOutput('session-changed');
    scope.signal.addEventListener('abort', cancel, { once: true });
    return () => { scope.signal.removeEventListener('abort', cancel); };
  }, [exitFollowOutput]);
  useEffect(() => {
    const visible = () => { if (document.hidden) stop(); else refresh.current(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [stop]);
  useEffect(() => () => {
    stop();
    if (pending.current) finishSubmittedMessageScrollIntent(pending.current);
    const o = current.current;
    const intent = session.current ? claimSubmittedMessageScrollIntent(session.current, o.viewportId ?? 0, true) : null;
    if (intent) finishSubmittedMessageScrollIntent(intent);
    current.current.viewportOwner.release('follow-output');
  }, [stop]);

  // Completion changes no policy or target. The final rendered layout wakes
  // the same follower, including typewriter frames delivered after completion.
  return {
    isFollowingOutput, enterFollowOutput, exitFollowOutput, scheduleFollowToLatest, shiftLayout,
    isFollowingOutputNow: useCallback(() => following.current, []),
    isFollowCorrectingViewport: useCallback(() => following.current && !current.current.nativeEndOrigin, []),
    getFollowTargetScrollTop: useCallback(() => following.current
      ? current.current.nativeEndOrigin ? current.current.readLayoutTarget() : target.current : null, []),
    handleUserScrollIntent, handleScroll,
    handleTurnsRolledBack: useCallback(() => enterFollowOutput('turns-rolled-back'), [enterFollowOutput]),
    // Reading keeps its top anchor; following recomputes the reading line.
    handleViewportResize: useCallback((_input: ViewportResizeInput) => scheduleFollowToLatest(true), [scheduleFollowToLatest]),
  };
}
