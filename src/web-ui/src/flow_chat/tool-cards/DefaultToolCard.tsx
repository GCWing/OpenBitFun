import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Default tool card component
 * Used for tool types without specific customization
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@openbitfun/ui';
import { isShellToolName } from '../grouping/activityClassification';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { DefaultToolCard as DefaultToolCardView } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import {
  formatSessionViewPreviewText,
  isOnlySessionViewPreviewText,
} from '../utils/sessionViewPreview';

const MAX_PREVIEW_CHARS = 4000;
const INLINE_PREVIEW_CHARS = 72;
const INLINE_PREVIEW_SCAN_CHARS = 512;

function sanitizeToolInput(input: any): any {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input;
  if (typeof input !== 'object') return input;

  return Object.entries(input).reduce((acc, [key, value]) => {
    if (!key.startsWith('_')) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, any>);
}

function hasVisibleValue(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function stringifyValue(value: any): string {
  try {
    if (typeof value === 'string') {
      return formatSessionViewPreviewText(value);
    }

    return formatSessionViewPreviewText(JSON.stringify(value, null, 2));
  } catch {
    return formatSessionViewPreviewText(String(value));
  }
}

function truncatePreview(text: string, maxChars: number = MAX_PREVIEW_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...`;
}

function getInlinePreview(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const scanned = value.length > INLINE_PREVIEW_SCAN_CHARS
      ? value.slice(0, INLINE_PREVIEW_SCAN_CHARS)
      : value;
    const normalized = scanned.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    if (isOnlySessionViewPreviewText(normalized)) return null;
    return normalized.length > INLINE_PREVIEW_CHARS || scanned.length < value.length
      ? `${normalized.slice(0, INLINE_PREVIEW_CHARS)}...`
      : normalized;
  }

  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['summary', 'title', 'text', 'content', 'output']) {
      if (typeof record[key] === 'string') {
        const preview = getInlinePreview(record[key]);
        if (preview) return preview;
      }
    }
  }
  return null;
}

export const DefaultToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  config,
  onExpand,
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, requiresConfirmation, userConfirmed } = toolItem;
  const status = getToolCardStatus(toolItem);
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState, dispatchToolCardToggle } = useToolCardHeightContract({
    toolId,
    toolName: config.toolName,
  });

  const filteredInput = useMemo(() => sanitizeToolInput(toolCall?.input), [toolCall?.input]);
  const hasInput = useMemo(() => hasVisibleValue(filteredInput), [filteredInput]);
  const hasResult = toolResult !== undefined && toolResult !== null && config.resultDisplayType !== 'hidden';
  const errorMessage = status === 'error' ? toolResult?.error || t('toolCards.default.failed') : null;
  const hasError = Boolean(errorMessage);
  const needsConfirmation = requiresConfirmation && !userConfirmed &&
    status !== 'completed' &&
    status !== 'cancelled' &&
    status !== 'rejected' &&
    status !== 'error';
  const canExpand = hasInput || hasResult || hasError;

  const inputPreview = useMemo(() => {
    if (!isExpanded || !hasInput) return null;
    return truncatePreview(stringifyValue(filteredInput));
  }, [filteredInput, hasInput, isExpanded]);

  const resultPreview = useMemo(() => {
    if (!isExpanded || !hasResult) return null;
    return truncatePreview(stringifyValue(toolResult?.result));
  }, [hasResult, isExpanded, toolResult?.result]);

  const handleToggleExpand = useCallback(() => {
    if (!canExpand) return;

    const nextExpanded = !isExpanded;
    applyExpandedState(isExpanded, nextExpanded, setIsExpanded, {
      onExpand,
    });
  }, [applyExpandedState, canExpand, isExpanded, onExpand, setIsExpanded]);

  const resultSummary = hasResult && status === 'completed' ? getInlinePreview(toolResult?.result) : undefined;

  const showConfirmationHighlight = needsConfirmation;

  return (
    <div data-openbitfun-adapter="default-tool-card" ref={cardRootRef} data-tool-card-id={toolId ?? ''}>
      <DefaultToolCardView
        status={status}
        isExpanded={isExpanded}
        onToggle={canExpand ? handleToggleExpand : undefined}
        displayName={t('toolCards.common.invokeTool')}
        toolName={config.toolName}
        description={config.description}
        hasDetails={canExpand}
        icon={isShellToolName(toolItem.toolName) ? <Icon name="square-terminal" size="sm" /> : config.icon ?? undefined}
        summary={config.toolName}
        resultSummary={resultSummary}
        statusDescription={getToolCardStatusDescription(needsConfirmation ? 'pending_confirmation' : status, t, errorMessage)}
        inputLabel={t('toolCards.common.inputParams')}
        inputPreview={inputPreview}
        onInputOpenChange={dispatchToolCardToggle}
        resultLabel={t('toolCards.common.executionResult')}
        resultPreview={toolResult?.success === false ? undefined : resultPreview}
        error={errorMessage || undefined}
        requiresConfirmation={showConfirmationHighlight}
      />
    </div>
  );
};
