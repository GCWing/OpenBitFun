/**
 * When looking at the transcript should pull more of it in.
 *
 * This is the policy half of history paging: it decides *that* a boundary is
 * worth asking about, from where the reader is and nothing else. Whether the
 * ask is honoured — budgets, in-flight requests, exhausted directions — belongs
 * to the container, and how the position was arrived at belongs to whatever is
 * placing the items.
 *
 * Physical arrival and the one-screen prefetch lead are separate geometry
 * questions. Neither creates demand or re-arms requests: FlowChatHistoryPager
 * owns permission from reader intent, request results and committed layout.
 */

import type { SessionHistoryWindowDirection } from '../../store/FlowChatStore';

export interface VisibleItemRange {
  startIndex: number;
  endIndex: number;
}

/**
 * How close to the first item counts as reaching for older Turns.
 *
 * One item of slack, not zero: the leading item is a user message a couple of
 * dozen pixels tall, so a reader who has arrived at it is already looking at
 * the top of the window, and waiting for it to be the *only* thing on screen
 * would start the fetch after the blank appears rather than before.
 */
const LEADING_ITEM_SLACK = 1;

/**
 * How close to the last item counts as reaching for newer Turns.
 *
 * Two items, because the trailing edge of a Turn is a model round followed by
 * its user message, and reaching the round means the window ends within a
 * screen or so.
 */
const TRAILING_ITEM_SLACK = 2;

/**
 * How far ahead of the boundary the fetch goes out, in screenfuls.
 *
 * A page is not a quiet event. The items arrive above the reader and everything
 * below them moves; the virtualizer picks its window from a scroll offset it
 * only learns from scroll events, so for one commit it renders from a position
 * the reader has already been moved off and the transcript under them goes
 * blank; the rows then measure and the whole thing settles a second time. All
 * of that is correct and all of it is visible — the reader described it as a
 * flicker and a jolt, at the junction, every time.
 *
 * None of it is visible if it happens off screen. Asking a screenful early puts
 * the junction above the viewport: the reader keeps scrolling into content that
 * is already there and already measured. It costs one page of history fetched
 * slightly sooner than it is needed, and nothing at all on session open, where
 * the boundary is a whole transcript away.
 *
 * One screen rather than two because the lead only has to outlast the fetch. At
 * a brisk wheel scroll the reader covers a few hundred pixels in the time a
 * page takes to arrive from local storage, and a lead longer than it needs to
 * be just loads history nobody reaches.
 */
export const HISTORY_BOUNDARY_LEAD_SCREENS = 1;

/**
 * How much transcript is left between the reader and each end of what is loaded.
 *
 * In scroller coordinates, so these are distances the reader still has to
 * travel — the same space `scrollTop` is in. The heights they are composed of
 * are estimates wherever an item has not been rendered yet, which is exactly
 * the space above a reader who is scrolling up; that makes this an honest
 * measure of remaining scroll and a poor one of remaining content, and
 * remaining scroll is the question.
 */
export interface HistoryBoundaryProximity {
  /** From the top edge of the viewport back to the start of the first item. */
  aboveViewportPx: number;
  /** From the bottom edge of the viewport on to the end of the last item. */
  belowViewportPx: number;
  /** One screenful, which is the unit the lead is expressed in. */
  viewportHeightPx: number;
}

/**
 * Directions the visible range is sitting on — the reader has arrived.
 *
 * This excludes the prefetch lead and is useful for describing actual arrival.
 *
 * `'after'` only applies to a history window. A tail presentation is already
 * anchored to the newest Turn, so there is nothing past its end to fetch.
 */
export function historyBoundariesReached(
  range: VisibleItemRange,
  itemCount: number,
  presentationMode: 'tail' | 'history-window',
): SessionHistoryWindowDirection[] {
  const directions: SessionHistoryWindowDirection[] = [];
  if (range.startIndex <= LEADING_ITEM_SLACK) {
    directions.push('before');
  }
  if (presentationMode === 'history-window' && range.endIndex >= itemCount - TRAILING_ITEM_SLACK) {
    directions.push('after');
  }
  return directions;
}

/**
 * Directions worth asking about from where the reader stands.
 *
 * Everything already reached, plus everything within a screenful of being
 * reached. Never the other way round: the lead is an argument for asking
 * sooner, not for calling a boundary arrived at.
 *
 * `proximity` is null when the geometry cannot be read — no scroller, or an end
 * of the transcript the virtualizer has no place for yet. The item range still
 * answers, so a boundary that is genuinely on screen is never missed for want
 * of a measurement; only the lead is lost.
 */
export function historyBoundariesForVisibleRange(
  range: VisibleItemRange,
  itemCount: number,
  presentationMode: 'tail' | 'history-window',
  proximity: HistoryBoundaryProximity | null = null,
): SessionHistoryWindowDirection[] {
  const reached = new Set(historyBoundariesReached(range, itemCount, presentationMode));
  if (proximity === null) return [...reached];

  const leadPx = Math.max(0, proximity.viewportHeightPx) * HISTORY_BOUNDARY_LEAD_SCREENS;
  const directions: SessionHistoryWindowDirection[] = [];
  if (reached.has('before') || proximity.aboveViewportPx <= leadPx) {
    directions.push('before');
  }
  if (
    presentationMode === 'history-window' &&
    (reached.has('after') || proximity.belowViewportPx <= leadPx)
  ) {
    directions.push('after');
  }
  return directions;
}
