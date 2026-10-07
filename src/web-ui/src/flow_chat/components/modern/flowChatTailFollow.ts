/** Desktop reading geometry. The physical end and the follow target are one offset. */
export const FLOWCHAT_TURN_TOP_GAP_PX = 8;
export const FLOWCHAT_AT_CONTENT_END_THRESHOLD_PX = 2;
export const FLOWCHAT_ANIMATED_JUMP_MAX_VIEWPORTS = 3;
export const FLOWCHAT_READING_LINE_RATIO = 0.618;

/** Slightly below center, within the readable area above composer clearance. */
export function readingLinePxForViewport(clientHeight: number, bottomInsetPx: number): number {
  const top = Math.min(FLOWCHAT_TURN_TOP_GAP_PX, clientHeight);
  return top + Math.max(0, clientHeight - bottomInsetPx - top) * FLOWCHAT_READING_LINE_RATIO;
}

/** The footer already provides part of the blank below the reading line. */
export function tailSpacerPxForViewport(clientHeight: number, bottomInsetPx: number): number {
  return Math.max(0, clientHeight - readingLinePxForViewport(clientHeight, bottomInsetPx) - bottomInsetPx);
}

export function contentEndScrollTop(geometry: {
  scrollHeight: number; clientHeight: number;
}): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
}

/** Keep the latest Turn top reachable even after a tall card folds away. */
export function turnTopScrollTop(turnStartPx: number): number {
  return Math.max(0, turnStartPx - FLOWCHAT_TURN_TOP_GAP_PX);
}

export function turnTopAlignmentEntersReservedBlank(input: {
  turnTopScrollTop: number; contentEndScrollTop: number;
}): boolean {
  return input.turnTopScrollTop > input.contentEndScrollTop;
}

export function isViewportAtTail(input: {
  scrollTop: number; contentEndScrollTop: number; followTargetScrollTop: number; thresholdPx: number;
}): boolean {
  return Math.abs(input.scrollTop - input.contentEndScrollTop) <= input.thresholdPx;
}

export function resolveAnimatedJumpBehavior(input: {
  fromPx: number; targetPx: number; clientHeight: number;
}): 'smooth' | 'auto' {
  return input.clientHeight > 0 && Math.abs(input.targetPx - input.fromPx)
    <= input.clientHeight * FLOWCHAT_ANIMATED_JUMP_MAX_VIEWPORTS ? 'smooth' : 'auto';
}

/** Time-based easing, independent of display refresh rate. No overshoot. */
export function easeFollowOffset(from: number, target: number, elapsedMs: number): number {
  if (Math.abs(target - from) <= 1) return target;
  return from + (target - from) * (1 - Math.exp(-Math.max(0, elapsedMs) / 65));
}
