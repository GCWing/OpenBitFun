/**
 * Geometry for the element-anchored viewport keeper.
 *
 * The keeper restores a *relationship* — a Turn at an offset from the viewport
 * top — rather than replaying a scroll delta. That is what makes it idempotent:
 * applying it when nothing moved is a no-op, and applying it twice is the same
 * as applying it once. Every offset here is measured from the scroller's top
 * edge for the same reason. No absolute `scrollTop` survives a re-measure, but
 * the offset of a rendered Turn from the viewport top does.
 *
 * Nothing here knows which virtualizer placed the items, or that there is one.
 */

/**
 * DOM contract for the anchor element.
 *
 * A Turn's user message is the anchor: it is the one item every Turn has, it is
 * short enough that its own height rarely changes under a re-measure, and it is
 * what the reader is looking for when they scroll back through history.
 */
const TURN_ANCHOR_SELECTOR = '.virtual-item-wrapper[data-item-type="user-message"]';
const BLOCK_ANCHOR_SELECTOR = '.virtual-item-wrapper[data-virtual-item-key]';

/**
 * Where the user is reading, expressed as a Turn rather than an offset.
 *
 * `scrollTop` is not a stable description of a reading position in a list whose
 * item heights are discovered lazily: every late measurement rewrites the offset
 * of everything below it, so the same number means a different place.
 */
export interface ViewportAnchor {
  turnId: string;
  itemKey?: string;
  offsetFromScrollerTop: number;
}

export interface ViewportAnchorCandidate {
  turnId: string | null;
  itemKey?: string;
  offsetFromScrollerTop: number;
  bottomOffsetFromScrollerTop: number;
}

/**
 * How long after a wheel, touch, key, or scrollbar press the scrolling it
 * causes still counts as the user's.
 *
 * The anchor has to distinguish "the user went somewhere" from "the transcript
 * moved underneath them", and a scroll event says nothing about which. Intent
 * events do — but they fire *before* the scroll they cause, so the position
 * worth recording is the one that arrives shortly after, not the one at the
 * moment of the gesture. Recording at the gesture instead is what drags a
 * scrolling viewport backwards.
 *
 * Short enough that a mutation arriving in a pause is not mistaken for the
 * user. Deliberately *not* long enough to cover every scroll a gesture causes,
 * and it cannot be: the window runs from the input event while the scrolling it
 * authorises outlives it, and a busy main thread delivers the whole travel in
 * one event after it has closed. Measured over 181 seconds of reading:
 * fourteen gestures produced one capture.
 *
 * So this decides whether a *new* Turn is taken as the reading position, not
 * whether the reader's travel counts. A scroll that falls outside it and that
 * no registered writer owns is carried instead — see `captureAnchorForScroll`.
 */
export const USER_DRIVEN_SCROLL_WINDOW_MS = 200;

/**
 * Frames the viewport anchor keeps being re-asserted after the transcript moves.
 *
 * A virtualizer settles a prepend over several frames — a margin holds the
 * position, then the real item heights land in padding, then the margin is
 * released — and a margin change fires no ResizeObserver at all. There is
 * therefore no single callback that can catch every step, so the anchor is
 * re-asserted for a window instead. Measured: four consecutive painted frames
 * displaced by 896px before the correction arrived, which is the flicker.
 *
 * Refreshed whenever a correction is actually needed, so a long settle keeps
 * the window open rather than running out halfway through it.
 */
export const ANCHOR_SETTLE_FRAMES = 20;

/**
 * Attempts an anchored Turn may be missing from the rendered window before the
 * anchor is given up on.
 *
 * Absent for one frame is normal and absent for good is not, and only time
 * tells them apart. The virtualizer windows from a scroll offset it learns from
 * scroll events, so the commit that prepends history renders the position the
 * reader has just been moved off — the Turn arrives a frame later. Dropping on
 * the first miss threw the reading position away exactly there, at four
 * junctions in a row.
 *
 * Long enough to outlast that, and to cover the settle window it usually runs
 * inside; short enough that a Turn scrolled far out of the window is released
 * rather than held onto, since a stale anchor is a correction waiting to
 * happen. Reaching the end is not a failure — the next scroll anchors to a Turn
 * that is actually on screen.
 */
export const ANCHOR_MISSING_TURN_ATTEMPTS = 20;

/** Below this a correction is rounding, not movement. */
export const ANCHOR_CORRECTION_EPSILON_PX = 0.5;

/**
 * Above this a correction is something the reader can feel.
 *
 * Used to keep the two apart in the trail, and only there. Corrections repeat
 * at frame rate so they are coalesced, and a single run collapses whatever it
 * spans into its first sample: two rounds of diagnosis in a row read `0.7px`
 * against a suppressed travel of 458.7px over seven samples, which is a
 * different fault entirely and could not be attributed to any anchor. A run
 * that a real correction can fall into unseen is not a trail.
 */
export const ANCHOR_NOTABLE_CORRECTION_PX = 8;

/**
 * The topmost Turn the viewport still shows any part of.
 *
 * A candidate that has not reached the top edge yet is the one the reader is
 * looking at, so the first one whose bottom is inside the viewport wins. If
 * that candidate carries no Turn there is no anchor at all — falling through to
 * the next one would anchor to a Turn further down the screen than the one the
 * reading position belongs to.
 *
 * **Both edges are tested, and the bottom one is not optional.** A Turn marker
 * is the Turn's user message, which is short, so a reader inside an answer
 * taller than the viewport has no marker on screen at all — and "the first one
 * below the top edge" then answers with the *next* Turn, however far down that
 * is. Measured: anchored at an offset of 1695.5px with the scroller at most
 * 1325.7px tall, so the anchor was at least 370px below the bottom edge.
 *
 * That is not a near miss, it inverts what the anchor is for. Content above the
 * viewport re-measuring moves everything below it, the on-screen transcript
 * included, so a marker above the fold is a faithful proxy for what the reader
 * sees. Content *below* the viewport re-measuring moves nothing they can see —
 * so a marker below the fold reports movement that did not happen, and the
 * correction manufactures the displacement instead of repairing one.
 *
 * No anchor is the honest answer there, and it is the one this already gives
 * when every marker has gone off the top. A reader with no marker on screen
 * gets no correction; the next scroll takes one as soon as a Turn is visible.
 */
export function selectViewportAnchor(
  candidates: readonly ViewportAnchorCandidate[],
  viewportHeightPx: number,
): ViewportAnchor | null {
  const candidate = candidates.find(entry => (
    entry.bottomOffsetFromScrollerTop > 0 && entry.offsetFromScrollerTop < viewportHeightPx
  ));
  if (!candidate?.turnId) return null;
  return {
    turnId: candidate.turnId,
    ...(candidate.itemKey ? { itemKey: candidate.itemKey } : {}),
    offsetFromScrollerTop: candidate.offsetFromScrollerTop,
  };
}

/**
 * How far the anchored Turn has drifted from where it was.
 *
 * Positive means it moved down the screen, which is also how much `scrollTop`
 * has to grow to put it back — the sign is the correction, not its opposite.
 *
 * **Only meaningful against an anchor whose offset was agreed at the viewport
 * position it is being measured from.** A displacement moves the transcript
 * underneath a `scrollTop` that does not change; that is what makes it a
 * displacement. So any change to `scrollTop` since the offset was agreed
 * belongs to whoever made it, and has to be taken into the anchor before this
 * is asked — the caller does that, and the two halves move together there.
 *
 * Subtracting it here instead was tried and is why this note exists. It leaves
 * the offset and the position it was agreed at free to drift apart, and a frame
 * with nothing to correct then banks the reader's travel as a debt the next
 * frame collects: measured as a 32px scroll and an 81px scroll each reported
 * back as a correction of exactly itself.
 */
export function viewportAnchorCorrectionPx(
  anchor: ViewportAnchor,
  currentOffsetFromScrollerTop: number,
): number {
  return currentOffsetFromScrollerTop - anchor.offsetFromScrollerTop;
}

/**
 * Whether a scroll event should move the anchor to where the viewport now is.
 *
 * Keying off "did the content height change" instead does not work: lazy
 * measurement changes it on almost every frame, so the anchor froze seconds in
 * the past and the keeper spent its corrections dragging a scrolling viewport
 * backwards. Measured: 1075 blocked captures against 8 accepted ones, and a
 * 1037px correction against the user's own gesture.
 *
 * Having no anchor overrides the window, which is also what bootstraps the very
 * first one.
 *
 * False is not "ignore this scroll". It only means the scroll is not proof of a
 * new reading position; whether the reader's travel is credited is a separate
 * question, answered by who owns the viewport.
 */
export function shouldCaptureViewportAnchorOnScroll(
  hasAnchor: boolean,
  msSinceUserScrollIntent: number,
): boolean {
  return !hasAnchor || msSinceUserScrollIntent <= USER_DRIVEN_SCROLL_WINDOW_MS;
}

export function readViewportAnchorCandidates(scroller: HTMLElement): ViewportAnchorCandidate[] {
  const scrollerTop = scroller.getBoundingClientRect().top;
  return Array.from(
    scroller.querySelectorAll<HTMLElement>(`${BLOCK_ANCHOR_SELECTOR}, ${TURN_ANCHOR_SELECTOR}`),
  ).map(element => {
    const rect = element.getBoundingClientRect();
    return {
      turnId: element.dataset.turnId ?? null,
      itemKey: element.dataset.virtualItemKey,
      offsetFromScrollerTop: rect.top - scrollerTop,
      bottomOffsetFromScrollerTop: rect.bottom - scrollerTop,
    };
  });
}

export function findRenderedTurnAnchorElement(
  scroller: HTMLElement | null,
  turnId: string,
  itemKey?: string,
): HTMLElement | null {
  return Array.from(
    scroller?.querySelectorAll<HTMLElement>(itemKey ? BLOCK_ANCHOR_SELECTOR : TURN_ANCHOR_SELECTOR) ?? [],
  ).find(element => itemKey ? element.dataset.virtualItemKey === itemKey : element.dataset.turnId === turnId) ?? null;
}

export function readTurnAnchorOffsetPx(scroller: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}
