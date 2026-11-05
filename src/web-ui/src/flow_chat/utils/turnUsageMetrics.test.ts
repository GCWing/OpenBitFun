import { describe, expect, it } from 'vitest';
import type { ModelRound, TokenUsage } from '../types/flow-chat';
import { getTurnOutputDurationMs, getTurnTtftMs, getTurnUsageMetrics } from './turnUsageMetrics';

const usage: TokenUsage = {
  inputTokens: 10_000, cachedTokens: 7_200, outputTokens: 2_800,
  totalTokens: 12_800, timestamp: 1,
};

function round(timing: Partial<ModelRound>): ModelRound {
  return {
    id: 'round', index: 0, items: [], isStreaming: false, isComplete: true,
    status: 'completed', startTime: 0, ...timing,
  };
}

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

  it('includes TTFT in request duration so buffered output cannot inflate the rate', () => {
    const rounds = [round({ durationMs: 12_000, streamDurationMs: 12_000, firstVisibleOutputMs: 2_000 })];
    // The turn took 90s wall time; the model request took 12s including TTFT.
    expect(getTurnUsageMetrics({ ...usage, outputTokens: 2_000 }, getTurnOutputDurationMs(rounds)))
      .toMatchObject({ outputRate: 2_000 / 12, speedLevel: 4 });
  });
});

describe('getTurnOutputDurationMs', () => {
  it('uses request-to-completion duration, including TTFT and ignoring stream marks', () => {
    expect(getTurnOutputDurationMs([round({ durationMs: 12_000, streamDurationMs: 12_000, firstChunkMs: 50, firstVisibleOutputMs: 2_000, ttftMs: 3_000 })])).toBe(12_000);
  });

  it('accepts a pseudo-stream duration when one large output chunk arrives late', () => {
    expect(getTurnOutputDurationMs([round({ durationMs: 30_000, streamDurationMs: 30_010, firstVisibleOutputMs: 30_000 })])).toBe(30_000);
  });

  it('does not invent request time when only stream marks are known', () => {
    expect(getTurnOutputDurationMs([round({ streamDurationMs: 9_000, firstVisibleOutputMs: 1_500 })])).toBeUndefined();
  });

  it('sums every round of a multi-round turn', () => {
    expect(getTurnOutputDurationMs([
      round({ durationMs: 5_000, streamDurationMs: 5_000, firstVisibleOutputMs: 1_000 }),
      round({ durationMs: 7_000, streamDurationMs: 7_000, firstVisibleOutputMs: 2_000 }),
    ])).toBe(12_000);
  });

  it('excludes controller setup rows while requiring every actual model call to be timed', () => {
    const setup = round({ index: -1 });
    const timed = round({ durationMs: 5_000, streamDurationMs: 5_000, firstVisibleOutputMs: 1_000 });
    expect(getTurnOutputDurationMs([setup, timed])).toBe(5_000);
    expect(getTurnOutputDurationMs([setup])).toBeUndefined();
    expect(getTurnOutputDurationMs([setup, round({}), timed])).toBeUndefined();
  });

  it('accepts request duration without requiring a first-output mark', () => {
    expect(getTurnOutputDurationMs([round({ durationMs: 2_000, firstChunkMs: 0 })])).toBe(2_000);
  });

  it('does not use accepted-attempt timing for usage that also includes retries', () => {
    expect(getTurnOutputDurationMs([round({ durationMs: 2_000, streamDurationMs: 2_000, firstVisibleOutputMs: 500, attemptCount: 2 })])).toBeUndefined();
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid request duration %s', durationMs => {
    expect(getTurnOutputDurationMs([round({ durationMs })])).toBeUndefined();
  });

  it('does not use a non-positive request duration', () => {
    expect(getTurnOutputDurationMs([round({ durationMs: 0 })])).toBeUndefined();
  });

  it('rejects incomplete turn timing instead of dividing all tokens by partial time', () => {
    expect(getTurnOutputDurationMs([round({}), round({ durationMs: 6_000 })]))
      .toBeUndefined();
    expect(getTurnOutputDurationMs([round({}), round({})])).toBeUndefined();
    expect(getTurnOutputDurationMs([])).toBeUndefined();
    expect(getTurnOutputDurationMs(undefined)).toBeUndefined();
  });
});


describe('getTurnTtftMs', () => {
  it('uses request-level TTFT from the first model call, including a reported zero', () => {
    expect(getTurnTtftMs([round({ ttftMs: 1_500 }), round({ ttftMs: 4_000 })])).toBe(1_500);
    expect(getTurnTtftMs([round({ ttftMs: 0 })])).toBe(0);
  });

  it('excludes controller setup rows without skipping an untimed model call', () => {
    const setup = round({ index: -1 });
    const timed = round({ ttftMs: 1_500 });
    expect(getTurnTtftMs([setup, timed])).toBe(1_500);
    expect(getTurnTtftMs([setup])).toBeUndefined();
    expect(getTurnTtftMs([setup, round({}), timed])).toBeUndefined();
  });

  it('does not substitute a later call or stream-only timing for missing request timing', () => {
    expect(getTurnTtftMs([round({ firstChunkMs: 50, firstVisibleOutputMs: 100 }), round({ ttftMs: 4_000 })])).toBeUndefined();
    expect(getTurnTtftMs([])).toBeUndefined();
    expect(getTurnTtftMs(undefined)).toBeUndefined();
  });

  it.each([-1, NaN, Infinity])('rejects invalid TTFT %s', ttftMs => {
    expect(getTurnTtftMs([round({ ttftMs })])).toBeUndefined();
  });
});
