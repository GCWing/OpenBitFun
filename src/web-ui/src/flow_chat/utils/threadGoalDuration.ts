import type { TFunction } from 'i18next';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * 60;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24;

/**
 * Elapsed time of a thread goal, spelled out in days, hours, minutes and seconds.
 *
 * A goal runs for as long as it takes, so a readout that collapses the whole
 * duration into a single unit stops being readable: "5400 seconds" says less than
 * "1 hour 30 minutes 0 seconds". Every unit the goal has reached is named, and the
 * seconds stay exact for the case of a goal that is only minutes old.
 */
export function formatThreadGoalElapsedSeconds(seconds: number, t: TFunction): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const days = Math.floor(total / SECONDS_PER_DAY);
  const hours = Math.floor(total / SECONDS_PER_HOUR) % 24;
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % 60;
  const remainingSeconds = total % SECONDS_PER_MINUTE;

  if (days > 0) {
    return t('threadGoal.duration.daysHoursMinutesSeconds', {
      days,
      hours,
      minutes,
      seconds: remainingSeconds,
    });
  }
  if (hours > 0) {
    return t('threadGoal.duration.hoursMinutesSeconds', {
      hours,
      minutes,
      seconds: remainingSeconds,
    });
  }
  if (minutes > 0) {
    return t('threadGoal.duration.minutesSeconds', { minutes, seconds: remainingSeconds });
  }
  return t('threadGoal.duration.seconds', { seconds: remainingSeconds });
}
