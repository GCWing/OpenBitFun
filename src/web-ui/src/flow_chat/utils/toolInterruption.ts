import type { FlowToolItem } from '../types/flow-chat';

export function getToolInterruptionNote(
  toolItem: Pick<FlowToolItem, 'status' | 'interruptionReason'>,
  t: (key: string) => string,
): string | null {
  if (toolItem.status === 'cancelled' && toolItem.interruptionReason === 'retry_superseded') {
    return t('toolCards.common.interruptedByRetry');
  }

  if (toolItem.status === 'cancelled' && toolItem.interruptionReason === 'app_restart') {
    return t('toolCards.common.interruptedByRestart');
  }

  return null;
}
