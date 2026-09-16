import { afterEach, expect, it, vi } from 'vitest';
import { projectUserQuestionTiming } from './userQuestionTiming';

afterEach(() => vi.restoreAllMocks());
it('calibrates against host time regardless of controller clock offset', () => {
  vi.spyOn(performance, 'now').mockReturnValue(100);
  vi.spyOn(Date, 'now').mockReturnValue(999999999);
  expect(projectUserQuestionTiming({ responseDeadlineMs: 200000, responseHostNowMs: 80000 }))
    .toEqual({ deadlineMs: 200000, monotonicDeadlineMs: 120100, interactionStarted: false });
});
it('uses the refreshed host time when reattaching', () => {
  vi.spyOn(performance, 'now').mockReturnValue(500);
  expect(projectUserQuestionTiming({ responseDeadlineMs: 200000, responseHostNowMs: 190000 }).monotonicDeadlineMs).toBe(10500);
});
it('preserves unlimited and unknown legacy payloads without inventing a timeout', () => {
  expect(projectUserQuestionTiming({ responseDeadlineMs: null }).deadlineMs).toBeNull();
  expect(projectUserQuestionTiming({}).deadlineMs).toBeUndefined();
});
