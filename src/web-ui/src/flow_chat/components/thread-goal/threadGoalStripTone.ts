import type { ThreadGoalSnapshot } from '../../services/goalService';

/**
 * A thread goal drives turns on its own, so a goal that has stopped driving
 * them must not look like one that is running. Running, parked, and stuck are
 * three different situations, and colour is the track's only state channel —
 * the goal control carries no outline. `complete` is the quiet one: it is the
 * only state that is not waiting for the user.
 */
export type ThreadGoalStripTone = 'active' | 'paused' | 'blocked' | 'complete';

function normalizeThreadGoalStatus(status: string | undefined): string {
  const raw = status?.trim() ?? '';
  if (!raw) {
    return '';
  }
  const camel = raw.charAt(0).toLowerCase() + raw.slice(1);
  if (camel === 'usage_limited') {
    return 'usageLimited';
  }
  if (camel === 'budget_limited') {
    return 'budgetLimited';
  }
  return camel;
}

export function resolveThreadGoalStripTone(
  goal: Pick<ThreadGoalSnapshot, 'status'>,
): ThreadGoalStripTone {
  switch (normalizeThreadGoalStatus(goal.status)) {
    case 'paused':
      return 'paused';
    // A goal out of budget or out of quota is stuck for the same reason as one
    // the runtime blocked: it will not advance until the user acts.
    case 'blocked':
    case 'usageLimited':
    case 'budgetLimited':
      return 'blocked';
    case 'complete':
      return 'complete';
    // `active` and anything this build cannot name: a goal that exists is not
    // the absence of one, and the tooltip still carries its literal status.
    default:
      return 'active';
  }
}
