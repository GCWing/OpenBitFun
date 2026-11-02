import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDuration as formatSharedDuration } from '../../../../shared/i18n/formatDuration';
import { formatDuration } from './format';
import { formatElapsedDuration } from '@/flow_chat/utils/tokenUsageDisplay';
import { formatUsageDuration } from '@/flow_chat/components/usage/usageReportUtils';
import { i18nService } from '@/infrastructure/i18n';

afterEach(() => vi.restoreAllMocks());

describe('localized duration presentation', () => {
  it.each([
    ['en-US', '12.3 sec', '2 min', '86 ms'],
    ['zh-CN', '12.3秒', '2分钟', '86毫秒'],
    ['zh-TW', '12.3 秒', '2 分鐘', '86 毫秒'],
  ])('uses the same units in tools, model rounds and usage for %s', (locale, seconds, minutes, milliseconds) => {
    vi.spyOn(i18nService, 'formatNumber').mockImplementation((value, options) => new Intl.NumberFormat(locale, options).format(value));
    for (const formatter of [formatDuration, formatElapsedDuration, (ms: number) => formatUsageDuration(ms, key => key)]) {
      expect(formatter(12345)).toBe(seconds);
      expect(formatter(119999)).toBe(minutes);
      expect(formatter(86)).toBe(milliseconds);
    }
  });

  it('carries rounded seconds and preserves elapsed precision without invalid values', () => {
    const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', options).format(value);
    expect(formatSharedDuration(59999, number)).toBe('1 min');
    expect(formatSharedDuration(59999, number, 'live')).toBe('59 sec');
    expect(formatSharedDuration(3600000, number)).toBe('1 hr');
    expect(formatSharedDuration(90000000, number)).toBe('1 day 1 hr');
    expect(formatSharedDuration(-1, number)).toBe('0 ms');
    expect(formatSharedDuration(NaN, number)).toBe('0 ms');
  });
});
