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
  isViewportDiagnosticsEnabled,
  roundViewportPx,
  traceViewportRepeating,
} from '@/infrastructure/diagnostics/flowChatViewportDiagnostics';
import {
  activeViewportClaim,
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
  /** The owner holding the viewport, for diagnostics. Null when it is free. */
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

  /**
   * Take the viewport and report who was holding it, which the register drops
   * once the outcome is known. Both public entry points go through this so a
   * write is one line in the log rather than a claim and a write.
   */
  const takeViewport = useCallback((
    owner: FlowChatViewportOwner,
    holdForMs: number | undefined,
  ): { granted: boolean; heldBy: FlowChatViewportOwner | null } => {
    const nowMs = performance.now();
    // Read before the claim resolves: on a refusal this is who refused, and on
    // a grant it is who was preempted, which is the same question either way.
    const heldBy = activeViewportClaim(claimRef.current, nowMs)?.owner ?? null;
    const outcome = claimViewport(claimRef.current, { owner, nowMs, holdForMs });
    claimRef.current = outcome.claim;
    return { granted: outcome.granted, heldBy };
  }, []);

  const claim = useCallback((
    owner: FlowChatViewportOwner,
    options?: { holdForMs?: number },
  ): boolean => {
    const { granted, heldBy } = takeViewport(owner, options?.holdForMs);
    if (isViewportDiagnosticsEnabled()) {
      traceViewportRepeating(`claim|${owner}|${granted}|${heldBy}`, {
        location: 'viewportOwner.claim',
        message: granted ? 'took the viewport' : 'refused the viewport',
        data: () => ({ owner, granted, heldBy, holdForMs: options?.holdForMs ?? null }),
      });
    }
    return granted;
  }, [takeViewport]);

  const release = useCallback((owner: FlowChatViewportOwner) => {
    const heldBy = claimRef.current?.owner ?? null;
    claimRef.current = releaseViewport(claimRef.current, owner);
    if (isViewportDiagnosticsEnabled() && heldBy !== null) {
      traceViewportRepeating(`release|${owner}|${heldBy}`, {
        location: 'viewportOwner.release',
        message: heldBy === owner
          ? 'gave the viewport back'
          : 'released nothing, having already been preempted',
        data: () => ({ owner, heldBy }),
      });
    }
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
    const { granted, heldBy } = takeViewport(request.owner, request.holdForMs);
    /*
     * The one place that sees every deliberate movement, and the only place a
     * refusal is visible at all — a writer that was outranked leaves no trace
     * anywhere else, and "nothing moved" is the more common complaint.
     */
    const behavior = getMotionAwareScrollBehavior(
      request.behavior === 'smooth' ? 'smooth' : 'auto',
    );
    if (isViewportDiagnosticsEnabled()) {
      const fromPx = scroller.scrollTop;
      traceViewportRepeating(`write|${request.owner}|${granted}|${heldBy}`, {
        location: 'viewportOwner.write',
        message: granted ? 'moved the viewport' : 'was refused the viewport',
        travelPx: request.topPx - fromPx,
        data: () => ({
          owner: request.owner,
          granted,
          heldBy,
          fromPx: roundViewportPx(fromPx),
          toPx: roundViewportPx(request.topPx),
          behavior,
          holdForMs: request.holdForMs ?? null,
        }),
      });
    }
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
    if (isViewportDiagnosticsEnabled()) {
      const fromPx = scroller.scrollTop;
      traceViewportRepeating(`shift|${allowed}|${currentOwner()}`, {
        location: 'viewportOwner.shift',
        message: allowed
          ? 'moved the viewport by what moved under it'
          : 'left the displacement to whoever holds a target',
        travelPx: byPx,
        data: () => ({
          allowed,
          heldBy: currentOwner(),
          fromPx: roundViewportPx(fromPx),
          byPx: roundViewportPx(byPx),
        }),
      });
    }
    if (!allowed) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop += byPx;
    writtenTravelRef.current += scroller.scrollTop - before;
    return true;
  }, [canShift, currentOwner, scrollerRef]);

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
