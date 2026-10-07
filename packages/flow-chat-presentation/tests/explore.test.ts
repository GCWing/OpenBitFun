import { describe, expect, it } from 'vitest';
import { buildExploreSummary } from '../src/explore';
import { flowChatEn, flowChatZhCN, flowChatZhTW } from '../../../design-system/apps/design-lab/src/i18n/flowChatMessages';
import { formatDesignLabNumber, translateFromCatalog, type TranslateParams } from '../../../design-system/apps/design-lab/src/i18n/core.mjs';

const catalog = { 'en-US': flowChatEn, 'zh-CN': flowChatZhCN, 'zh-TW': flowChatZhTW };

describe.each([
  { locale: 'en-US', mixed: 'Explorations: 12', large: 'Explorations: 1,000', fallback: 'Explorations: 2' },
  { locale: 'zh-CN', mixed: '12 次探索', large: '1,000 次探索', fallback: '2 次探索' },
  { locale: 'zh-TW', mixed: '12 次探索', large: '1,000 次探索', fallback: '2 次探索' },
] as const)('compact exploration summary ($locale)', ({ locale, mixed, large, fallback }) => {
  const t = (key: string, params?: Record<string, unknown>) => translateFromCatalog(
    catalog, locale, `flowChat.${key}` as keyof typeof flowChatEn, params as TranslateParams,
  );
  const formatNumber = (value: number) => formatDesignLabNumber(value, locale);

  it('uses the total call count, including calls outside the classified categories', () => {
    const result = buildExploreSummary({ readCount: 7, searchCount: 3, commandCount: 0 }, 12, t, formatNumber);
    expect(result.summary).toBe(mixed);
    expect(result.summaryDescription).toBe(mixed);
    expect(result).not.toHaveProperty('summaryItems');
  });

  it('uses the supplied number formatter for the total', () => {
    const result = buildExploreSummary({ readCount: 1000, searchCount: 0, commandCount: 0 }, 1000, t, formatNumber);
    expect(result.summary).toBe(large);
    expect(result.summaryDescription).toBe(large);
  });

  it('uses the same total summary for otherwise unclassified calls', () => {
    const result = buildExploreSummary({ readCount: 0, searchCount: 0, commandCount: 0 }, 2, t, formatNumber);
    expect(result.summary).toBe(fallback);
    expect(result).not.toHaveProperty('summaryItems');
    expect(result.summaryDescription).toBe(fallback);
  });
});
