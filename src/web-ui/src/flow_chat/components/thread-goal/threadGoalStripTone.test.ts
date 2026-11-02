import { describe, expect, it } from 'vitest';

import { resolveThreadGoalStripTone } from './threadGoalStripTone';

describe('resolveThreadGoalStripTone', () => {
  it('keeps a running goal on the accent tone', () => {
    expect(resolveThreadGoalStripTone({ status: 'active' })).toBe('active');
  });

  it('separates a parked goal from one the runtime blocked', () => {
    expect(resolveThreadGoalStripTone({ status: 'paused' })).toBe('paused');
    expect(resolveThreadGoalStripTone({ status: 'blocked' })).toBe('blocked');
  });

  it('treats exhausted quota and exhausted budget as the same stuck state', () => {
    expect(resolveThreadGoalStripTone({ status: 'usageLimited' })).toBe('blocked');
    expect(resolveThreadGoalStripTone({ status: 'budgetLimited' })).toBe('blocked');
    // A runtime that still reports the snake_case spelling names the same state.
    expect(resolveThreadGoalStripTone({ status: 'usage_limited' })).toBe('blocked');
    expect(resolveThreadGoalStripTone({ status: 'budget_limited' })).toBe('blocked');
  });

  it('quiets a finished goal', () => {
    expect(resolveThreadGoalStripTone({ status: 'complete' })).toBe('complete');
  });

  it('keeps a goal this build cannot name visible instead of hiding it', () => {
    expect(resolveThreadGoalStripTone({ status: '' })).toBe('active');
    expect(resolveThreadGoalStripTone({ status: 'queued' })).toBe('active');
  });
});
