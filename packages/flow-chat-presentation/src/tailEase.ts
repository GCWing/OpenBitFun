/**
 * Easing a scroll offset towards the bottom of its own content.
 *
 * A follow that assigns the tail offset outright moves whenever the content
 * reflows, which for Markdown means a whole line at a time with nothing in
 * between. Easing spends the same distance over the frames that were empty.
 *
 * Worth being clear about what this can and cannot do, because it bounds what
 * any tuning is allowed to promise. Under steady growth the eased offset
 * settles where its per-frame catch-up equals the growth, so the visible step
 * converges on *the content's growth per frame* whatever `TAIL_EASE_ALPHA` is.
 * Smoothing does not make the tail move more slowly; it spreads a lumpy motion
 * evenly across the frames it already had. At eight lines a second that turns
 * one 24px jump every seven frames into 3px every frame; at thirty lines a
 * second the frames run out and the step stays around half a line.
 *
 * `TAIL_EASE_ALPHA` therefore buys latency, not smoothness: it sets how far
 * behind the tail the offset rides, which is what has to be given back when the
 * stream stops.
 *
 * This eases an offset, not a height. Offsets are the cheap case — scrolling
 * inside a box changes no layout outside it — which is why the decision here is
 * about how it looks and not about what it costs.
 */

/** Fraction of the remaining distance covered each frame. */
export const TAIL_EASE_ALPHA = 0.25;

/**
 * A line of FlowChat body text, near enough.
 *
 * Not used to lay anything out — it is the size of the step an unsmoothed
 * follow makes, and so the bar this one has to stay under to be worth having.
 */
export const TAIL_EASE_LINE_PX = 24;

/**
 * Distance past which the follow gives up on easing and jumps.
 *
 * Derived rather than chosen: the first frame of an ease covers `TAIL_EASE_ALPHA`
 * of the distance, so beyond a line's worth divided by that fraction, the ease's
 * *opening step* is already bigger than the jump it set out to replace. A
 * measured burst arriving 238px behind produced a single 59px step — two and a
 * half lines — before settling, which is worse than having simply jumped.
 *
 * So above this the follow jumps and says so. Below it, no step it takes can
 * exceed a line.
 */
export const TAIL_EASE_SNAP_ABOVE_PX = TAIL_EASE_LINE_PX / TAIL_EASE_ALPHA;

/** Below this the remaining distance is written out rather than halved again. */
export const TAIL_EASE_LANDED_PX = 0.5;

export type TailEaseOutcome =
  /** Moved part of the way; the follow should keep going next frame. */
  | 'eased'
  /** Went the whole way deliberately, because easing was not worth it. */
  | 'snapped'
  /** Arrived. Nothing more to do until the content moves again. */
  | 'landed';

export interface TailEaseStep {
  offsetPx: number;
  outcome: TailEaseOutcome;
}

/**
 * Where a following scroll offset should be written this frame.
 *
 * A target *above* the current offset is not eased. It means the content got
 * shorter — a fence closing, a table reflowing — and easing down through it
 * reads as the view being clawed backwards, which is worse than the jump it
 * replaces.
 */
export function nextEasedScrollTopPx(currentPx: number, targetPx: number): TailEaseStep {
  const distancePx = targetPx - currentPx;
  if (distancePx <= TAIL_EASE_LANDED_PX) {
    return { offsetPx: targetPx, outcome: 'landed' };
  }
  if (distancePx > TAIL_EASE_SNAP_ABOVE_PX) {
    return { offsetPx: targetPx, outcome: 'snapped' };
  }
  return { offsetPx: currentPx + distancePx * TAIL_EASE_ALPHA, outcome: 'eased' };
}

/**
 * Whether this follow should ease at all.
 *
 * Two conditions, and both are about cost rather than taste. A box that is not
 * yet overflowing has no scroll offset to ease — it is still growing, and
 * moving *that* smoothly would mean animating a height, which every frame
 * charges to the virtualizer. And a reader who asked for less motion is asking
 * about exactly this.
 */
export function shouldEaseTailFollow(options: {
  scrollHeightPx: number;
  clientHeightPx: number;
}): boolean {
  if (options.scrollHeightPx <= options.clientHeightPx) return false;
  return !prefersReducedMotion();
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
