import { FlowChatMetricDetails, FlowChatTurnMetrics } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { formatTokenCount } from '@/shared/utils/tokenUsageFormatting';
import type { TokenUsage } from '../../types/flow-chat';
import { getTurnUsageMetrics } from '../../utils/turnUsageMetrics';

export function TurnUsageMetrics({ usage, durationMs, focusable }: {
  usage?: TokenUsage;
  durationMs?: number;
  focusable: boolean;
}) {
  const { t, formatNumber } = useI18n('flow-chat');
  const { totalTokens, cacheHitRate, outputRate, speedLevel } = getTurnUsageMetrics(usage, durationMs);
  const count = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? formatTokenCount(value, formatNumber) : null;
  const rate = outputRate === null ? null : formatNumber(outputRate, { maximumFractionDigits: 1 });
  const speedLabels = {
    1: t('modelRound.metrics.slow'),
    2: t('modelRound.metrics.normal'),
    3: t('modelRound.metrics.fast'),
    4: t('modelRound.metrics.veryFast'),
  };
  const cacheValue = cacheHitRate === null ? null
    : formatNumber(cacheHitRate, { style: 'percent', maximumFractionDigits: 1 });
  const tokenRows = [
    { label: t('modelRound.metrics.total'), value: count(totalTokens) },
    { label: t('modelRound.metrics.input'), value: count(usage?.inputTokens) },
    { label: t('modelRound.metrics.output'), value: count(usage?.outputTokens) },
    { label: t('modelRound.metrics.cache'), value: cacheValue },
  ].filter((row): row is { label: string; value: string } => row.value !== null);
  const rateRows = rate !== null && speedLevel !== null ? [
    { label: t('modelRound.metrics.averageRate'), value: t('modelRound.metrics.rateValue', { value: rate }) },
    { label: t('modelRound.metrics.speedLevel'), value: speedLabels[speedLevel] },
  ] : [];

  return <FlowChatTurnMetrics
    label={t('modelRound.metrics.label')}
    tokenValue={count(totalTokens)}
    tokenDescription={tokenRows.map(row => `${row.label}: ${row.value}`).join(' · ')}
    tokenDetails={<FlowChatMetricDetails rows={tokenRows} />}
    cacheHitRate={cacheHitRate}
    rateValue={rate === null ? null : t('modelRound.metrics.rateValue', { value: rate })}
    rateDescription={rateRows.map(row => `${row.label}: ${row.value}`).join(' · ')}
    rateDetails={<FlowChatMetricDetails rows={rateRows} note={t('modelRound.metrics.rateBasis')} />}
    speedLevel={speedLevel}
    focusable={focusable}
  />;
}
