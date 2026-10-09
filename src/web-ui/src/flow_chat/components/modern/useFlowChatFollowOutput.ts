import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { traceViewportRepeating } from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
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
export type FollowOutputExitReason = 'session-changed' | 'user-scroll' | 'reader-interaction' | 'scroll-to-turn' | 'scroll-to-index';
export interface ViewportResizeInput { viewportHeightDeltaPx: number; wasAtTail: boolean }

interface Options {
  activeSessionId?: string;
  virtualItemCount: number;
  isStreaming: boolean;
  isViewportActive: boolean;
  startAtTailOnMount?: boolean;
  isViewportSuspended?: () => boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  /** Refresh layout geometry once per layout signal; frames reuse this result. */
  readLayoutTarget: () => number;
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
  const submittedTurn = useRef<string | null>(null);
  const target = useRef(0);
  const frame = useRef<number | null>(null);
  const lastFrameAt = useRef<number | null>(null);
  const downward = useRef<{ position: number } | null>(null);
  const initialized = useRef(false);
  const session = useRef(options.activeSessionId);
  const run = useRef<(now: number) => void>(() => {});
  const refresh = useRef<() => void>(() => {});

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    lastFrameAt.current = null;
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
    if (pending.current) finishSubmittedMessageScrollIntent(pending.current);
    const o = current.current;
    const unbound = session.current ? claimSubmittedMessageScrollIntent(session.current, o.viewportId ?? 0, true) : null;
    if (unbound) finishSubmittedMessageScrollIntent(unbound);
    pending.current = null;
    current.current.cancelPendingPlacement();
  }, []);
  const exitFollowOutput = useCallback((reason: FollowOutputExitReason) => {
    const o = current.current;
    following.current = false;
    phase.current = 'reading';
    downward.current = null;
    discardPending();
    setIsFollowingOutput(false);
    stop();
    o.viewportOwner.release('follow-output');
    traceViewportRepeating(`follow|exit|${reason}`, {
      location: 'followOutput.exit', message: 'The reader owns the viewport',
      data: () => ({ reason, viewportId: o.viewportId }),
    });
  }, [discardPending, stop]);

  run.current = now => {
    frame.current = null;
    if (!following.current || !available()) { lastFrameAt.current = null; return; }
    const o = current.current;
    const scroller = o.scrollerRef.current!;
    if (phase.current === 'pending-send' || phase.current === 'awaiting-output') {
      lastFrameAt.current = null;
      return;
    }
    const from = scroller.scrollTop;
    // The browser may already have clamped a shrinking layout before its
    // ResizeObserver is delivered. Never animate toward an unreachable cache
    // entry, or leave an idle RAF chasing it until the next token arrives.
    const reachableTarget = Math.min(target.current, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    const elapsed = lastFrameAt.current === null ? 16 : Math.min(64, now - lastFrameAt.current);
    lastFrameAt.current = now;
    const opening = o.isOpeningViewport();
    const candidate = opening || getMotionAwareScrollBehavior('smooth') === 'auto'
      ? reachableTarget : easeFollowOffset(from, reachableTarget, elapsed);
    const next = Math.abs(candidate - reachableTarget) <= EPSILON ? reachableTarget : candidate;
    if (Math.abs(reachableTarget - from) > EPSILON) {
      // Refusal leaves the target intact. A short live gesture can outlast the
      // reader's deliberate arrival at bottom; it still outranks every write.
      if (o.viewportOwner.write({ owner: 'follow-output', topPx: next })) o.onViewportOffset?.(scroller.scrollTop);
    } else if (from !== reachableTarget) {
      if (o.viewportOwner.write({ owner: 'follow-output', topPx: reachableTarget })) o.onViewportOffset?.(scroller.scrollTop);
    }
    if (Math.abs(scroller.scrollTop - reachableTarget) > EPSILON) wake();
    else lastFrameAt.current = null;
  };

  const enterFollowOutput = useCallback((reason: FollowOutputEnterReason) => {
    if (!available()) return;
    const o = current.current;
    discardPending();
    downward.current = null;
    submittedTurn.current = null;
    o.cancelNavigation();
    o.viewportOwner.release('one-shot-navigation');
    if (reason !== 'reader-at-bottom') o.viewportOwner.release('user-gesture');
    o.viewportOwner.claim('follow-output');
    following.current = true;
    phase.current = 'following';
    setIsFollowingOutput(true);
    target.current = o.readLayoutTarget();
    const scroller = o.scrollerRef.current!;
    const animate = reason === 'jump-to-latest' && resolveAnimatedJumpBehavior({
      fromPx: scroller.scrollTop, targetPx: target.current, clientHeight: scroller.clientHeight,
    }) === 'smooth';
    if (!animate && reason !== 'reader-at-bottom') {
      if (o.viewportOwner.write({ owner: 'follow-output', topPx: target.current })) o.onViewportOffset?.(scroller.scrollTop);
    }
    traceViewportRepeating(`follow|enter|${reason}`, {
      location: 'followOutput.enter', message: 'Following the desktop reading line',
      data: () => ({ reason, viewportId: o.viewportId, targetPx: target.current }),
    });
    wake();
  }, [available, discardPending, wake]);

  const trySubmission = useCallback(() => {
    const o = current.current;
    if (!o.activeSessionId || !available()) return false;
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
      following.current = false;
      phase.current = 'reading';
      setIsFollowingOutput(false);
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
      following.current = true;
      setIsFollowingOutput(true);
    }
    if (!pending.current) return false;
    if (!pending.current.scope.isCurrent()) { exitFollowOutput('session-changed'); return false; }
    const placed = o.placeSubmittedMessage(pending.current);
    if (placed === null) return true;
    submittedTurn.current = pending.current.turnId;
    finishSubmittedMessageScrollIntent(pending.current);
    pending.current = null;
    phase.current = 'awaiting-output';
    target.current = placed;
    initialized.current = true;
    return true;
  }, [available, exitFollowOutput, stop]);

  const scheduleFollowToLatest = useCallback(() => {
    if (!available()) return;
    if (trySubmission()) return;
    const o = current.current;
    const next = o.readLayoutTarget();
    if (!following.current) return; // Growth can never take control from a reader.
    if (phase.current === 'awaiting-output') {
      if (!submittedTurn.current || !o.hasRenderedOutput(submittedTurn.current)) return;
      if (next <= target.current + EPSILON) return;
      phase.current = 'following';
    }
    target.current = next;
    traceViewportRepeating(`follow|layout|${o.viewportId}|${phase.current}`, {
      location: 'followOutput.layout', message: 'Refreshed the physical follow endpoint',
      data: () => ({ viewportId: o.viewportId, phase: phase.current, targetPx: next,
        scrollTopPx: o.scrollerRef.current?.scrollTop, itemCount: o.virtualItemCount }),
    });
    if (o.isOpeningViewport()) {
      if (o.viewportOwner.write({ owner: 'follow-output', topPx: next })) o.onViewportOffset?.(o.scrollerRef.current!.scrollTop);
    }
    wake();
  }, [available, trySubmission, wake]);
  refresh.current = scheduleFollowToLatest;

  const handleScroll = useCallback(() => {
    const o = current.current;
    const demand = downward.current;
    const scroller = o.scrollerRef.current;
    if (!demand || !scroller || following.current || !available()) return;
    const position = o.viewportOwner.readReaderScrollPosition();
    // A passive layout/scroll event is not downward reader travel.
    if (position < demand.position - 0.5) { downward.current = null; return; }
    if (position > demand.position + 0.5
      && Math.abs(scroller.scrollTop - o.readLayoutTarget()) <= 2) {
      enterFollowOutput('reader-at-bottom');
    }
  }, [available, enterFollowOutput]);
  const handleUserScrollIntent = useCallback((direction?: 'before' | 'after', reason: 'user-scroll' | 'reader-interaction' = 'user-scroll') => {
    exitFollowOutput(reason);
    const o = current.current;
    if (direction === 'after') {
      downward.current = { position: o.viewportOwner.readReaderScrollPosition() };
      const scroller = o.scrollerRef.current;
      if (scroller && Math.abs(scroller.scrollTop - o.readLayoutTarget()) <= 2) {
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
    if (!options.isViewportActive) { discardPending(); stop(); return; }
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
    isFollowingOutput, enterFollowOutput, exitFollowOutput, scheduleFollowToLatest,
    isFollowingOutputNow: useCallback(() => following.current, []),
    isFollowCorrectingViewport: useCallback(() => following.current, []),
    getFollowTargetScrollTop: useCallback(() => following.current ? target.current : null, []),
    handleUserScrollIntent, handleScroll,
    handleTurnsRolledBack: useCallback(() => enterFollowOutput('turns-rolled-back'), [enterFollowOutput]),
    // Reading keeps its top anchor; following recomputes the reading line.
    handleViewportResize: useCallback((_input: ViewportResizeInput) => scheduleFollowToLatest(), [scheduleFollowToLatest]),
  };
}
