import type { ExploreGroupProps } from '@openbitfun/ui/flow-chat';
import type { PresentationTranslate } from './exec/contracts';

interface ExploreStats { readCount: number; searchCount: number; commandCount: number }

export function formatExploreSummary(
  _stats: ExploreStats,
  itemCount: number,
  t: PresentationTranslate,
  formatNumber: (value: number) => string = String,
): string {
  return t('exploreRegion.exploreCount', { count: formatNumber(itemCount) });
}

/** Count all visible tool calls, including exploration without a specific category. */
export function buildExploreSummary(
  stats: ExploreStats,
  itemCount: number,
  t: PresentationTranslate,
  formatNumber: (value: number) => string,
): Pick<ExploreGroupProps, 'summary' | 'summaryDescription'> {
  const summary = formatExploreSummary(stats, itemCount, t, formatNumber);
  return {
    summary,
    summaryDescription: summary,
  };
}
