import type { DialogTurn, Session, TokenUsage } from '../types/flow-chat';
import { LONG_CONTEXT_WARNING_THRESHOLD_TOKENS } from '@/shared/constants/modelContext';
import { i18nService } from '@/infrastructure/i18n';
import { formatTokenCount } from '@/shared/utils/tokenUsageFormatting';

export const DEFAULT_MAX_CONTEXT_TOKENS = 128128;

export type ContextUsageSource = 'agent_prompt' | 'acp_context';

export interface ContextUsageDisplay {
  current: number;
  max: number;
  source: ContextUsageSource;
}

export interface TranslationFn {
  (key: string, params?: Record<string, unknown>): string;
}

export interface ModelRoundCompletionMetaItem {
  key: 'completed' | 'duration';
  label: string;
  value: string;
}

export interface ModelSelectorTooltipRow {
  key: 'configName' | 'modelName' | 'contextWindow' | 'compressionTrigger' | 'contextUsage';
  label: string;
  value: string;
}

export interface ModelSelectorTooltipDetails {
  rows: ModelSelectorTooltipRow[];
  warning?: string;
}

const AUTOMATIC_MAX_OUTPUT_TOKEN_TIERS = [8_000, 16_000, 24_000, 32_000, 64_000] as const;
const AUTO_COMPRESSION_SAFETY_RESERVE_TOKENS = 10_000;

export function formatCompactTokenCount(value: number): string {
  return formatTokenCount(
    value,
    (number, options) => i18nService.formatNumber(number, options),
  );
}

function automaticMaxOutputTokens(contextWindow: number): number {
  const quarterContext = Math.floor(contextWindow / 4);
  return [...AUTOMATIC_MAX_OUTPUT_TOKEN_TIERS]
    .reverse()
    .find(tier => tier <= quarterContext) ?? quarterContext;
}

/** Mirrors the runtime compression budget in execution_engine.rs. */
export function getCompressionTriggerTokens(
  contextWindow: number,
  configuredMaxOutputTokens?: number,
): number {
  const safeContextWindow = Math.max(0, Math.floor(contextWindow));
  const outputReserve = configuredMaxOutputTokens && configuredMaxOutputTokens > 0
    ? Math.floor(configuredMaxOutputTokens)
    : automaticMaxOutputTokens(safeContextWindow);
  return Math.max(
    0,
    safeContextWindow - outputReserve - AUTO_COMPRESSION_SAFETY_RESERVE_TOKENS,
  );
}

export function formatContextUsageValue(usage: ContextUsageDisplay): string | null {
  if (usage.current <= 0 || usage.max <= 0) {
    return null;
  }

  const percentage = Math.min(100, Math.round((usage.current / usage.max) * 100));
  return `${formatCompactTokenCount(usage.current)}/${formatCompactTokenCount(usage.max)} (${percentage}%)`;
}

export function buildModelSelectorTooltipDetails(params: {
  configName: string;
  modelName?: string;
  contextWindow?: number;
  configuredMaxOutputTokens?: number;
  usage?: ContextUsageDisplay;
  t: TranslationFn;
}): ModelSelectorTooltipDetails {
  const {
    configName,
    modelName,
    contextWindow,
    configuredMaxOutputTokens,
    usage,
    t,
  } = params;
  const rows: ModelSelectorTooltipRow[] = [];

  if (configName) {
    rows.push({
      key: 'configName',
      label: t('modelSelector.tooltip.configName'),
      value: configName,
    });
  }

  if (modelName) {
    rows.push({
      key: 'modelName',
      label: t('modelSelector.tooltip.modelName'),
      value: modelName,
    });
  }

  if (contextWindow && contextWindow > 0) {
    rows.push({
      key: 'contextWindow',
      label: t('modelSelector.tooltip.contextWindow'),
      value: formatCompactTokenCount(contextWindow),
    });
    rows.push({
      key: 'compressionTrigger',
      label: t('modelSelector.tooltip.compressionTrigger'),
      value: formatCompactTokenCount(
        getCompressionTriggerTokens(contextWindow, configuredMaxOutputTokens),
      ),
    });
  }

  if (usage) {
    const contextUsageValue = formatContextUsageValue(usage);
    if (contextUsageValue) {
      rows.push({
        key: 'contextUsage',
        label: usage.source === 'acp_context'
          ? t('modelSelector.contextUsage.acpContextLabel')
          : t('modelSelector.contextUsage.agentPromptLabel'),
        value: contextUsageValue,
      });
    }
  }

  return {
    rows,
    warning: contextWindow && contextWindow > LONG_CONTEXT_WARNING_THRESHOLD_TOKENS
      ? t('modelSelector.tooltip.longContextWarning')
      : undefined,
  };
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

/**
 * Derive the latest terminal turn-with-usage's token usage as a
 * context-usage approximation when it represents exactly one model round.
 *
 * Used as a fallback to restore `session.currentTokenUsage` when a session is
 * hydrated from persisted history and no exact last-request usage was stored
 * in session metadata. Dialog turn usage accumulates across model rounds, so
 * a multi-round latest turn is not usable. In that case we must not scan past
 * it and mislabel an older request as the last request.
 */
export function deriveContextUsageFromTurns(turns: DialogTurn[] | undefined): TokenUsage | undefined {
  if (!turns) {
    return undefined;
  }

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const usage = turn.tokenUsage;
    if (
      !usage
      || (
        turn.status !== 'completed'
        && turn.status !== 'error'
        && turn.status !== 'cancelled'
      )
    ) {
      continue;
    }

    if (
      turn.modelRounds.length === 1
      && typeof usage.inputTokens === 'number'
      && Number.isFinite(usage.inputTokens)
      && usage.inputTokens > 0
    ) {
      return {
        ...usage,
        turnId: turn.id,
      };
    }

    return undefined;
  }
  return undefined;
}

export function getSessionContextUsageDisplay(session?: Session): ContextUsageDisplay {
  if (!session) {
    return {
      current: 0,
      max: DEFAULT_MAX_CONTEXT_TOKENS,
      source: 'agent_prompt',
    };
  }

  if (session.currentAcpContextUsage) {
    return {
      current: session.currentAcpContextUsage.used,
      max: session.currentAcpContextUsage.size,
      source: 'acp_context',
    };
  }

  return {
    current: session.currentTokenUsage?.inputTokens || 0,
    max: session.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
    source: 'agent_prompt',
  };
}

export function buildContextUsageTooltip(params: {
  baseTooltip: string;
  usage: ContextUsageDisplay;
  t: TranslationFn;
}): string {
  const { baseTooltip, usage, t } = params;
  if (usage.current <= 0 || usage.max <= 0) {
    return baseTooltip;
  }

  const usageText = formatContextUsageValue(usage);
  const usageLabel = usage.source === 'acp_context'
    ? t('modelSelector.contextUsage.acpContext', { usage: usageText })
    : t('modelSelector.contextUsage.agentPrompt', { usage: usageText });

  return [baseTooltip, usageLabel].filter(Boolean).join(' · ');
}

export function formatElapsedDuration(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(durationMs));
  if (safeMs < 1000) {
    return `${safeMs}ms`;
  }

  const seconds = safeMs / 1000;
  if (seconds < 60) {
    return `${formatCompactNumber(Math.round(seconds * 10) / 10)}s`;
  }

  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

export function buildModelRoundCompletionMeta(params: {
  completedAt?: number;
  durationMs?: number;
  status?: string;
  formatTime: (timestamp: number) => string;
  t: TranslationFn;
}): ModelRoundCompletionMetaItem[] {
  const { completedAt, durationMs, status, formatTime, t } = params;
  const items: ModelRoundCompletionMetaItem[] = [];

  if (typeof completedAt === 'number' && Number.isFinite(completedAt)) {
    items.push({
      key: 'completed',
      label: status === 'cancelled'
        ? t('modelRound.meta.stopped')
        : t('modelRound.meta.completed'),
      value: formatTime(completedAt),
    });
  }

  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    items.push({
      key: 'duration',
      label: t('modelRound.meta.duration'),
      value: formatElapsedDuration(durationMs),
    });
  }

  return items;
}
