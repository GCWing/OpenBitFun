/**
 * The register, wired to a live scroller.
 *
 * `flowChatViewportOwnership.ts` decides who may write; this holds the current
 * claim and performs the write. The two are one call on purpose: taking
 * ownership and moving the viewport being the same action is what keeps a new
 * writer from being added without the rest of FlowChat knowing about it.
 *
 * Everything here is refs. A claim changes many times per frame — the follow
 * loop renews on every one — and none of it belongs in a render.
 */

import { useCallback, useMemo, useRef, type RefObject } from 'react';
import {
  canShiftViewport,
  claimViewport,
  releaseViewport,
  type FlowChatViewportOwner,
  type ViewportClaim,
} from './flowChatViewportOwnership';
import { getMotionAwareScrollBehavior } from '../../utils/motionPreference';

export interface ViewportWriteRequest {
  owner: FlowChatViewportOwner;
  /** Offset in scroller coordinates. */
  topPx: number;
  behavior?: ScrollBehavior;
  /**
   * How long ownership stands after this write.
   *
   * Omitted holds it for the frame the write happens in, which is what a
   * correction wants. An animated write has to outlast its own animation, or
   * the first frame of travel is read as a displacement by whatever corrects
 * next — see the follow and viewport rules in `FLOWCHAT_SCROLL_STABILITY.md`.
   */
  holdForMs?: number;
}

export interface FlowChatViewportOwnerApi {
  /**
   * Take the viewport without writing it yet, for a writer whose movement is
   * issued by something else — a virtualizer aiming at an item, or a browser
   * animation. Returns whether the claim was granted.
   */
  claim: (owner: FlowChatViewportOwner, options?: { holdForMs?: number }) => boolean;
  /** Give it back. A writer that was preempted cannot release the new owner. */
  release: (owner: FlowChatViewportOwner) => void;
  /** Whether a displacement repair may act — see `canShiftViewport`. */
  canShift: () => boolean;
  /** The owner holding the viewport. Null when it is free. */
  currentOwner: () => FlowChatViewportOwner | null;
  /**
   * Move the viewport, if the register allows it. False means the write did
   * not happen — the caller has been outranked and must not fall back to
   * writing the scroller itself.
   */
  write: (request: ViewportWriteRequest) => boolean;
  /**
   * Move the viewport *by* an amount, because what it is showing moved by that
   * amount. Takes no ownership: a displacement has no opinion about where the
   * viewport belongs, so there is nothing for it to hold against anyone.
   *
   * Refused only by an owner that holds a target — see `canShiftViewport`. A
   * gesture is not one, and must not be: the reader chose a position in the
   * transcript, and this is what keeps that position meaning the same thing.
   */
  shift: (byPx: number) => boolean;
  /** Offset with this register's synchronous writes removed, for reader travel. */
  readReaderScrollPosition: () => number;
}

export function useFlowChatViewportOwner(
  scrollerRef: RefObject<HTMLElement | null>,
): FlowChatViewportOwnerApi {
  const claimRef = useRef<ViewportClaim | null>(null);
  const writtenTravelRef = useRef(0);

  /** Resolve ownership before either a claim or a write. */
  const takeViewport = useCallback((
    owner: FlowChatViewportOwner,
    holdForMs: number | undefined,
  ): boolean => {
    const nowMs = performance.now();
    const outcome = claimViewport(claimRef.current, { owner, nowMs, holdForMs });
    claimRef.current = outcome.claim;
    return outcome.granted;
  }, []);

  const claim = useCallback((
    owner: FlowChatViewportOwner,
    options?: { holdForMs?: number },
  ): boolean => {
    return takeViewport(owner, options?.holdForMs);
  }, [takeViewport]);

  const release = useCallback((owner: FlowChatViewportOwner) => {
    claimRef.current = releaseViewport(claimRef.current, owner);
  }, []);

  const canShift = useCallback(() => (
    canShiftViewport(claimRef.current, performance.now())
  ), []);

  const currentOwner = useCallback(() => {
    const nowMs = performance.now();
    const held = claimRef.current;
    return held && nowMs < held.expiresAtMs ? held.owner : null;
  }, []);

  const write = useCallback((request: ViewportWriteRequest): boolean => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    const granted = takeViewport(request.owner, request.holdForMs);
    const behavior = getMotionAwareScrollBehavior(
      request.behavior === 'smooth' ? 'smooth' : 'auto',
    );
    if (!granted) return false;
    if (behavior === 'smooth') {
      scroller.scrollTo({ top: request.topPx, behavior });
    } else {
      // Assigned rather than `scrollTo({behavior:'auto'})`: an assignment also
      // cancels any animation still running, which is what a writer taking the
      // viewport from an animated one means to do.
      const before = scroller.scrollTop;
      scroller.scrollTop = request.topPx;
      writtenTravelRef.current += scroller.scrollTop - before;
    }
    return true;
  }, [scrollerRef, takeViewport]);

  const shift = useCallback((byPx: number): boolean => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    const allowed = canShift();
    if (!allowed) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop += byPx;
    writtenTravelRef.current += scroller.scrollTop - before;
    return true;
  }, [canShift, scrollerRef]);

  const readReaderScrollPosition = useCallback(() => (
    (scrollerRef.current?.scrollTop ?? 0) - writtenTravelRef.current
  ), [scrollerRef]);

  return useMemo(() => ({
    claim,
    release,
    canShift,
    currentOwner,
    write,
    shift,
    readReaderScrollPosition,
  }), [canShift, claim, currentOwner, release, shift, write, readReaderScrollPosition]);
}
