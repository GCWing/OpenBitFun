import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '../types/flow-chat';
import { getTurnUsageMetrics } from './turnUsageMetrics';

const usage: TokenUsage = {
  inputTokens: 10_000, cachedTokens: 7_200, outputTokens: 2_800,
  totalTokens: 12_800, timestamp: 1,
};

describe('getTurnUsageMetrics', () => {
  it('uses input tokens as the cache denominator and output tokens as the rate numerator', () => {
    expect(getTurnUsageMetrics(usage, 40_000)).toEqual({
      totalTokens: 12_800, cacheHitRate: 0.72, outputRate: 70, speedLevel: 3,
    });
  });

  it('keeps legacy and unknown values distinct from reported zeros', () => {
    expect(getTurnUsageMetrics(undefined, 1_000)).toEqual({
      totalTokens: null, cacheHitRate: null, outputRate: null, speedLevel: null,
    });
    expect(getTurnUsageMetrics({ ...usage, cachedTokens: undefined, outputTokens: undefined }, 1_000))
      .toMatchObject({ totalTokens: 12_800, cacheHitRate: null, outputRate: null, speedLevel: null });
    expect(getTurnUsageMetrics({ ...usage, cachedTokens: 0, outputTokens: 0 }, 1_000))
      .toMatchObject({ cacheHitRate: 0, outputRate: 0, speedLevel: 1 });
  });

  it.each([undefined, 0, -1, Infinity, NaN])('does not invent throughput for duration %s', duration => {
    expect(getTurnUsageMetrics(usage, duration)).toMatchObject({ outputRate: null, speedLevel: null });
  });

  it.each([[14.9, 1], [15, 2], [39.9, 2], [40, 3], [79.9, 3], [80, 4]])(
    'classifies %s tokens/s without rounding across a tier boundary', (rate, level) => {
      expect(getTurnUsageMetrics({ ...usage, outputTokens: rate * 10 }, 10_000).speedLevel).toBe(level);
    },
  );

  it('rejects inconsistent cache telemetry and non-finite token counts', () => {
    expect(getTurnUsageMetrics({ ...usage, cachedTokens: 10_001 }).cacheHitRate).toBeNull();
    expect(getTurnUsageMetrics({ ...usage, inputTokens: 0 }).cacheHitRate).toBeNull();
    expect(getTurnUsageMetrics({ ...usage, cachedTokens: NaN, totalTokens: Infinity, outputTokens: -1 }, 1_000))
      .toEqual({ totalTokens: null, cacheHitRate: null, outputRate: null, speedLevel: null });
  });
});
