import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FlowToolItem } from '../types/flow-chat';
import {
  LazyTerminalOutputRenderer,
  type TerminalOutputRendererHandle,
} from '@/tools/terminal/components/LazyTerminalOutputRenderer';
import {
  CommandToolCard,
  type CommandToolCardFooterItem,
} from '@openbitfun/ui/flow-chat';
import { ToolCardCopyAction } from './ToolCardCopyAction';
import { ToolTimeoutIndicator } from './ToolTimeoutIndicator';
import { useCopyTextAction } from '../hooks/useCopyTextAction';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { formatSessionViewPreviewText } from '../utils/sessionViewPreview';

const EXEC_COLLAPSED_STATUSES = new Set(['completed', 'cancelled', 'error', 'rejected']);
const EXEC_OUTPUT_STREAMING_MAX_ROWS = 4;
const EXEC_OUTPUT_EXPANDED_MAX_ROWS = 15;
const EXEC_MINIMUM_EXPANDED_MS = 1000;

export interface ExecProcessCardModel {
  kind: 'command' | 'stdin' | 'control';
  actionLabel: string;
  primaryText: string;
  emptyText: string;
  copyText: string;
  copyDisabled?: boolean;
  waitingText: string;
  noOutputText: string;
  resultNoticeText?: string;
  resultOutput: string;
  workdir?: string;
  sessionId?: number;
  exitCode?: number;
  wallTimeSeconds?: number;
  remote?: boolean;
  tty?: boolean;
}

interface ExecProcessToolCardViewProps {
  toolItem: FlowToolItem;
  model: ExecProcessCardModel;
  onExpand?: () => void;
  isLastItem?: boolean;
}

function isCollapsedStatus(status: string): boolean {
  return EXEC_COLLAPSED_STATUSES.has(status);
}

function getInitialExpandedState(status: string, hasLiveOutput: boolean): boolean {
  return !isCollapsedStatus(status) && (hasLiveOutput || status === 'pending_confirmation');
}

function isCancelledStatus(status: string): boolean {
  return status === 'cancelled';
}

function isUserRejectedTool(toolItem: FlowToolItem): boolean {
  if (toolItem.status === 'rejected') {
    return true;
  }

  if (toolItem.status === 'cancelled') {
    if (toolItem.userConfirmed === false) {
      return true;
    }

    const error = toolItem.toolResult?.error;
    return typeof error === 'string' && /\buser rejected\b/i.test(error);
  }

  return false;
}

function isRejectedOrCancelledStatus(toolItem: FlowToolItem): boolean {
  return isCancelledStatus(toolItem.status) || isUserRejectedTool(toolItem);
}

function readProgressLogs(toolItem: FlowToolItem): string[] {
  const logs = (toolItem as any)._progressLogs;
  return Array.isArray(logs) ? logs.filter((entry): entry is string => typeof entry === 'string') : [];
}

function formatSecondsAsMs(seconds?: number): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1000))
    : undefined;
}

export const ExecProcessToolCardView: React.FC<ExecProcessToolCardViewProps> = ({
  toolItem,
  model,
  onExpand,
}) => {
  const { t } = useTranslation('flow-chat');
  const status = toolItem.status || 'pending';
  const isParamsStreaming = Boolean(toolItem.isParamsStreaming);
  const progressLogs = useMemo(() => readProgressLogs(toolItem), [toolItem]);
  const liveOutput = useMemo(() => {
    if (progressLogs.length > 0) {
      return progressLogs.join('');
    }
    const progressMessage = (toolItem as any)._progressMessage;
    return typeof progressMessage === 'string' ? progressMessage : '';
  }, [progressLogs, toolItem]);
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running' || status === 'receiving';
  const rejectedOrCancelled = isRejectedOrCancelledStatus(toolItem);
  const cancelledStatusLabelKey = isUserRejectedTool(toolItem)
    ? 'toolCards.terminal.rejected'
    : 'toolCards.terminal.cancelled';
  const toolId = toolItem.id ?? toolItem.toolCall?.id;
  const hasLiveOutput = liveOutput.length > 0;

  const [isExpanded, setIsExpandedState] = useState(() => getInitialExpandedState(status, hasLiveOutput));
  const userToggledRef = useRef(false);
  const autoExpandedAtRef = useRef<number | null>(null);
  const outputRendererRef = useRef<TerminalOutputRendererHandle | null>(null);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const applyExecExpandedState = useCallback((nextExpanded: boolean) => {
    if (nextExpanded === isExpanded) {
      return;
    }

    applyExpandedState(isExpanded, nextExpanded, setIsExpandedState, { onExpand });
  }, [applyExpandedState, isExpanded, onExpand]);

  const toggleExpanded = useCallback(() => {
    userToggledRef.current = true;
    applyExecExpandedState(!isExpanded);
  }, [applyExecExpandedState, isExpanded]);

  useLayoutEffect(() => {
    if (userToggledRef.current) {
      return;
    }

    if (isRunning && hasLiveOutput) {
      // Start once, including when mounting with output already available.
      autoExpandedAtRef.current ??= Date.now();
      applyExecExpandedState(true);
    } else if (isCollapsedStatus(status)) {
      const remainingMs = autoExpandedAtRef.current === null
        ? 0
        : EXEC_MINIMUM_EXPANDED_MS - (Date.now() - autoExpandedAtRef.current);
      if (isExpanded && remainingMs > 0) {
        const timer = setTimeout(() => {
          if (!userToggledRef.current) {
            applyExecExpandedState(false);
          }
        }, remainingMs);
        return () => clearTimeout(timer);
      }
      applyExecExpandedState(false);
    } else if (isRunning && autoExpandedAtRef.current === null) {
      applyExecExpandedState(false);
    }
  }, [
    applyExecExpandedState,
    hasLiveOutput,
    isExpanded,
    isRunning,
    status,
  ]);

  const compactSettledPreview =
    isExpanded &&
    isCollapsedStatus(status) &&
    !userToggledRef.current;
  // Keep auto-managed completed cards on the compact preview through the
  // collapse animation. A manually expanded card remains eligible for the
  // full output preview.
  const keepAutoCompletionPreview =
    status === 'completed' &&
    !userToggledRef.current;
  const keepCompactCompletionPreview =
    keepAutoCompletionPreview || compactSettledPreview;
  const maxRows = isRunning || keepCompactCompletionPreview
    ? EXEC_OUTPUT_STREAMING_MAX_ROWS
    : EXEC_OUTPUT_EXPANDED_MAX_ROWS;
  const { copied: primaryCopied, copy: copyPrimary } = useCopyTextAction({
    getText: () => model.copyText,
    successMessage: t('toolCards.execProcess.primaryCopied'),
    failureMessage: t('toolCards.execProcess.copyPrimaryFailed'),
    showSuccessNotification: false,
  });

  const completedDurationMs =
    formatSecondsAsMs(model.wallTimeSeconds) ?? toolItem.toolResult?.duration_ms ?? toolItem.durationMs;
  const timeoutMs = typeof toolItem.toolCall?.input?.yield_time_ms === 'number' && toolItem.toolCall.input.yield_time_ms > 0
    ? toolItem.toolCall.input.yield_time_ms
    : undefined;

  const getOutputText = useCallback(() => {
    if (status === 'completed') {
      return formatSessionViewPreviewText(model.resultOutput);
    }

    if (status === 'cancelled') {
      return liveOutput;
    }

    if (liveOutput && isRunning) {
      return liveOutput;
    }

    return '';
  }, [isRunning, liveOutput, model.resultOutput, status]);

  const getVisibleOutputText = useCallback(() => {
    return outputRendererRef.current?.getVisibleText() ?? getOutputText();
  }, [getOutputText]);

  const renderCopyOutputButton = () => (
    <ToolCardCopyAction
      getText={getVisibleOutputText}
      disabled={!getOutputText().trim()}
      tooltip={t('toolCards.execProcess.copyOutput')}
      copiedTooltip={t('toolCards.execProcess.outputCopied')}
      successMessage={t('toolCards.execProcess.outputCopied')}
      failureMessage={t('toolCards.execProcess.copyOutputFailed')}
      ariaLabel={t('toolCards.execProcess.copyOutput')}
      showSuccessNotification={false}
    />
  );

  const outputText = getOutputText();
  const waitingText = (() => {
    if (outputText || rejectedOrCancelled) {
      return undefined;
    }
    if (status === 'completed') {
      return model.resultNoticeText ?? model.noOutputText;
    }
    if (status === 'pending_confirmation') {
      return t('toolCards.approval.waiting');
    }
    if (isParamsStreaming) {
      return t('toolCards.terminal.receivingParams');
    }
    if (isRunning) {
      return model.waitingText;
    }
    return undefined;
  })();
  const footerItems: CommandToolCardFooterItem[] = [];
  const footerMetadataItems: CommandToolCardFooterItem[] = [];

  if (rejectedOrCancelled) {
    footerItems.push({ tone: 'warning', value: t(cancelledStatusLabelKey) });
  }
  if (model.workdir) {
    footerItems.push({
      grow: true,
      label: t('toolCards.terminal.workingDirectory'),
      value: model.workdir,
    });
  }
  if (model.sessionId != null) {
    footerMetadataItems.push({
      label: t('toolCards.execProcess.session'),
      value: `#${model.sessionId}`,
    });
  }
  if (model.remote) {
    footerMetadataItems.push({ value: t('toolCards.execProcess.remote') });
  }
  if (model.tty && model.kind !== 'command') {
    footerMetadataItems.push({ value: t('toolCards.execProcess.tty') });
  }
  // A non-zero exit code is command result data for the model, not an
  // execution failure. The card only reflects whether the command itself ran.
  const exitCodeFooterItem: CommandToolCardFooterItem | undefined = model.exitCode != null
    ? {
        value: t('toolCards.terminal.exitCode', { code: model.exitCode }),
      }
    : undefined;
  const wallTimeFooterItem: CommandToolCardFooterItem | undefined = model.wallTimeSeconds != null
    ? {
        value: t('toolCards.execProcess.wallTime', { seconds: model.wallTimeSeconds.toFixed(3) }),
      }
    : undefined;
  if (model.kind === 'stdin') {
    if (wallTimeFooterItem) {
      footerMetadataItems.push(wallTimeFooterItem);
    }
    if (exitCodeFooterItem) {
      footerMetadataItems.push(exitCodeFooterItem);
    }
  } else {
    if (exitCodeFooterItem) {
      footerMetadataItems.push(exitCodeFooterItem);
    }
    if (wallTimeFooterItem) {
      footerMetadataItems.push(wallTimeFooterItem);
    }
  }
  footerItems.push(...footerMetadataItems.map((item, index) => (
    index === 0
      ? { ...item, pushToEnd: true }
      : item
  )));

  return (
    <div ref={cardRootRef} data-openbitfun-adapter="exec-process-tool-card" data-tool-card-id={toolId ?? ''}>
      <CommandToolCard
        action={model.actionLabel}
        command={model.primaryText}
        copyAction={{
          copied: primaryCopied,
          copiedLabel: t('toolCards.execProcess.primaryCopied'),
          disabled: model.copyDisabled,
          label: t('toolCards.execProcess.copyPrimary'),
          onPress: copyPrimary,
        }}
        data-openbitfun-state={rejectedOrCancelled ? 'cancelled' : status === 'completed' ? 'completed' : 'active'}
        emptyCommand={model.emptyText}
        error={status === 'error'
          ? toolItem.toolResult?.error || t('toolCards.terminal.executionFailed')
          : undefined}
        footerItems={footerItems}
        isExpanded={isExpanded}
        onToggle={toggleExpanded}
        output={outputText ? (
          <LazyTerminalOutputRenderer
            ref={outputRendererRef}
            content={outputText}
            maxRows={maxRows}
          />
        ) : undefined}
        outputAction={outputText ? renderCopyOutputButton() : undefined}
        outputDensity={keepCompactCompletionPreview || isRunning ? 'compact' : 'expanded'}
        outputSizing={status === 'completed' && userToggledRef.current ? 'content' : 'fixed'}
        reserveFooter
        reserveOutput
        requiresConfirmation={status === 'pending_confirmation'}
        status={status}
        statusLabel={rejectedOrCancelled ? t(cancelledStatusLabelKey) : undefined}
        statusSummary={(
          <ToolTimeoutIndicator
            startTime={toolItem.startTime}
            isRunning={isRunning}
            timeoutMs={timeoutMs}
            showControls={false}
            completedDurationMs={status === 'completed' ? completedDurationMs : undefined}
            showCompletedDuration={isExpanded}
            completedStatus={
              status === 'completed'
                ? 'success'
                : status === 'error' ? 'error' : rejectedOrCancelled ? 'cancelled' : undefined
            }
          />
        )}
        statusTone={rejectedOrCancelled ? 'warning' : 'neutral'}
        waitingContent={waitingText}
      />
    </div>
  );
};

export default ExecProcessToolCardView;
