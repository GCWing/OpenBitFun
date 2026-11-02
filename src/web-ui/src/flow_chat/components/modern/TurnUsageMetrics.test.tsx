import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../locales/en-US/flow-chat.json';
import { getTurnOutputDurationMs, getTurnTtftMs } from '../../utils/turnUsageMetrics';
import { TurnUsageMetrics } from './TurnUsageMetrics';
import type { ModelRound } from '../../types/flow-chat';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const value = key.split('.').reduce<any>((item, part) => item[part], en);
      return value.replace('{{value}}', params?.value ?? '');
    },
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', options).format(value),
  }),
}));

describe('completed turn usage', () => {
  const round: ModelRound = {
    id: 'round', index: 0, startTime: 0, endTime: 90_000, status: 'completed', items: [],
    isStreaming: false, isComplete: true,
    firstChunkMs: 10, firstVisibleOutputMs: 2_000, streamDurationMs: 12_000, ttftMs: 3_000,
  };
  const usage = { inputTokens: 10_000, outputTokens: 2_000, totalTokens: 12_000, timestamp: 90_000 };

  it('shows request TTFT separately and calculates speed only over effective output', () => {
    const html = renderToStaticMarkup(<TurnUsageMetrics usage={usage}
      durationMs={getTurnOutputDurationMs([round])} ttftMs={getTurnTtftMs([round])} focusable />);
    expect(html).toContain('TTFT 3 sec');
    expect(html).toContain('200 t/s');
    expect(html).toContain('data-openbitfun-part="ttft"');
    expect(html).toContain('data-openbitfun-part="speed"');
  });

  it('keeps legacy usage visible without inventing TTFT or throughput from wall time', () => {
    const legacy = { ...round, firstVisibleOutputMs: undefined, ttftMs: undefined };
    const html = renderToStaticMarkup(<TurnUsageMetrics usage={usage}
      durationMs={getTurnOutputDurationMs([legacy])} ttftMs={getTurnTtftMs([legacy])} focusable />);
    expect(html).toContain('data-openbitfun-part="tokens"');
    expect(html).not.toContain('data-openbitfun-part="ttft"');
    expect(html).not.toContain('data-openbitfun-part="speed"');
  });
});
