/** Rows a workspace shows before the user asks for more. */
export const SESSIONS_INITIAL_COUNT = 3;
/** Rows each "show more" adds. */
export const SESSIONS_SHOW_MORE_STEP = 5;
/** Rows read ahead of what is shown, so the next "show more" is instant. */
export const SESSIONS_PREFETCH_COUNT = SESSIONS_SHOW_MORE_STEP;
/** Page size for complete traversals (flat view, archived projections). */
export const SESSIONS_LEVEL_2_PAGE = 200;

export type SessionExpandToggleAction = 'show-more' | 'show-less';

export interface SessionExpandToggleState {
  action: SessionExpandToggleAction;
  /** Rows not shown yet. */
  remainingCount: number;
  shouldRender: boolean;
}

export function getSessionDisplayLimit(params: {
  loadedTopLevelCount: number;
  displayCount: number;
  showAllWithoutLimit: boolean;
}): number {
  const { loadedTopLevelCount, displayCount, showAllWithoutLimit } = params;
  return showAllWithoutLimit ? loadedTopLevelCount : Math.min(loadedTopLevelCount, displayCount);
}

export function getSessionExpandToggleState(
  totalTopLevelSessionCount: number,
  displayCount: number,
): SessionExpandToggleState {
  const remainingCount = Math.max(totalTopLevelSessionCount - displayCount, 0);
  return {
    action: remainingCount > 0 ? 'show-more' : 'show-less',
    remainingCount,
    shouldRender: totalTopLevelSessionCount > SESSIONS_INITIAL_COUNT,
  };
}

/** "Show more" adds a step; once everything is shown the toggle collapses. */
export function nextSessionDisplayCount(displayCount: number, totalTopLevelSessionCount: number): number {
  return totalTopLevelSessionCount > displayCount ? displayCount + SESSIONS_SHOW_MORE_STEP : SESSIONS_INITIAL_COUNT;
}
