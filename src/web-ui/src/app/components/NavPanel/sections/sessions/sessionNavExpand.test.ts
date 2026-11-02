import { describe, expect, it } from 'vitest';

import {
  getSessionDisplayLimit,
  getSessionExpandToggleState,
} from './sessionNavExpand';

describe('getSessionDisplayLimit', () => {
  it('keeps the grouped workspace list on its compact expansion levels', () => {
    expect(getSessionDisplayLimit({
      loadedTopLevelCount: 240,
      expandLevel: 0,
      level2DisplayCount: 200,
      showAllWithoutLimit: false,
    })).toBe(5);
    expect(getSessionDisplayLimit({
      loadedTopLevelCount: 240,
      expandLevel: 1,
      level2DisplayCount: 200,
      showAllWithoutLimit: false,
    })).toBe(10);
    expect(getSessionDisplayLimit({
      loadedTopLevelCount: 240,
      expandLevel: 2,
      level2DisplayCount: 200,
      showAllWithoutLimit: false,
    })).toBe(200);
  });

  it('shows every loaded aggregate session without a 200-row display cap', () => {
    expect(getSessionDisplayLimit({
      loadedTopLevelCount: 1_250,
      expandLevel: 0,
      level2DisplayCount: 200,
      showAllWithoutLimit: true,
    })).toBe(1_250);
  });
});

describe('getSessionExpandToggleState', () => {
  it('hides the toggle when five or fewer top-level sessions are available', () => {
    expect(getSessionExpandToggleState(1, 0)).toMatchObject({
      collapsedRemainingCount: 0,
      shouldRender: false,
    });
    expect(getSessionExpandToggleState(5, 0)).toMatchObject({
      collapsedRemainingCount: 0,
      shouldRender: false,
    });
  });

  it('shows the first expand step only when there are hidden top-level sessions', () => {
    expect(getSessionExpandToggleState(6, 0)).toMatchObject({
      action: 'show-more',
      collapsedRemainingCount: 1,
      shouldRender: true,
    });
  });

  it('switches to show-all and show-less using the remaining top-level count', () => {
    expect(getSessionExpandToggleState(12, 1)).toMatchObject({
      action: 'show-all',
      expandedRemainingCount: 2,
      shouldRender: true,
    });
    expect(getSessionExpandToggleState(6, 1)).toMatchObject({
      action: 'show-less',
      expandedRemainingCount: 0,
      shouldRender: true,
    });
    expect(getSessionExpandToggleState(12, 2)).toMatchObject({
      action: 'show-less',
      shouldRender: true,
    });
  });
});
