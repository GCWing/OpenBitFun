/**
 * Context compression display for Flow Chat.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FlowToolItem } from '../types/flow-chat';
import { ContextCompressionToolCard } from '@openbitfun/ui/flow-chat';
import { i18nService } from '@/infrastructure/i18n';
import { getToolCardStatus } from './toolCardStatus';

interface ContextCompressionDisplayProps {
  toolItem?: FlowToolItem;
  compressionData?: {
    session_id: string;
    compression_count: number;
    has_summary: boolean;
    summary_source?: 'model' | 'local_fallback' | 'none';
    tokens_before?: number;
    tokens_after?: number;
    compression_ratio?: number;
    duration?: number;
    summary_content?: string;
    trigger?: 'user_message' | 'tool_batch' | 'ai_response' | 'manual';
    compression_tiers?: {
      tier1?: { before: number; after: number; saved: number };
      tier2_3?: { before: number; after: number; saved: number };
      tier4_plus?: { before: number; after: number; saved: number };
    };
  };
}

export const ContextCompressionDisplay: React.FC<ContextCompressionDisplayProps> = ({
  toolItem,
  compressionData
}) => {
  const { t } = useTranslation('flow-chat');
  const data = toolItem ? {
    tokensBefore: toolItem.toolResult?.result?.tokens_before ?? toolItem.toolCall?.input?.tokens_before ?? compressionData?.tokens_before,
    tokensAfter: toolItem.toolResult?.result?.tokens_after ?? compressionData?.tokens_after,
    compressionRatio: toolItem.toolResult?.result?.compression_ratio ?? compressionData?.compression_ratio,
    summarySource: toolItem.toolResult?.result?.summary_source ?? compressionData?.summary_source,
    status: getToolCardStatus(toolItem),
    error: toolItem.toolResult?.error
  } : {
    tokensBefore: compressionData?.tokens_before,
    tokensAfter: compressionData?.tokens_after,
    compressionRatio: compressionData?.compression_ratio,
    summarySource: compressionData?.summary_source,
    status: 'completed' as const
  };

  const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
    i18nService.formatNumber(value, options);

  const isFailed = data.status === 'error';
  const usedLocalFallback = data.summarySource === 'local_fallback';

  const headerAction =
    isFailed
      ? t('toolCards.contextCompression.contextCompressionFailed')
      : t('toolCards.contextCompression.contextCompression');

  const interrupted = data.status === 'cancelled' || data.status === 'rejected';
  const active = ['pending', 'preparing', 'streaming', 'running', 'analyzing'].includes(data.status);
  const summary = interrupted
    ? data.status === 'cancelled' ? t('toolCards.default.cancelled') : t('toolCards.default.rejected')
    : typeof data.tokensBefore === 'number' && typeof data.tokensAfter === 'number'
      ? t('toolCards.contextCompression.tokenChange', { before: formatNumber(data.tokensBefore), after: formatNumber(data.tokensAfter) })
      : typeof data.tokensAfter === 'number'
        ? t('toolCards.contextCompression.remainingTokens', { count: data.tokensAfter, formattedCount: formatNumber(data.tokensAfter) })
        : active ? undefined : t('toolCards.default.completed');

  return (
    <ContextCompressionToolCard
      status={data.status}
      title={headerAction}
      summary={!isFailed ? summary : undefined}
      processingText={!isFailed && active && !summary
        ? t('toolCards.contextCompression.compressingContext')
        : undefined}
      error={isFailed
        ? data.error || t('toolCards.contextCompression.contextCompressionFailed')
        : undefined}
      data-summary-source={usedLocalFallback ? 'local-fallback' : data.summarySource}
    />
  );
};
