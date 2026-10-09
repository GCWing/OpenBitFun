import { expect, it } from 'vitest';
import { getNextAppUpdateCheckAt } from './appUpdateSchedule';

const hour = 60 * 60 * 1000;
const now = 10 * hour;
const state = { lastCheckedAt: now - 3 * hour, lastCheckAttemptAt: now - 3 * hour, consecutiveCheckFailures: 0 };

it('checks an overnight startup while keeping regular checks six hours apart', () => {
  expect(getNextAppUpdateCheckAt(state, 'startup', now)).toBeLessThan(now);
  expect(getNextAppUpdateCheckAt(state, 'automatic', now)).toBe(now + 3 * hour);
  expect(getNextAppUpdateCheckAt({ ...state, lastCheckedAt: now - hour }, 'startup', now)).toBe(now + hour);
  expect(getNextAppUpdateCheckAt(state, 'manual', now)).toBe(now);
});

it('retries once after thirty minutes and then backs off to six hours', () => {
  const failed = { ...state, lastCheckAttemptAt: now, consecutiveCheckFailures: 1 };
  expect(getNextAppUpdateCheckAt(failed, 'automatic', now)).toBe(now + hour / 2);
  expect(getNextAppUpdateCheckAt(failed, 'startup', now)).toBe(now + hour / 2);
  expect(getNextAppUpdateCheckAt({ ...failed, consecutiveCheckFailures: 2 }, 'automatic', now)).toBe(now + 6 * hour);
});

it('keeps a due check due across focus changes and recovers from clock rollback', () => {
  const due = { ...state, lastCheckedAt: now - 7 * hour };
  expect(getNextAppUpdateCheckAt(due, 'automatic', now + hour)).toBe(now - hour);
  expect(getNextAppUpdateCheckAt({ ...state, lastCheckedAt: now + hour }, 'automatic', now)).toBe(now);
  expect(getNextAppUpdateCheckAt({ ...state, lastCheckedAt: null }, 'startup', now)).toBe(now);
});
