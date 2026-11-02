export const SESSIONS_LEVEL_0 = 5;
export const SESSIONS_LEVEL_1 = 10;

export type SessionExpandLevel = 0 | 1 | 2;
export type SessionExpandToggleAction = 'show-more' | 'show-all' | 'show-less';

export interface SessionExpandToggleState {
  action: SessionExpandToggleAction;
  collapsedRemainingCount: number;
  expandedRemainingCount: number;
  shouldRender: boolean;
}

export function getSessionDisplayLimit(params: {
  loadedTopLevelCount: number;
  expandLevel: SessionExpandLevel;
  level2DisplayCount: number;
  showAllWithoutLimit: boolean;
}): number {
  const {
    loadedTopLevelCount,
    expandLevel,
    level2DisplayCount,
    showAllWithoutLimit,
  } = params;

  if (showAllWithoutLimit) {
    return loadedTopLevelCount;
  }
  if (expandLevel === 2) {
    return Math.min(loadedTopLevelCount, level2DisplayCount);
  }
  if (loadedTopLevelCount <= SESSIONS_LEVEL_0) {
    return loadedTopLevelCount;
  }
  if (expandLevel === 1) {
    return Math.min(loadedTopLevelCount, SESSIONS_LEVEL_1);
  }
  return SESSIONS_LEVEL_0;
}

export function getSessionExpandToggleState(
  totalTopLevelSessionCount: number,
  expandLevel: SessionExpandLevel
): SessionExpandToggleState {
  const collapsedRemainingCount = Math.max(totalTopLevelSessionCount - SESSIONS_LEVEL_0, 0);
  const expandedRemainingCount = Math.max(totalTopLevelSessionCount - SESSIONS_LEVEL_1, 0);

  return {
    action:
      expandLevel === 0
        ? 'show-more'
        : expandLevel === 1 && expandedRemainingCount > 0
          ? 'show-all'
          : 'show-less',
    collapsedRemainingCount,
    expandedRemainingCount,
    shouldRender: collapsedRemainingCount > 0,
  };
}
