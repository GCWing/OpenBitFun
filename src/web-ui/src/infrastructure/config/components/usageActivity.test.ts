import { describe, expect, it } from 'vitest';
import type { UsageTrendPoint } from '@/infrastructure/api';
import { buildUsageActivity, usageActivityRequestRange } from './usageActivity';

function point(bucket: string, inputTokens: number, outputTokens = 0): UsageTrendPoint {
  return { bucket, inputTokens, outputTokens, cacheReadTokens: 80, cacheWriteTokens: 20, cacheHitRate: 0.8 };
}

describe('usage activity calendar', () => {
  it('fills six calendar months, aligns Monday-first weeks, and excludes future padding', () => {
    const activity = buildUsageActivity([], 'UTC', new Date('2026-09-23T12:00:00Z'));
    const visible = activity.days.filter(day => day.inRange);
    expect(activity.days[0].date.getUTCDay()).toBe(1);
    expect(activity.days.at(-1)?.date.getUTCDay()).toBe(0);
    expect(visible).toHaveLength(184);
    expect(visible[0].key).toBe('2026-03-24');
    expect(visible.at(-1)?.key).toBe('2026-09-23');
    expect(activity.days.every(day => day.tokens === 0 && day.level === 0)).toBe(true);
  });

  it('clamps the starting month when the current month has more days', () => {
    const activity = buildUsageActivity([], 'UTC', new Date('2026-08-31T12:00:00Z'));
    const visible = activity.days.filter(day => day.inRange);
    expect(visible[0].key).toBe('2026-03-01');
    expect(visible.at(-1)?.key).toBe('2026-08-31');
  });

  it('groups by the requested calendar day and counts cache tokens only once', () => {
    const activity = buildUsageActivity([
      point('2026-09-26T16:00:00Z', 100, 10),
      point('2026-09-27T10:00:00Z', 200, 20),
      point('2026-09-26T15:00:00Z', 50, 5),
      point('2025-09-25T16:00:00Z', 10_000),
    ], 'Asia/Shanghai', new Date('2026-09-27T12:00:00Z'));
    expect(activity.days.find(day => day.key === '2026-09-27')?.tokens).toBe(330);
    expect(activity.days.find(day => day.key === '2026-09-26')?.tokens).toBe(55);
    expect(activity.totalTokens).toBe(385);
    expect(activity.days.find(day => day.key === '2026-09-27')?.level).toBe(4);
    expect(activity.days.find(day => day.key === '2026-09-26')?.level).toBe(1);
  });

  it('keeps DST days contiguous and includes leap day', () => {
    const activity = buildUsageActivity([
      point('2024-03-09T05:00:00Z', 100),
      point('2024-03-10T05:00:00Z', 200),
      point('2024-03-11T04:00:00Z', 300),
      point('2024-03-12T04:00:00Z', 400),
    ], 'America/New_York', new Date('2024-03-12T12:00:00Z'));
    expect(activity.days.filter(day => day.tokens > 0).map(day => [day.key, day.level])).toEqual([
      ['2024-03-09', 1], ['2024-03-10', 2], ['2024-03-11', 3], ['2024-03-12', 4],
    ]);
    expect(activity.days.some(day => day.key === '2024-02-29' && day.inRange)).toBe(true);
  });

  it('covers the first local day across UTC offsets and ends at the snapshot time', () => {
    const now = new Date('2026-09-27T02:00:00Z');
    for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York']) {
      const activity = buildUsageActivity([], timeZone, now);
      const range = usageActivityRequestRange(timeZone, now);
      const firstDay = activity.days.find(day => day.inRange)!;
      expect(new Date(range.start).getTime()).toBeLessThan(firstDay.date.getTime() - 14 * 60 * 60 * 1000);
      expect(range.end).toBe(now.toISOString());
    }
    const western = buildUsageActivity([], 'Pacific/Pago_Pago', now);
    expect(western.days.filter(day => day.inRange).at(-1)?.key).toBe('2026-09-26');
  });
});
