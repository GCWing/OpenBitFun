import type { ToolCardProps } from '../types/flow-chat';

/** Result failures must not inherit a successful transport completion. */
export function getToolCardStatus(
  toolItem: ToolCardProps['toolItem'],
  resultFailed = false,
): ToolCardProps['toolItem']['status'] {
  if (toolItem.status === 'completed' && (toolItem.toolResult?.success === false || resultFailed)) {
    return 'error';
  }
  return toolItem.status;
}

/** Ambient rows keep status prose in the leading icon's accessible description. */
export function getToolCardStatusDescription(
  status: ToolCardProps['toolItem']['status'],
  t: (key: string) => string,
  error?: string | null,
): string | undefined {
  switch (status) {
    case 'error': return error?.trim() || t('toolCards.default.failed');
    case 'cancelled': return t('toolCards.default.cancelled');
    case 'rejected': return error?.trim() || t('toolCards.default.rejected');
    case 'pending_confirmation': return t('toolCards.default.waitingConfirm');
    case 'queued': return t('toolCards.default.queued');
    case 'waiting': return t('toolCards.default.waiting');
    default: return undefined;
  }
}
