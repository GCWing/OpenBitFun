import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Run Code tool card.
 *
 * Code-mode agents answer a step by writing one program — DeepSeek Harness's
 * PTC preset calls it `run_code` — instead of one tool call per file read or
 * shell command. The program is the action, so the card shows it as code and
 * whatever it printed underneath, rather than squeezing a TypeScript source
 * file into a terminal card's command line.
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { CodePreview } from '../components/CodePreview';
import { RunCodeToolCard as RunCodeToolCardView } from '@openbitfun/ui/flow-chat';
import { ToolCardCopyAction } from './ToolCardCopyAction';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { formatSessionViewPreviewText } from '../utils/sessionViewPreview';

/** Enough of the program to recognize it in a collapsed header. */
const SUMMARY_CHARS = 80;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The first line that says something about what the program does — skipping
 * the comment banners and blank lines a model tends to open with.
 */
function firstMeaningfulLine(code: string): string {
  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    return trimmed.length > SUMMARY_CHARS ? `${trimmed.slice(0, SUMMARY_CHARS)}...` : trimmed;
  }
  return '';
}

function readOutput(result: unknown): string {
  if (typeof result === 'string') return formatSessionViewPreviewText(result);
  if (!result || typeof result !== 'object') return '';

  const record = result as Record<string, unknown>;
  const stdout = asText(record.stdout);
  const stderr = asText(record.stderr);
  const combined = [stdout, stderr].filter((value) => value.length > 0).join('\n');
  return formatSessionViewPreviewText(asText(record.output) || combined);
}

export const RunCodeToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  config,
  onExpand,
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const status = getToolCardStatus(toolItem);
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: config.toolName,
  });

  const code = asText(toolCall?.input?.code);
  const description = asText(toolCall?.input?.description).trim();
  const output = useMemo(() => readOutput(toolResult?.result), [toolResult?.result]);
  const errorMessage = status === 'error'
    ? toolResult?.error || t('toolCards.runCode.failed')
    : null;

  const canExpand = Boolean(code || output || errorMessage);
  const getCopyCodeText = useCallback(() => code, [code]);

  const handleToggleExpand = useCallback(() => {
    if (!canExpand) return;

    applyExpandedState(isExpanded, !isExpanded, setIsExpanded, { onExpand });
  }, [applyExpandedState, canExpand, isExpanded, onExpand, setIsExpanded]);

  const summary = description || firstMeaningfulLine(code);

  return (
    <div
      data-openbitfun-adapter="run-code-tool-card"
      ref={cardRootRef}
      data-tool-card-id={toolId ?? ''}
    >
      <RunCodeToolCardView
        status={status}
        isExpanded={isExpanded}
        onToggle={canExpand ? handleToggleExpand : undefined}
        action={t('toolCards.runCode.title')}
        summary={summary}
        statusDescription={getToolCardStatusDescription(status, t, errorMessage)}
        actions={code ? (
          <ToolCardCopyAction
            getText={getCopyCodeText}
            tooltip={t('toolCards.runCode.copyCode')}
            copiedTooltip={t('toolCards.runCode.codeCopied')}
            successMessage={t('toolCards.runCode.codeCopied')}
            failureMessage={t('toolCards.runCode.copyCodeFailed')}
            ariaLabel={t('toolCards.runCode.copyCode')}
            showSuccessNotification={false}
          />
        ) : undefined}
        program={code ? (
          <CodePreview
            content={code}
            language="typescript"
            showLineNumbers={false}
            maxHeight={320}
            autoScrollToBottom={false}
          />
        ) : undefined}
        programLabel={t('toolCards.runCode.programLabel')}
        output={output || undefined}
        outputLabel={t('toolCards.runCode.outputLabel')}
        error={errorMessage || undefined}
      />
    </div>
  );
};

export default RunCodeToolCard;
