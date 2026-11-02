import type { UsageTrendPoint } from '@/infrastructure/api';
import { createCalendarDateKeyFormatter } from '@/infrastructure/i18n/core/I18nService';

const DAY_MS = 24 * 60 * 60 * 1000;

function calendarWindow(timeZone: string, now: Date) {
  const dateKey = createCalendarDateKeyFormatter(timeZone);
  const end = Date.parse(`${dateKey(now)}T00:00:00Z`);
  const endDate = new Date(end);
  const startMonth = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 6, 1));
  const lastDayOfStartMonth = new Date(Date.UTC(
    startMonth.getUTCFullYear(), startMonth.getUTCMonth() + 1, 0,
  )).getUTCDate();
  startMonth.setUTCDate(Math.min(endDate.getUTCDate(), lastDayOfStartMonth) + 1);
  return { start: startMonth.getTime(), end, dateKey };
}

export function usageActivityRequestRange(timeZone: string, now: Date) {
  const { start } = calendarWindow(timeZone, now);
  return {
    // Include the whole first local day for every UTC offset, including DST.
    // The calendar projection discards the extra leading bucket.
    start: new Date(start - DAY_MS).toISOString(),
    end: now.toISOString(),
  };
}

export interface UsageActivityDay {
  key: string;
  /** UTC representation of a calendar date in the selected statistics time zone. */
  date: Date;
  tokens: number;
  level: number;
  inRange: boolean;
}

export function buildUsageActivity(
  points: UsageTrendPoint[],
  timeZone: string,
  now: Date,
) {
  const { start, end, dateKey } = calendarWindow(timeZone, now);
  const totals = new Map<string, number>();
  for (const point of points) {
    const date = new Date(point.bucket);
    if (!Number.isFinite(date.getTime())) continue;
    const key = dateKey(date);
    // Cache reads and writes are already included in inputTokens.
    totals.set(key, (totals.get(key) ?? 0) + point.inputTokens + point.outputTokens);
  }

  // Monday-first weeks. Blank cells are padding, never future usage records.
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const gridStart = start - offset * DAY_MS;
  const dayCount = (end - start) / DAY_MS + 1;
  const weekCount = Math.ceil((dayCount + offset) / 7);
  const days: UsageActivityDay[] = Array.from({ length: weekCount * 7 }, (_, index) => {
    const timestamp = gridStart + index * DAY_MS;
    const date = new Date(timestamp);
    const key = date.toISOString().slice(0, 10);
    const inRange = timestamp >= start && timestamp <= end;
    return { key, date, inRange, tokens: inRange ? totals.get(key) ?? 0 : 0, level: 0 };
  });
  const peak = Math.max(...days.map(day => day.tokens));
  for (const day of days) {
    day.level = day.tokens > 0 ? Math.min(4, Math.ceil(day.tokens / peak * 4)) : 0;
  }
  return {
    days,
    weekCount,
    totalTokens: days.reduce((sum, day) => sum + day.tokens, 0),
  };
}
