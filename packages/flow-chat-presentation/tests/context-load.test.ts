import { describe, expect, it } from 'vitest';
import { buildContextLoadSummary } from '../src/context-load';
import { flowChatEn, flowChatZhCN, flowChatZhTW } from '../../../design-system/apps/design-lab/src/i18n/flowChatMessages';
import { formatDesignLabNumber, translateFromCatalog, type TranslateParams } from '../../../design-system/apps/design-lab/src/i18n/core.mjs';

const catalog = { 'en-US': flowChatEn, 'zh-CN': flowChatZhCN, 'zh-TW': flowChatZhTW };
describe.each([
  ['en-US', '6 context loads', '6 context-loading calls, including repeat loads'],
  ['zh-CN', '6 次上下文加载', '6 次上下文加载，含重复加载'],
  ['zh-TW', '6 次上下文載入', '6 次上下文載入，含重複載入'],
] as const)('context load summary (%s)', (locale, summary, description) => {
  const t = (key: string, params?: Record<string, unknown>) => translateFromCatalog(
    catalog, locale, `flowChat.${key}` as keyof typeof flowChatEn, params as TranslateParams,
  );
  it('reports one total in the header and tooltip without a category breakdown', () => {
    expect(buildContextLoadSummary(6, t, value => formatDesignLabNumber(value, locale)))
      .toEqual({ summary, summaryDescription: description });
  });
  it('uses the host number formatter for the complete count', () => {
    expect(buildContextLoadSummary(1000, t, value => formatDesignLabNumber(value, locale)).summary).toContain('1,000');
  });
});
