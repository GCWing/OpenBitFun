export const APP_UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export const APP_UPDATE_STARTUP_INTERVAL = 2 * 60 * 60 * 1000;
export const APP_UPDATE_RETRY_INTERVAL = 30 * 60 * 1000;
export type AppUpdateCheckSource = 'manual' | 'automatic' | 'startup';

interface CheckScheduleState {
  lastCheckedAt: number | null;
  lastCheckAttemptAt: number | null;
  consecutiveCheckFailures: number;
}

/** Due times are anchored to completed checks, not to window visibility changes. */
export function getNextAppUpdateCheckAt(state: CheckScheduleState, source: AppUpdateCheckSource = 'automatic', now = Date.now()): number {
  if (source === 'manual') return now;
  const { lastCheckAttemptAt, lastCheckedAt, consecutiveCheckFailures } = state;
  if (consecutiveCheckFailures > 0 && lastCheckAttemptAt !== null && lastCheckAttemptAt <= now) {
    return lastCheckAttemptAt + (consecutiveCheckFailures === 1 ? APP_UPDATE_RETRY_INTERVAL : APP_UPDATE_CHECK_INTERVAL);
  }
  if (lastCheckedAt === null || lastCheckedAt > now) return now;
  return lastCheckedAt + (source === 'startup' ? APP_UPDATE_STARTUP_INTERVAL : APP_UPDATE_CHECK_INTERVAL);
}
