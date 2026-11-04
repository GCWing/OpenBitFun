import { describe, expect, it } from 'vitest';
import {
  getSessionDisplayLimit,
  getSessionExpandToggleState,
  nextSessionDisplayCount,
  SESSIONS_INITIAL_COUNT,
} from './sessionNavExpand';

describe('session list expansion', () => {
  it('shows three rows first and adds five per "show more"', () => {
    expect(SESSIONS_INITIAL_COUNT).toBe(3);
    expect(nextSessionDisplayCount(3, 20)).toBe(8);
    expect(nextSessionDisplayCount(8, 20)).toBe(13);
    expect(nextSessionDisplayCount(18, 20)).toBe(23);
  });

  it('collapses once everything is shown', () => {
    expect(getSessionExpandToggleState(20, 23)).toMatchObject({ action: 'show-less', remainingCount: 0 });
    expect(nextSessionDisplayCount(23, 20)).toBe(3);
  });

  it('counts what is left and hides the toggle for short lists', () => {
    expect(getSessionExpandToggleState(20, 3)).toMatchObject({ action: 'show-more', remainingCount: 17, shouldRender: true });
    expect(getSessionExpandToggleState(3, 3).shouldRender).toBe(false);
    expect(getSessionExpandToggleState(4, 3).shouldRender).toBe(true);
  });

  it('limits rows to the count unless the view shows everything', () => {
    expect(getSessionDisplayLimit({ loadedTopLevelCount: 20, displayCount: 8, showAllWithoutLimit: false })).toBe(8);
    expect(getSessionDisplayLimit({ loadedTopLevelCount: 2, displayCount: 8, showAllWithoutLimit: false })).toBe(2);
    expect(getSessionDisplayLimit({ loadedTopLevelCount: 20, displayCount: 3, showAllWithoutLimit: true })).toBe(20);
  });
});
