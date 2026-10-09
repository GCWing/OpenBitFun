import { useCallback, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { CommandToolCard, type CommandToolCardFooterItem } from '@openbitfun/ui/flow-chat';
import type { ExecProcessCardModel, ExecToolSnapshot, PresentationClock, PresentationTranslate } from './contracts';
import { formatSessionViewPreviewText } from '../sessionViewPreview';
import { ExecRelationPresentation } from './ExecRelationPresentation';

const EXEC_COLLAPSED_STATUSES = new Set(['completed', 'cancelled', 'error', 'rejected']);
const EXEC_OUTPUT_EXPANDED_MAX_ROWS = 15;

export interface ExecStatusPresentation {
  startTime?: number;
  isRunning: boolean;
  timeoutMs?: number;
  showControls: false;
  completedDurationMs?: number;
  showCompletedDuration: boolean;
  completedStatus?: 'success' | 'error' | 'cancelled';
}

export interface ExecOutputHandle { getVisibleText: () => string }
export interface ExecProcessPresentationProps {
  toolItem: ExecToolSnapshot;
  model: ExecProcessCardModel;
  attention?: 'ambient' | 'prominent';
  t: PresentationTranslate;
  rootRef?: Ref<HTMLDivElement>;
  onExpandedChange?: (expanded: boolean) => void;
  primaryCopied?: boolean;
  onCopyPrimary: () => void;
  renderOutput: (props: { content: string; maxRows: number; ref: Ref<ExecOutputHandle>; surface: 'standalone' | 'embedded' }) => ReactNode;
  renderOutputAction: (getText: () => string) => ReactNode;
  renderStatus: (props: ExecStatusPresentation) => ReactNode;
  clock?: PresentationClock;
  initialExpanded?: boolean;
  expanded?: boolean;
  /** Public card pseudo-state used only by static component specimens. */
  previewState?: 'hover';
}

function isCollapsedStatus(status: string): boolean {
  return EXEC_COLLAPSED_STATUSES.has(status);
}

function isCancelledStatus(status: string): boolean {
  return status === 'cancelled';
}

function isUserRejectedTool(toolItem: ExecToolSnapshot): boolean {
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

function isRejectedOrCancelledStatus(toolItem: ExecToolSnapshot): boolean {
  return isCancelledStatus(toolItem.status) || isUserRejectedTool(toolItem);
}

function readProgressLogs(toolItem: ExecToolSnapshot): string[] {
  const logs = toolItem._progressLogs;
  return Array.isArray(logs) ? logs.filter((entry): entry is string => typeof entry === 'string') : [];
}

function formatSecondsAsMs(seconds?: number): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1000))
    : undefined;
}

export function ExecProcessPresentation(props: ExecProcessPresentationProps) {
  return props.model.interaction ? <ExecRelationPresentation {...props} /> : <ExecCommandPresentation {...props} />;
}

function ExecCommandPresentation({
  toolItem, model, attention = 'prominent', t, rootRef, onExpandedChange, primaryCopied = false,
  onCopyPrimary, renderOutput, renderOutputAction, renderStatus,
  initialExpanded = false, expanded, previewState,
}: ExecProcessPresentationProps) {
  const status = toolItem.status || 'pending';
  const isParamsStreaming = Boolean(toolItem.isParamsStreaming);
  const progressLogs = useMemo(() => readProgressLogs(toolItem), [toolItem]);
  const liveOutput = useMemo(() => {
    if (progressLogs.length > 0) {
      return progressLogs.join('');
    }
    const progressMessage = toolItem._progressMessage;
    return typeof progressMessage === 'string' ? progressMessage : '';
  }, [progressLogs, toolItem]);
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running' || status === 'receiving';
  const rejectedOrCancelled = isRejectedOrCancelledStatus(toolItem);
  const cancelledStatusLabelKey = isUserRejectedTool(toolItem)
    ? 'toolCards.terminal.rejected'
    : 'toolCards.terminal.cancelled';
  const toolId = toolItem.id ?? toolItem.toolCall?.id;
  const [localExpanded, setIsExpandedState] = useState(initialExpanded);
  const isExpanded = expanded ?? localExpanded;
  const outputRendererRef = useRef<ExecOutputHandle | null>(null);
  const toggleExpanded = useCallback(() => {
    const nextExpanded = !isExpanded;
    setIsExpandedState(nextExpanded);
    onExpandedChange?.(nextExpanded);
  }, [isExpanded, onExpandedChange]);

  const maxRows = EXEC_OUTPUT_EXPANDED_MAX_ROWS;
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
  const exitCodeLabel = isExpanded && model.exitCode != null
    ? t('toolCards.terminal.exitCode', { code: model.exitCode })
    : undefined;
  const exitCodeFooterItem: CommandToolCardFooterItem | undefined = exitCodeLabel
    ? {
        value: exitCodeLabel,
      }
    : undefined;
  const wallTimeFooterItem: CommandToolCardFooterItem | undefined = model.wallTimeSeconds != null
    ? { value: t('toolCards.execProcess.wallTime', { seconds: model.wallTimeSeconds.toFixed(3) }) }
    : undefined;
  if (model.kind === 'stdin') {
    if (wallTimeFooterItem) footerMetadataItems.push(wallTimeFooterItem);
    if (exitCodeFooterItem) footerMetadataItems.push(exitCodeFooterItem);
  } else {
    if (exitCodeFooterItem) footerMetadataItems.push(exitCodeFooterItem);
    if (wallTimeFooterItem) footerMetadataItems.push(wallTimeFooterItem);
  }
  footerItems.push(...footerMetadataItems.map((item, index) => (
    index === 0
      ? { ...item, pushToEnd: true }
      : item
  )));

  return (
    <div ref={rootRef} data-openbitfun-adapter="exec-process-tool-card" data-tool-card-id={toolId ?? ''}>
      <CommandToolCard
        attention={attention}
        data-openbitfun-preview-state={previewState}
        action={model.actionLabel}
        command={model.primaryText}
        interaction={model.interaction}
        copyAction={{
          copied: primaryCopied,
          copiedLabel: t('toolCards.execProcess.primaryCopied'),
          disabled: model.copyDisabled,
          label: t('toolCards.execProcess.copyPrimary'),
          onPress: onCopyPrimary,
        }}
        data-openbitfun-state={rejectedOrCancelled ? 'cancelled' : status === 'completed' ? 'completed' : 'active'}
        emptyCommand={model.emptyText}
        error={status === 'error'
          ? toolItem.toolResult?.error || t('toolCards.terminal.executionFailed')
          : undefined}
        footerItems={footerItems}
        isExpanded={isExpanded}
        onToggle={toggleExpanded}
        output={outputText ? renderOutput({ ref: outputRendererRef, content: outputText, maxRows, surface: 'embedded' }) : undefined}
        outputAction={outputText ? renderOutputAction(getOutputText) : undefined}
        outputLabel={t('toolCards.common.executionResult')}
        outputDensity="expanded"
        outputSizing="content"
        reserveFooter={isRunning || isParamsStreaming}
        reserveOutput={isRunning || isParamsStreaming}
        requiresConfirmation={status === 'pending_confirmation'}
        status={status}
        statusLabel={rejectedOrCancelled ? t(cancelledStatusLabelKey) : model.resultNoticeText}
        statusSummary={renderStatus({
          startTime: toolItem.startTime,
          isRunning,
          timeoutMs,
          showControls: false,
          completedDurationMs: isCollapsedStatus(status) ? completedDurationMs : undefined,
          showCompletedDuration: isExpanded,
          completedStatus: status === 'completed' ? 'success'
            : status === 'error' ? 'error' : rejectedOrCancelled ? 'cancelled' : undefined,
        })}
        statusTone={rejectedOrCancelled ? 'warning' : 'neutral'}
        waitingContent={waitingText}
      />
    </div>
  );
}
