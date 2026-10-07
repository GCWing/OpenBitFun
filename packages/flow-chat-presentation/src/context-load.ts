import type { ContextLoadGroupProps } from '@openbitfun/ui/flow-chat';
import type { PresentationTranslate } from './exec/contracts';

/** Counts describe calls, including repeat loads, rather than distinct resources. */
export function buildContextLoadSummary(
  itemCount: number,
  t: PresentationTranslate,
  formatNumber: (value: number) => string,
): Pick<ContextLoadGroupProps, 'summary' | 'summaryDescription'> {
  const count = formatNumber(itemCount);
  const summary = t('contextLoadGroup.summary', { count });
  return {
    summary,
    summaryDescription: t('contextLoadGroup.description', { count }),
  };
}
