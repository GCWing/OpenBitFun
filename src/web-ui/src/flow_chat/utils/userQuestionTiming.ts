import type { FlowToolItem } from '../types/flow-chat';

/** Calibrate once on receipt; advancing the display never uses the client wall clock. */
export function projectUserQuestionTiming(
  payload: unknown,
  interactionStarted = false,
): NonNullable<FlowToolItem['userQuestionWait']> {
  const timing = payload as { responseDeadlineMs?: unknown; responseHostNowMs?: unknown } | null;
  const deadline = timing?.responseDeadlineMs;
  const hostNow = timing?.responseHostNowMs;
  const validDeadline = typeof deadline === 'number' && Number.isFinite(deadline);
  return {
    deadlineMs: deadline === null || validDeadline ? deadline : undefined,
    monotonicDeadlineMs: validDeadline
      ? performance.now() + Math.max(0, deadline - (
          typeof hostNow === 'number' && Number.isFinite(hostNow) ? hostNow : Date.now()
        ))
      : undefined,
    interactionStarted,
  };
}
