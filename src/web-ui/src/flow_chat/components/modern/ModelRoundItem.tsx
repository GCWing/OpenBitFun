/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Model round item component.
 * Renders mixed FlowItems (text + tools).
 *
 * Note: explore-only rounds are handled by ExploreGroupRenderer,
 * and this component only renders rounds with critical output.
 */

import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, Button, Icon, IconButton, Menu, MenuItem, Tooltip } from '@openbitfun/ui';
import { CircleAlert } from 'lucide-react';
import type { ModelRound, ModelRoundAttempt, ModelRoundAttemptDiagnostic, FlowItem, FlowTextItem, FlowToolItem, FlowThinkingItem, ToolRejectOptions } from '../../types/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { FlowTextBlock } from '../FlowTextBlock';
import { FlowToolCard } from '../FlowToolCard';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import { TypewriterRevealGateProvider } from '../../hooks/TypewriterRevealGate';
import { useCreateTypewriterRevealGate } from '../../hooks/typewriterRevealGateContext';
import { getModelRoundItemClassName } from './modelRoundItemClassName';
import { isCollapsibleTool } from '../../tool-cards/toolCardMetadata';
import { useFlowChatContext } from './FlowChatContext';
import { taskCollapseStateManager } from '../../store/TaskCollapseStateManager';
import { getEffectiveToolName } from '../../utils/toolInvocationIdentity';
import { ExportImageButton } from './ExportImageButton';
import { ForkSessionButton } from './ForkSessionButton';
import {
  buildModelRoundItemGroups,
  type ModelRoundItemGroup,
} from './modelRoundItemGrouping';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  isStartupRenderTraceEnabled,
  recordReactRenderProfile,
  startupTrace,
} from '@/shared/utils/startupTrace';
import { SubagentProjectionView } from '../subagent/SubagentProjectionView';
import { buildModelRoundCompletionMeta } from '../../utils/tokenUsageDisplay';
import { buildDialogTurnCopyText } from '../../utils/dialogTurnCopy';
import type { TranscriptExportScope } from '../../utils/dialogTranscriptExport';
import { buildTranscriptExportLabels } from '../../utils/transcriptExportLabels';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { canvasArtifactReferenceFromToolItem } from '../../utils/canvasArtifactPresentation';
import { areModelRoundItemPropsEqual, type ModelRoundItemProps } from './modelRoundItemMemo';
import './ModelRoundItem.scss';
import './SubagentItems.scss';

const log = createLogger('ModelRoundItem');

interface ModelRoundGroupSummary {
  textItemCount: number;
  toolItemCount: number;
  criticalGroupCount: number;
  exploreGroupCount: number;
}

function summarizeModelRoundItemGroups(groups: ModelRoundItemGroup[]): ModelRoundGroupSummary {
  return groups.reduce<ModelRoundGroupSummary>((summary, group) => {
    if (group.type === 'explore') {
      summary.exploreGroupCount += 1;
      for (const item of group.items) {
        if (item.type === 'text') {
          summary.textItemCount += 1;
        } else if (item.type === 'tool') {
          summary.toolItemCount += 1;
        }
      }
      return summary;
    }

    summary.criticalGroupCount += 1;
    if (group.item.type === 'text') {
      summary.textItemCount += 1;
    } else if (group.item.type === 'tool') {
      summary.toolItemCount += 1;
    }
    return summary;
  }, {
    textItemCount: 0,
    toolItemCount: 0,
    criticalGroupCount: 0,
    exploreGroupCount: 0,
  });
}

interface ModelRoundRenderTraceProps {
  startedAtMs: number;
  turnId: string;
  round: ModelRound;
  itemCount: number;
  groupCount: number;
  groupSummary: ModelRoundGroupSummary;
}

const ModelRoundRenderTrace: React.FC<ModelRoundRenderTraceProps> = ({
  startedAtMs,
  turnId,
  round,
  itemCount,
  groupCount,
  groupSummary,
}) => {
  useLayoutEffect(() => {
    recordReactRenderProfile(startupTrace, {
      component: 'ModelRoundItem',
      phase: 'commit',
      actualDurationMs: performance.now() - startedAtMs,
      turnId,
      roundId: round.id,
      itemCount,
      groupCount,
      textItemCount: groupSummary.textItemCount,
      toolItemCount: groupSummary.toolItemCount,
      criticalGroupCount: groupSummary.criticalGroupCount,
      exploreGroupCount: groupSummary.exploreGroupCount,
      isStreaming: round.isStreaming,
    });
  });

  return null;
};

function sortRoundAttempts(attempts: ModelRoundAttempt[]): ModelRoundAttempt[] {
  return [...attempts].sort((left, right) => left.index - right.index);
}

function attemptDiagnosticCategoryLabel(
  diagnostic: ModelRoundAttemptDiagnostic,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (diagnostic.category) {
    case 'transient_request_error':
      return t('modelRound.attemptDiagnostics.categories.transientRequestError');
    case 'interrupted_tool_arguments':
      return t('modelRound.attemptDiagnostics.categories.interruptedToolArguments');
    case 'partial_stream_error':
      return t('modelRound.attemptDiagnostics.categories.partialStreamError');
    case 'invalid_tool_arguments':
      return t('modelRound.attemptDiagnostics.categories.invalidToolArguments');
    case 'no_effective_output':
      return t('modelRound.attemptDiagnostics.categories.noEffectiveOutput');
    case 'transient_stream_error':
      return t('modelRound.attemptDiagnostics.categories.transientStreamError');
    default:
      return t('modelRound.attemptDiagnostics.categories.unknown', { category: diagnostic.category });
  }
}

const AttemptDiagnosticDetails: React.FC<{ diagnostic: ModelRoundAttemptDiagnostic }> = ({ diagnostic }) => {
  const { t } = useTranslation('flow-chat');
  const [isOpen, setIsOpen] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const copyValue = useCallback(async (value: string, valueKey: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(valueKey);
      window.setTimeout(() => setCopiedValue(current => current === valueKey ? null : current), 2000);
    } catch (error) {
      log.error('Failed to copy attempt diagnostic value', error);
    }
  }, []);

  const renderCopyButton = (value: string, valueKey: string) => (
    <Tooltip content={copiedValue === valueKey ? t('modelRound.attemptDiagnostics.copied') : t('modelRound.attemptDiagnostics.copy')} placement="top">
      <IconButton
        type="button"
        className="model-round-item__attempt-diagnostic-copy"
        data-openbitfun-product-component="model-round-item"
        data-openbitfun-product-part="action"
        data-openbitfun-state={copiedValue === valueKey ? 'copied' : undefined}
        onClick={() => void copyValue(value, valueKey)}
        aria-label={t('modelRound.attemptDiagnostics.copy')}
        icon={copiedValue === valueKey ? <Icon name="check-line" size="lg" style={{ width: 13, height: 13 }} /> : <Icon name="duplicate" size="lg" style={{ width: 13, height: 13 }} />}
      />
    </Tooltip>
  );

  const detailsId = `attempt-diagnostic-${diagnostic.attemptId}`;

  return (
    <>
      <Tooltip content={isOpen ? t('modelRound.attemptDiagnostics.hide') : t('modelRound.attemptDiagnostics.show')} placement="top">
        <IconButton
          type="button"
          className="model-round-item__attempt-diagnostic-toggle"
          data-openbitfun-product-component="model-round-item"
          data-openbitfun-product-part="diagnosticToggle"
          data-openbitfun-state={isOpen ? 'expanded' : undefined}
          onClick={() => setIsOpen(current => !current)}
          aria-expanded={isOpen}
          aria-controls={detailsId}
          aria-label={isOpen ? t('modelRound.attemptDiagnostics.hide') : t('modelRound.attemptDiagnostics.show')}
          icon={<CircleAlert size={13} aria-hidden="true" />}
        />
      </Tooltip>

      {isOpen && (
        <div
          id={detailsId}
          className="model-round-item__attempt-diagnostic-details"
          data-openbitfun-product-component="model-round-item"
          data-openbitfun-product-part="diagnosticDetails"
        >
          <div
            className="model-round-item__attempt-diagnostic-category"
            data-openbitfun-product-component="model-round-item"
            data-openbitfun-product-part="diagnosticSection"
          >
            {attemptDiagnosticCategoryLabel(diagnostic, t)}
          </div>

          {diagnostic.rawError && (
            <div className="model-round-item__attempt-diagnostic-section" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="diagnosticSection">
              <div className="model-round-item__attempt-diagnostic-section-header">
                <span>{t('modelRound.attemptDiagnostics.providerError')}</span>
                {renderCopyButton(diagnostic.rawError, 'raw-error')}
              </div>
              <pre>{diagnostic.rawError}</pre>
            </div>
          )}

          {(diagnostic.toolCalls ?? []).map((toolCall, index) => {
            const toolLabel = toolCall.toolName || toolCall.toolId || t('modelRound.attemptDiagnostics.unknownTool');
            return (
              <div
                key={`${toolCall.toolId ?? toolCall.toolName ?? 'tool'}:${index}`}
                className="model-round-item__attempt-diagnostic-section"
                data-openbitfun-product-component="model-round-item"
                data-openbitfun-product-part="diagnosticSection"
              >
                <div className="model-round-item__attempt-diagnostic-tool-title">
                  {t('modelRound.attemptDiagnostics.toolArguments', { name: toolLabel })}
                </div>
                {toolCall.rawArguments && (
                  <>
                    <div className="model-round-item__attempt-diagnostic-section-header">
                      <span>{t('modelRound.attemptDiagnostics.rawArguments')}</span>
                      {renderCopyButton(toolCall.rawArguments, `raw-arguments:${index}`)}
                    </div>
                    <pre>{toolCall.rawArguments}</pre>
                  </>
                )}
                {toolCall.validationError && (
                  <>
                    <div className="model-round-item__attempt-diagnostic-section-header">
                      <span>{t('modelRound.attemptDiagnostics.validationError')}</span>
                      {renderCopyButton(toolCall.validationError, `validation-error:${index}`)}
                    </div>
                    <pre>{toolCall.validationError}</pre>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};

function useTaskCollapsed(toolId: string): boolean {
  const [isCollapsed, setIsCollapsed] = useState(() =>
    taskCollapseStateManager.isCollapsed(toolId)
  );

  useEffect(() => {
    setIsCollapsed(taskCollapseStateManager.isCollapsed(toolId));

    const unsubscribe = taskCollapseStateManager.addListener((changedToolId, collapsed) => {
      if (changedToolId === toolId) {
        setIsCollapsed(collapsed);
      }
    });

    return unsubscribe;
  }, [toolId]);

  return isCollapsed;
}

interface TaskWithSubagentWrapperProps {
  taskItem: FlowItem;
  parentTaskToolId: string;
  parentSessionId?: string;
  directSubagentSessionId?: string;
  directSubagentDialogTurnId?: string;
  turnId: string;
  roundId?: string;
}

const TaskWithSubagentWrapper: React.FC<TaskWithSubagentWrapperProps> = React.memo(({
  taskItem,
  parentTaskToolId,
  parentSessionId,
  directSubagentSessionId,
  directSubagentDialogTurnId,
  turnId,
  roundId,
}) => {
  const isCollapsed = useTaskCollapsed(parentTaskToolId);
  const isTaskRunning =
    taskItem.status === 'preparing' || taskItem.status === 'streaming' || taskItem.status === 'running';
  const hasPrompt = Boolean(
    taskItem.type === 'tool' &&
    (taskItem as FlowToolItem).toolCall?.input?.prompt
  );
  const className = [
    'task-with-subagent-wrapper',
    !isCollapsed && 'task-with-subagent-wrapper--expanded',
    hasPrompt && 'task-with-subagent-wrapper--has-prompt',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      data-openbitfun-product-component="model-round-item"
      data-openbitfun-product-part="subagent"
      data-openbitfun-state={!isCollapsed ? 'expanded' : undefined}
    >
      <FlowItemRenderer
        item={taskItem}
        turnId={turnId}
        roundId={roundId}
        isLastItem={false}
      />
      <SubagentProjectionView
        parentTaskToolId={parentTaskToolId}
        parentSessionId={parentSessionId}
        directSubagentSessionId={directSubagentSessionId}
        directSubagentDialogTurnId={directSubagentDialogTurnId}
        parentToolIds={new Set<string>([parentTaskToolId, (taskItem as FlowToolItem).toolCall?.id].filter(Boolean) as string[])}
        liveItemsMode={isTaskRunning ? 'full-turn' : 'last-round'}
        turnId={turnId}
      />
    </div>
  );
});

export const ModelRoundItem = React.memo<ModelRoundItemProps>(
  ({
    round,
    turnId,
    isLastRound = false,
    isTurnComplete = false,
    turnStartedAt,
    turnEndedAt,
    turnDurationMs,
    canvasArtifactItems = [],
    expandedThinkingItemIds = [],
  }) => {
    const { t } = useTranslation('flow-chat');
    const { formatDate } = useI18n('flow-chat');
    const { sessionId, allowTranscriptExport = true } = useFlowChatContext();
    const typewriterRevealGate = useCreateTypewriterRevealGate();
    const [copied, setCopied] = useState(false);
    const [showRetryHistory, setShowRetryHistory] = useState(false);
    const [showRoundHistory, setShowRoundHistory] = useState(false);
    const [openHistoryRoundAttemptIds, setOpenHistoryRoundAttemptIds] = useState<Record<string, boolean>>({});
    const [isCopyMenuOpen, setIsCopyMenuOpen] = useState(false);
    const copyButtonRef = useRef<HTMLButtonElement>(null);
    const copyMenuRef = useRef<HTMLDivElement>(null);
    const copyMenuLayout = useAnchoredPopoverPosition({
      open: isCopyMenuOpen,
      anchorRef: copyButtonRef,
      popoverRef: copyMenuRef,
      preferredPlacement: 'top',
      alignment: 'end',
      gap: 4,
    });
    const renderTraceEnabled = isStartupRenderTraceEnabled();
    const renderTraceStartedAtMs = renderTraceEnabled ? performance.now() : null;

    useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
      if (!copied && !isCopyMenuOpen) return;

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node;
        if (copyButtonRef.current?.contains(target) || copyMenuRef.current?.contains(target)) {
          return;
        }
        setCopied(false);
        setIsCopyMenuOpen(false);
      };

      removeOverlayMousedown0 = subscribeOverlayInteraction(copyMenuRef, 'mousedown', handleClickOutside);
      return () => {
        removeOverlayMousedown0?.();
      };
    }, [copied, isCopyMenuOpen]);

    useEffect(() => {
    let removeOverlayKeydown1: (() => void) | undefined;
      if (!isCopyMenuOpen) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setIsCopyMenuOpen(false);
        }
      };

      removeOverlayKeydown1 = subscribeOverlayInteraction(copyMenuRef, 'keydown', handleKeyDown);
      return () => {
        removeOverlayKeydown1?.();
      };
    }, [isCopyMenuOpen]);

    const attempts = useMemo(
      () => sortRoundAttempts(round.attempts ?? []),
      [round.attempts]
    );
    const activeAttempt = [...attempts].reverse().find(attempt => !attempt.diagnostic);
    const historicalAttempts = attempts.filter(attempt => attempt !== activeAttempt);
    const historyRounds = round.historyRounds ?? [];

    useEffect(() => {
      if (historicalAttempts.length === 0 && showRetryHistory) {
        setShowRetryHistory(false);
      }
    }, [historicalAttempts.length, showRetryHistory]);

    useEffect(() => {
      if (historyRounds.length === 0 && showRoundHistory) {
        setShowRoundHistory(false);
      }
    }, [historyRounds.length, showRoundHistory]);

    const toggleHistoryRoundAttempts = useCallback((historyRoundId: string) => {
      setOpenHistoryRoundAttemptIds((current) => ({
        ...current,
        [historyRoundId]: !current[historyRoundId],
      }));
    }, []);

    // Keep the recorded round order; FlowChatStore already applies immutable updates.
    const sortedItems = useMemo(
      () => activeAttempt?.items ?? (attempts.length === 0 ? round.items : []),
      [activeAttempt?.items, attempts.length, round.items]
    );

    // Group items in two passes:
    // 1) group subagent items
    // 2) group normal items into explore/critical via anchor tool
    const groupedItems = useMemo(() => {
      const visibleItems = isTurnComplete
        ? sortedItems.filter(item => !canvasArtifactReferenceFromToolItem(item))
        : sortedItems;
      return buildModelRoundItemGroups({
        items: visibleItems,
        isStreaming: round.isStreaming,
        disableExploreGrouping: round.renderHints?.disableExploreGrouping === true,
        isCollapsibleTool,
      });
    }, [isTurnComplete, round.isStreaming, round.renderHints?.disableExploreGrouping, sortedItems]);

    const groupSummary = useMemo(
      () => renderTraceEnabled ? summarizeModelRoundItemGroups(groupedItems) : null,
      [groupedItems, renderTraceEnabled],
    );

    const renderGroupList = useCallback((
      groups: ModelRoundItemGroup[],
      options: {
        roundId: string;
        keyPrefix: string;
        isFinalSection: boolean;
      },
    ) => (
      groups.map((group, groupIndex) => {
        const isLastGroup = groupIndex === groups.length - 1;
        const isLast = options.isFinalSection && isLastGroup;
        switch (group.type) {
          case 'explore':
            return group.items.map((item, itemIdx) => (
              <FlowItemRenderer
                key={`${options.keyPrefix}:${item.id}`}
                item={item}
                turnId={turnId}
                roundId={options.roundId}
                isLastItem={isLast && itemIdx === group.items.length - 1}
                expandedThinkingItemIds={expandedThinkingItemIds}
              />
            ));

          case 'critical': {
            const projectedSubagent = group.item.type === 'tool' && getEffectiveToolName(group.item as FlowToolItem) === 'Task'
              ? group.item as FlowToolItem
              : undefined;
            if (projectedSubagent) {
              return (
                <TaskWithSubagentWrapper
                  key={`${options.keyPrefix}:task-with-subagent-${projectedSubagent.id}`}
                  taskItem={projectedSubagent}
                  parentTaskToolId={projectedSubagent.id}
                  parentSessionId={sessionId}
                  directSubagentSessionId={projectedSubagent.subagentSessionId}
                  directSubagentDialogTurnId={projectedSubagent.subagentDialogTurnId}
                  turnId={turnId}
                  roundId={options.roundId}
                />
              );
            }
            return (
              <FlowItemRenderer
                key={`${options.keyPrefix}:${group.item.id}`}
                item={group.item}
                turnId={turnId}
                roundId={options.roundId}
                isLastItem={isLast}
                expandedThinkingItemIds={expandedThinkingItemIds}
              />
            );
          }

          default:
            return null;
        }
      })
    ), [expandedThinkingItemIds, sessionId, turnId]);

    const handleCopyScope = useCallback(async (scope: TranscriptExportScope) => {
      setIsCopyMenuOpen(false);
      try {
        const content = buildDialogTurnCopyText(turnId, scope, buildTranscriptExportLabels(t));

        if (!content.trim()) {
          // Result-only copy on a turn that produced no prose lands here.
          log.warn('No content to copy', { turnId, scope });
          notificationService.warning(t('transcriptExport.copyEmpty'));
          return;
        }

        await navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        log.error('Failed to copy', error);
        notificationService.error(t('errors:general.copyFailed'));
      }
    }, [t, turnId]);

    const hasContent = sortedItems.some(item =>
      (item.type === 'text' && (item as FlowTextItem).content.trim()) ||
      (item.type === 'tool' && (item as FlowToolItem).toolCall)
    );

    const completedAt = turnEndedAt ?? round.endTime;
    const effectiveDurationMs = turnDurationMs ??
      (typeof turnStartedAt === 'number' && typeof completedAt === 'number'
        ? Math.max(0, completedAt - turnStartedAt)
        : round.durationMs);
    const completionMetaItems = useMemo(() => buildModelRoundCompletionMeta({
      completedAt,
      durationMs: effectiveDurationMs,
      status: round.status,
      formatTime: timestamp => formatDate(new Date(timestamp), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      t,
    }), [completedAt, effectiveDurationMs, formatDate, round.status, t]);
    // Wait for typewriter catch-up before revealing footer controls. Reserve
    // footer layout as soon as the model round completes so the eventual
    // reveal does not resize the list (that resize flashed the chat pane).
    const isVisuallyStreaming = round.isStreaming || typewriterRevealGate.isAnyRevealing;
    const shouldReserveFooter = isTurnComplete &&
      isLastRound &&
      !round.isStreaming &&
      (hasContent || completionMetaItems.length > 0);
    const shouldRevealFooter = shouldReserveFooter && !typewriterRevealGate.isAnyRevealing;

    return (
      <TypewriterRevealGateProvider value={typewriterRevealGate}>
      <div
        className={getModelRoundItemClassName({
          isVisuallyStreaming,
        })}
        data-openbitfun-product-component="model-round-item"
        data-openbitfun-product-part="root"
        data-openbitfun-status={round.status}
        data-openbitfun-state={isVisuallyStreaming ? 'streaming' : undefined}
        data-testid="chat-assistant-message"
        data-turn-id={turnId}
        data-round-id={round.id}
        data-status={round.status}
        data-model-config-id={round.modelConfigId || ''}
        data-effective-model-name={round.effectiveModelName || ''}
        data-streaming={isVisuallyStreaming ? 'true' : 'false'}
      >
        {round.renderHints?.continuedAfterInterruption && (
          <div className="model-round-item__continuation">{t('modelRound.continued')}</div>
        )}
        {renderTraceEnabled && renderTraceStartedAtMs !== null && groupSummary && (
          <ModelRoundRenderTrace
            startedAtMs={renderTraceStartedAtMs}
            turnId={turnId}
            round={round}
            itemCount={sortedItems.length}
            groupCount={groupedItems.length}
            groupSummary={groupSummary}
          />
        )}

        {historyRounds.length > 0 && (
          <div className="model-round-item__retry-history" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="retryHistory">
            <Button labelBehavior="static" variant="text"
              type="button"
              className="model-round-item__retry-toggle"
              data-openbitfun-product-component="model-round-item"
              data-openbitfun-product-part="retryToggle"
              data-openbitfun-state={showRoundHistory ? 'expanded' : undefined}
              onClick={() => setShowRoundHistory(current => !current)}
            >
              {showRoundHistory
                ? t('modelRound.roundHistoryHide')
                : t('modelRound.roundHistoryShow', { count: historyRounds.length })}
            </Button>

            {showRoundHistory && historyRounds.map((historyRound, historyIndex) => {
              const historyAttempts = sortRoundAttempts(historyRound.attempts ?? []);
              const historyOlderAttempts = historyAttempts.length > 1
                ? historyAttempts.slice(0, -1)
                : [];
              const historyLatestAttempt = historyAttempts.length > 0
                ? historyAttempts[historyAttempts.length - 1]
                : undefined;
              const showHistoryRoundAttempts = openHistoryRoundAttemptIds[historyRound.id] === true;
              const historyGroups = buildModelRoundItemGroups({
                items: historyLatestAttempt?.items ?? historyRound.items,
                isStreaming: false,
                disableExploreGrouping: true,
                isCollapsibleTool,
              });

              return (
                <div key={historyRound.id} className="model-round-item__retry-attempt" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="retryAttempt">
                  <div className="model-round-item__retry-attempt-label" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="attemptLabel">
                    {t('modelRound.roundRetryLabel', { index: historyIndex + 1 })}
                  </div>
                  {historyOlderAttempts.length > 0 && (
                    <div className="model-round-item__retry-history" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="retryHistory">
                      <Button labelBehavior="static" variant="text"
                        type="button"
                        className="model-round-item__retry-toggle"
                        data-openbitfun-product-component="model-round-item"
                        data-openbitfun-product-part="retryToggle"
                        data-openbitfun-state={showHistoryRoundAttempts ? 'expanded' : undefined}
                        onClick={() => toggleHistoryRoundAttempts(historyRound.id)}
                      >
                        {showHistoryRoundAttempts
                          ? t('modelRound.retryHistoryHide')
                          : t('modelRound.retryHistoryShow', { count: historyOlderAttempts.length })}
                      </Button>

                      {showHistoryRoundAttempts && historyOlderAttempts.map((attempt) => {
                        const attemptGroups = buildModelRoundItemGroups({
                          items: attempt.items,
                          isStreaming: false,
                          disableExploreGrouping: true,
                          isCollapsibleTool,
                        });

                        return (
                          <div key={attempt.id} className="model-round-item__retry-attempt" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="retryAttempt">
                            <div className="model-round-item__retry-attempt-label" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="attemptLabel">
                              <span>{t('modelRound.attemptLabel', { index: attempt.index })}</span>
                              {attempt.diagnostic && <AttemptDiagnosticDetails diagnostic={attempt.diagnostic} />}
                            </div>
                            {renderGroupList(attemptGroups, {
                              roundId: historyRound.id,
                              keyPrefix: `history-round:${historyRound.id}:attempt:${attempt.id}`,
                              isFinalSection: false,
                            })}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {renderGroupList(historyGroups, {
                    roundId: historyRound.id,
                    keyPrefix: `history-round:${historyRound.id}`,
                    isFinalSection: false,
                  })}
                </div>
              );
            })}
          </div>
        )}

        {historicalAttempts.length > 0 && (
          <div className="model-round-item__retry-history" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="retryHistory">
            <Button labelBehavior="static" variant="text"
              type="button"
              className="model-round-item__retry-toggle"
              data-openbitfun-product-component="model-round-item"
              data-openbitfun-product-part="retryToggle"
              data-openbitfun-state={showRetryHistory ? 'expanded' : undefined}
              onClick={() => setShowRetryHistory(current => !current)}
            >
              {showRetryHistory
                ? t('modelRound.retryHistoryHide')
                : t('modelRound.retryHistoryShow', { count: historicalAttempts.length })}
            </Button>

            {showRetryHistory && historicalAttempts.map((attempt) => {
              const attemptGroups = buildModelRoundItemGroups({
                items: attempt.items,
                isStreaming: false,
                disableExploreGrouping: true,
                isCollapsibleTool,
              });

              return (
                <div key={attempt.id} className="model-round-item__retry-attempt" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="retryAttempt">
                  <div className="model-round-item__retry-attempt-label" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="attemptLabel">
                    <span>{t('modelRound.attemptLabel', { index: attempt.index })}</span>
                    {attempt.diagnostic && <AttemptDiagnosticDetails diagnostic={attempt.diagnostic} />}
                  </div>
                  {renderGroupList(attemptGroups, {
                    roundId: round.id,
                    keyPrefix: `attempt:${attempt.id}`,
                    isFinalSection: false,
                  })}
                </div>
              );
            })}
          </div>
        )}

        {renderGroupList(groupedItems, {
          roundId: round.id,
          keyPrefix: activeAttempt ? `attempt:${activeAttempt.id}` : 'round',
          isFinalSection: isLastRound,
        })}

        {canvasArtifactItems.length > 0 && (
          <div
            className="model-round-item__canvas-attachments"
            data-openbitfun-product-component="model-round-item"
            data-openbitfun-product-part="canvasAttachments"
          >
            {canvasArtifactItems.map((item, index) => (
              <FlowItemRenderer
                key={`canvas-attachment:${item.id}`}
                item={item}
                turnId={turnId}
                roundId={round.id}
                isLastItem={index === canvasArtifactItems.length - 1}
                expandedThinkingItemIds={expandedThinkingItemIds}
              />
            ))}
          </div>
        )}

        {shouldReserveFooter && (
          <div
            className={`model-round-item__footer${shouldRevealFooter ? '' : ' model-round-item__footer--pending'}`}
            data-openbitfun-product-component="model-round-item"
            data-openbitfun-product-part="footer"
            data-openbitfun-state={shouldRevealFooter ? undefined : 'pending'}
            aria-hidden={!shouldRevealFooter}
          >
            {completionMetaItems.length > 0 && (
              <div
                className="model-round-item__meta"
                data-openbitfun-product-component="model-round-item"
                data-openbitfun-product-part="meta"
                aria-label={t('modelRound.meta.label')}
              >
                {completionMetaItems.map(item => (
                  <span
                    key={item.key}
                    className="model-round-item__meta-item"
                    data-openbitfun-product-component="model-round-item"
                    data-openbitfun-product-part="metaItem"
                    aria-label={`${item.label}: ${item.value}`}
                  >
                    {item.value}
                  </span>
                ))}
              </div>
            )}

            <div className="model-round-item__actions">
              <ForkSessionButton sessionId={sessionId} turnId={turnId} />

              {allowTranscriptExport && <div className="model-round-item__copy-menu-anchor">
                <Tooltip content={copied ? t('modelRound.copiedDialog') : t('modelRound.copyDialog')} placement="top">
                  <IconButton
                    ref={copyButtonRef}
                    className={`model-round-item__action-btn model-round-item__copy-btn ${copied ? 'copied' : ''}`}
                    onClick={() => setIsCopyMenuOpen(current => !current)}
                    tabIndex={shouldRevealFooter ? 0 : -1}
                    disabled={!shouldRevealFooter}
                    aria-haspopup="menu"
                    aria-expanded={isCopyMenuOpen}
                    aria-label={copied ? t('modelRound.copiedDialog') : t('modelRound.copyDialog')}
                    data-testid="model-round-copy-btn"
                    data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="action" data-openbitfun-state={copied ? 'copied' : undefined}
                    icon={<Icon name={copied ? 'check-line' : 'duplicate'} size="sm" />}
                  />
                </Tooltip>

                {isCopyMenuOpen && createOverlayPortal(
                  <Menu
                    ref={copyMenuRef}
                    className="model-round-item__copy-menu"
                    data-testid="model-round-copy-menu"
                    data-openbitfun-placement={copyMenuLayout?.placement ?? 'top'}
                    style={{
                      top: `${copyMenuLayout?.top ?? 0}px`,
                      left: `${copyMenuLayout?.left ?? 0}px`,
                      visibility: copyMenuLayout ? 'visible' : 'hidden',
                    }}
                  >
                    <MenuItem
                      type="button"
                      onClick={() => void handleCopyScope('full')}
                      data-testid="model-round-copy-full"
                    >
                      {t('transcriptExport.copyFull')}
                    </MenuItem>
                    <MenuItem
                      type="button"
                      onClick={() => void handleCopyScope('result')}
                      data-testid="model-round-copy-result"
                    >
                      {t('transcriptExport.copyResult')}
                    </MenuItem>
                  </Menu>,
                  getAppearanceOverlayHost(),
                )}
              </div>}

              {allowTranscriptExport && <ExportImageButton turnId={turnId} />}
            </div>
          </div>
        )}
      </div>
      </TypewriterRevealGateProvider>
    );
  },
  areModelRoundItemPropsEqual
);

ModelRoundItem.displayName = 'ModelRoundItem';

/**
 * FlowItem renderer (text or tool).
 */
interface FlowItemRendererProps {
  item: FlowItem;
  turnId: string;
  roundId?: string;
  isLastItem?: boolean;
  expandedThinkingItemIds?: string[];
}

// Do not memoize: streaming content updates frequently.
const FlowItemRenderer: React.FC<FlowItemRendererProps> = ({
  item,
  turnId,
  roundId,
  isLastItem,
  expandedThinkingItemIds = [],
}) => {
  const {
    onToolConfirm,
    onToolReject,
    onFileViewRequest,
    onTabOpen,
    sessionId,
  } = useFlowChatContext();

  switch (item.type) {
    case 'text':
      return (
        <FlowTextBlock
          textItem={item as FlowTextItem}
          traceContext={{
            turnId,
            roundId,
            itemId: item.id,
          }}
          testId="chat-assistant-message-content"
          testAttributes={{
            'data-turn-id': turnId,
            'data-flow-item-id': item.id,
            'data-status': item.status,
          }}
        />
      );

    case 'thinking':
      return (
        <ModelThinkingDisplay
          thinkingItem={item as FlowThinkingItem}
          isLastItem={isLastItem}
          forceExpanded={expandedThinkingItemIds.includes(item.id)}
        />
      );

    case 'tool': {
      const toolItem = item as FlowToolItem;

      return (
        <div className="flowchat-flow-item" data-flow-item-id={item.id} data-flow-item-type="tool" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="toolItem">
          <FlowToolCard
            toolItem={toolItem}
            isLastItem={isLastItem}
            onConfirm={async (toolId: string, permissionOptionId?: string, approve?: boolean) => {
              if (onToolConfirm) {
                await onToolConfirm(toolId, permissionOptionId, approve);
              }
            }}
            onReject={async (_toolId: string, options?: ToolRejectOptions) => {
              if (onToolReject) {
                await onToolReject(item.id, options);
              }
            }}
            onOpenInEditor={(filePath: string) => {
              if (onFileViewRequest) {
                onFileViewRequest(filePath, filePath.split(/[/\\]/).pop() || filePath);
              }
            }}
            onOpenInPanel={(_panelType: string, data: any) => {
              if (onTabOpen) {
                onTabOpen(data, sessionId);
              }
            }}
            sessionId={sessionId}
            turnId={turnId}
          />
        </div>
      );
    }

    default:
      return null;
  }
};
