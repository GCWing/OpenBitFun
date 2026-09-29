/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Model round item component.
 * Renders mixed FlowItems (text + tools).
 *
 * Explore-only rounds are handled by FlowGroupRenderer. Mixed rounds reuse
 * it for each successful exploration run while leaving critical output visible.
 */

import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useFlowChatReaderValue, useTimelineReveal } from '../../timeline/readerState';
import { useTranslation } from 'react-i18next';
import { subscribeOverlayInteraction, createOverlayPortal, Button, Disclosure, Icon, IconButton, Menu, MenuItem, Tooltip } from '@openbitfun/ui';
import { AmbientToolCard, AmbientToolCardHeader, ToolCardSection, ToolCardText } from '@openbitfun/ui/flow-chat';
import { CircleAlert, Wifi } from 'lucide-react';
import type { ModelRound, ModelRoundAttempt, ModelRoundAttemptDiagnostic, FlowItem, FlowTextItem, FlowToolItem, FlowThinkingItem, ToolRejectOptions } from '../../types/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { FlowTextBlock } from '../FlowTextBlock';
import { FlowToolCard } from '../FlowToolCard';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import { useToolCardHeightContract } from '../../tool-cards/useToolCardHeightContract';
import { TypewriterRevealGateProvider } from '../../hooks/TypewriterRevealGate';
import { useCreateTypewriterRevealGate } from '../../hooks/typewriterRevealGateContext';
import { getModelRoundItemClassName } from './modelRoundItemClassName';
import { isCollapsibleTool } from '../../tool-cards/toolCardMetadata';
import { getConcurrentCapsuleRows, type ConcurrentCapsuleRow } from '../../tool-cards/toolCapsuleLayout';
import { useFlowChatContext } from './FlowChatContext';
import { ExportImageButton } from './ExportImageButton';
import { ForkSessionButton } from './ForkSessionButton';
import {
  buildModelRoundItemGroups,
  buildInlineToolGroupData,
  getModelRoundActiveItems,
  type ModelRoundItemGroup,
} from '../../grouping/roundGroups';
import { FlowGroupRenderer } from './FlowGroupRenderer';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import {
  isStartupRenderTraceEnabled,
  recordReactRenderProfile,
  startupTrace,
} from '@/shared/utils/startupTrace';
import { buildModelRoundCompletionMeta } from '../../utils/tokenUsageDisplay';
import { buildDialogTurnCopyText } from '../../utils/dialogTurnCopy';
import type { TranscriptExportScope } from '../../utils/dialogTranscriptExport';
import { buildTranscriptExportLabels } from '../../utils/transcriptExportLabels';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { canvasArtifactReferenceFromToolItem } from '../../utils/canvasArtifactPresentation';
import { areModelRoundItemPropsEqual, type ModelRoundItemProps } from './modelRoundItemMemo';
import './ModelRoundItem.scss';

const log = createLogger('ModelRoundItem');

function RetryHistoryContent({ render }: { render: () => React.ReactNode }) {
  return <ToolCardSection>{render()}</ToolCardSection>;
}

function RetryHistoryCard({
  id,
  label,
  isExpanded,
  onExpandedChange,
  nested = false,
  children,
}: {
  id: string;
  label: string;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  nested?: boolean;
  children: () => React.ReactNode;
}) {
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId: id,
    toolName: 'retry-history',
  });

  return (
    <div
      ref={cardRootRef}
      className="model-round-item__retry-history"
      data-openbitfun-product-component="model-round-item"
      data-openbitfun-product-part="retryHistory"
    >
      {nested ? (
        <Disclosure
          className="model-round-item__retry-toggle"
          data-openbitfun-product-component="model-round-item"
          data-openbitfun-product-part="retryToggle"
          data-openbitfun-state={isExpanded ? 'expanded' : undefined}
          open={isExpanded}
          onOpenChange={expanded => applyExpandedState(isExpanded, expanded, onExpandedChange)}
          summary={label}
          leading={<Icon glyph={Wifi} size="sm" />}
          unmountOnClose
        >
          <RetryHistoryContent render={children} />
        </Disclosure>
      ) : (
        <AmbientToolCard
          className="model-round-item__retry-toggle"
          data-openbitfun-product-component="model-round-item"
          data-openbitfun-product-part="retryToggle"
          status="completed"
          isExpanded={isExpanded}
          onClick={() => applyExpandedState(isExpanded, !isExpanded, onExpandedChange)}
          header={<AmbientToolCardHeader icon={<Icon glyph={Wifi} size="sm" />} action={label} />}
          expandedContent={<RetryHistoryContent render={children} />}
        />
      )}
    </div>
  );
}

interface ModelRoundGroupSummary {
  textItemCount: number;
  toolItemCount: number;
  criticalGroupCount: number;
  exploreGroupCount: number;
  contextGroupCount: number;
}

function summarizeModelRoundItemGroups(groups: ModelRoundItemGroup[]): ModelRoundGroupSummary {
  return groups.reduce<ModelRoundGroupSummary>((summary, group) => {
    if (group.type !== 'critical') {
      if (group.type === 'context') summary.contextGroupCount += 1;
      else summary.exploreGroupCount += 1;
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
    contextGroupCount: 0,
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

const RetryAttemptSection: React.FC<{
  label: string;
  diagnostic?: ModelRoundAttemptDiagnostic;
  children: React.ReactNode;
}> = ({ label, diagnostic, children }) => {
  const { t } = useTranslation('flow-chat');
  const [isOpen, setIsOpen] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const detailsId = React.useId();
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId: diagnostic?.attemptId,
    toolName: 'retry-attempt',
  });

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
        size="xs"
        variant="quiet"
        className="model-round-item__attempt-diagnostic-copy"
        data-openbitfun-product-component="model-round-item"
        data-openbitfun-product-part="action"
        data-openbitfun-state={copiedValue === valueKey ? 'copied' : undefined}
        onClick={() => void copyValue(value, valueKey)}
        aria-label={t('modelRound.attemptDiagnostics.copy')}
        icon={copiedValue === valueKey ? <Icon name="check-line" size="sm" /> : <Icon name="duplicate" size="sm" />}
      />
    </Tooltip>
  );

  const attemptLabel = (
    <span className="model-round-item__retry-attempt-label" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="attemptLabel">
      {label}
    </span>
  );

  return (
    <div
      ref={cardRootRef}
      className="model-round-item__retry-attempt"
      data-openbitfun-product-component="model-round-item"
      data-openbitfun-product-part="retryAttempt"
    >
      <ToolCardSection label={diagnostic ? undefined : attemptLabel}>
        {diagnostic && (
          <Button
            type="button"
            size="xs"
            variant="text"
            labelBehavior="static"
            className="model-round-item__attempt-diagnostic-toggle"
            data-openbitfun-product-component="model-round-item"
            data-openbitfun-product-part="diagnosticToggle"
            data-openbitfun-state={isOpen ? 'expanded' : undefined}
            onClick={() => applyExpandedState(isOpen, !isOpen, setIsOpen)}
            aria-expanded={isOpen}
            aria-controls={detailsId}
            leadingIcon={<Icon glyph={CircleAlert} size="sm" />}
          >
            {attemptLabel}
          </Button>
        )}
        {isOpen && diagnostic && (
          <ToolCardSection
            id={detailsId}
            className="model-round-item__attempt-diagnostic-details"
            data-openbitfun-product-component="model-round-item"
            data-openbitfun-product-part="diagnosticDetails"
            label={(
              <span
                className="model-round-item__attempt-diagnostic-category"
                data-openbitfun-product-component="model-round-item"
                data-openbitfun-product-part="diagnosticSection"
              >
                {attemptDiagnosticCategoryLabel(diagnostic, t)}
              </span>
            )}
          >
            {diagnostic.rawError && (
              <ToolCardSection
                className="model-round-item__attempt-diagnostic-section"
                data-openbitfun-product-component="model-round-item"
                data-openbitfun-product-part="diagnosticSection"
                label={t('modelRound.attemptDiagnostics.providerError')}
                actions={renderCopyButton(diagnostic.rawError, 'raw-error')}
              >
                <ToolCardText>{diagnostic.rawError}</ToolCardText>
              </ToolCardSection>
            )}

            {(diagnostic.toolCalls ?? []).map((toolCall, index) => {
              const toolLabel = toolCall.toolName || toolCall.toolId || t('modelRound.attemptDiagnostics.unknownTool');
              return (
                <ToolCardSection
                  key={`${toolCall.toolId ?? toolCall.toolName ?? 'tool'}:${index}`}
                  className="model-round-item__attempt-diagnostic-section"
                  data-openbitfun-product-component="model-round-item"
                  data-openbitfun-product-part="diagnosticSection"
                  label={t('modelRound.attemptDiagnostics.toolArguments', { name: toolLabel })}
                >
                  {toolCall.rawArguments && (
                    <ToolCardSection
                      label={t('modelRound.attemptDiagnostics.rawArguments')}
                      actions={renderCopyButton(toolCall.rawArguments, `raw-arguments:${index}`)}
                    >
                      <ToolCardText>{toolCall.rawArguments}</ToolCardText>
                    </ToolCardSection>
                  )}
                  {toolCall.validationError && (
                    <ToolCardSection
                      label={t('modelRound.attemptDiagnostics.validationError')}
                      actions={renderCopyButton(toolCall.validationError, `validation-error:${index}`)}
                    >
                      <ToolCardText>{toolCall.validationError}</ToolCardText>
                    </ToolCardSection>
                  )}
                </ToolCardSection>
              );
            })}
          </ToolCardSection>
        )}
        <div className="model-round-item__retry-attempt-content" data-flow-item-stack="">
          {children}
        </div>
      </ToolCardSection>
    </div>
  );
};

export const ModelRoundItem = React.memo<ModelRoundItemProps>(
  ({
    round,
    blockPart,
    projectedGroups,
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
    const [showRetryHistory, setShowRetryHistory] = useFlowChatReaderValue<boolean>(`round:${turnId}:${round.id}:retries`, false);
    const [showRoundHistory, setShowRoundHistory] = useFlowChatReaderValue<boolean>(`round:${turnId}:${round.id}:history`, false);
    const [historyChoices, setHistoryChoices] = useFlowChatReaderValue<string>(`round:${turnId}:${round.id}:attempts`, '{}');
    const openHistoryRoundAttemptIds = useMemo<Record<string, boolean>>(() => JSON.parse(historyChoices), [historyChoices]);
    const turnRevealing = useTimelineReveal(turnId, `${round.id}:${blockPart}:${round.items[0]?.id ?? ''}`, typewriterRevealGate.isAnyRevealing);
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
      if (!copied && !isCopyMenuOpen) return;

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node;
        if (copyButtonRef.current?.contains(target) || copyMenuRef.current?.contains(target)) {
          return;
        }
        setCopied(false);
        setIsCopyMenuOpen(false);
      };

      const removeOverlayMousedown0 = subscribeOverlayInteraction(copyMenuRef, 'mousedown', handleClickOutside);
      return () => {
        removeOverlayMousedown0?.();
      };
    }, [copied, isCopyMenuOpen]);

    useEffect(() => {
      if (!isCopyMenuOpen) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setIsCopyMenuOpen(false);
        }
      };

      const removeOverlayKeydown1 = subscribeOverlayInteraction(copyMenuRef, 'keydown', handleKeyDown);
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
      if ((!blockPart || blockPart === 'header') && historicalAttempts.length === 0 && showRetryHistory) {
        setShowRetryHistory(false);
      }
    }, [blockPart, historicalAttempts.length, showRetryHistory, setShowRetryHistory]);

    useEffect(() => {
      if ((!blockPart || blockPart === 'header') && historyRounds.length === 0 && showRoundHistory) {
        setShowRoundHistory(false);
      }
    }, [blockPart, historyRounds.length, showRoundHistory, setShowRoundHistory]);

    const setHistoryRoundAttemptsExpanded = useCallback((historyRoundId: string, expanded: boolean) => {
      setHistoryChoices((current) => JSON.stringify({
        ...JSON.parse(current),
        [historyRoundId]: expanded,
      }));
    }, [setHistoryChoices]);

    // Keep the recorded round order; FlowChatStore already applies immutable updates.
    const sortedItems = useMemo(
      () => getModelRoundActiveItems({ items: round.items, attempts: round.attempts }),
      [round.attempts, round.items]
    );

    // Collect settled exploration while keeping narrative and critical items
    // in their original transcript positions.
    const groupedItems = useMemo(() => {
      if (projectedGroups) return projectedGroups;
      const visibleItems = isTurnComplete
        ? sortedItems.filter(item => !canvasArtifactReferenceFromToolItem(item))
        : sortedItems;
      return buildModelRoundItemGroups({
        items: visibleItems,
        isStreaming: round.isStreaming,
        disableExploreGrouping: round.renderHints?.disableExploreGrouping === true,
        isCollapsibleTool,
      });
    }, [isTurnComplete, projectedGroups, round.isStreaming, round.renderHints?.disableExploreGrouping, sortedItems]);

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
    ) => {
      const parallelRows = getConcurrentCapsuleRows(groups.map(group => group.type === 'critical' ? group.item : null));
      return groups.map((group, groupIndex) => {
        const isLastGroup = groupIndex === groups.length - 1;
        const isLast = options.isFinalSection && isLastGroup;
        if (group.type !== 'critical') {
          const data = buildInlineToolGroupData(options.roundId, group, isLast);
          return (
            <FlowGroupRenderer
              key={`${options.keyPrefix}:${data.groupId}`}
              data={data}
              turnId={turnId}
              placement="inline"
              expandedThinkingItemIds={expandedThinkingItemIds}
            />
          );
        }
        return (
          <FlowItemRenderer
            key={`${options.keyPrefix}:${group.item.id}`}
            item={group.item}
            capsuleRow={parallelRows.get(group.item.id)}
            turnId={turnId}
            roundId={options.roundId}
            isLastItem={isLast}
            expandedThinkingItemIds={expandedThinkingItemIds}
          />
        );
      });
    }, [expandedThinkingItemIds, turnId]);

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
    const shouldReserveFooter = (!blockPart || blockPart === 'footer') && isTurnComplete &&
      isLastRound &&
      !round.isStreaming &&
      (hasContent || completionMetaItems.length > 0);
    const shouldRevealFooter = shouldReserveFooter && !typewriterRevealGate.isAnyRevealing && !turnRevealing;

    return (
      <TypewriterRevealGateProvider value={typewriterRevealGate}>
      <div
        className={getModelRoundItemClassName({
          isVisuallyStreaming,
        })}
        data-openbitfun-product-component="model-round-item"
        data-openbitfun-product-part="root"
        data-flow-item-stack=""
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
        {(!blockPart || blockPart === 'header') && round.renderHints?.continuedAfterInterruption && (
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

        {(!blockPart || blockPart === 'header') && historyRounds.length > 0 && (
          <RetryHistoryCard
            id={`${round.id}:round-history`}
            isExpanded={showRoundHistory}
            onExpandedChange={setShowRoundHistory}
            label={showRoundHistory
              ? t('modelRound.roundHistoryHide')
              : t('modelRound.roundHistoryShow', { count: historyRounds.length })}
          >
            {() => historyRounds.map((historyRound, historyIndex) => {
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
                <RetryAttemptSection
                  key={historyRound.id}
                  label={t('modelRound.roundRetryLabel', { index: historyIndex + 1 })}
                >
                  {historyOlderAttempts.length > 0 && (
                    <RetryHistoryCard
                      nested
                      id={`${historyRound.id}:attempt-history`}
                      isExpanded={showHistoryRoundAttempts}
                      onExpandedChange={expanded => setHistoryRoundAttemptsExpanded(historyRound.id, expanded)}
                      label={showHistoryRoundAttempts
                        ? t('modelRound.retryHistoryHide')
                        : t('modelRound.retryHistoryShow', { count: historyOlderAttempts.length })}
                    >
                      {() => historyOlderAttempts.map((attempt) => {
                        const attemptGroups = buildModelRoundItemGroups({
                          items: attempt.items,
                          isStreaming: false,
                          disableExploreGrouping: true,
                          isCollapsibleTool,
                        });

                        return (
                          <RetryAttemptSection
                            key={attempt.id}
                            label={t('modelRound.attemptLabel', { index: attempt.index })}
                            diagnostic={attempt.diagnostic}
                          >
                            {renderGroupList(attemptGroups, {
                              roundId: historyRound.id,
                              keyPrefix: `history-round:${historyRound.id}:attempt:${attempt.id}`,
                              isFinalSection: false,
                            })}
                          </RetryAttemptSection>
                        );
                      })}
                    </RetryHistoryCard>
                  )}
                  {renderGroupList(historyGroups, {
                    roundId: historyRound.id,
                    keyPrefix: `history-round:${historyRound.id}`,
                    isFinalSection: false,
                  })}
                </RetryAttemptSection>
              );
            })}
          </RetryHistoryCard>
        )}

        {(!blockPart || blockPart === 'header') && historicalAttempts.length > 0 && (
          <RetryHistoryCard
            id={`${round.id}:attempt-history`}
            isExpanded={showRetryHistory}
            onExpandedChange={setShowRetryHistory}
            label={showRetryHistory
              ? t('modelRound.retryHistoryHide')
              : t('modelRound.retryHistoryShow', { count: historicalAttempts.length })}
          >
            {() => historicalAttempts.map((attempt) => {
              const attemptGroups = buildModelRoundItemGroups({
                items: attempt.items,
                isStreaming: false,
                disableExploreGrouping: true,
                isCollapsibleTool,
              });

              return (
                <RetryAttemptSection
                  key={attempt.id}
                  label={t('modelRound.attemptLabel', { index: attempt.index })}
                  diagnostic={attempt.diagnostic}
                >
                  {renderGroupList(attemptGroups, {
                    roundId: round.id,
                    keyPrefix: `attempt:${attempt.id}`,
                    isFinalSection: false,
                  })}
                </RetryAttemptSection>
              );
            })}
          </RetryHistoryCard>
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
  capsuleRow?: ConcurrentCapsuleRow;
}

// Do not memoize: streaming content updates frequently.
const FlowItemRenderer: React.FC<FlowItemRendererProps> = ({
  item,
  turnId,
  roundId,
  isLastItem,
  expandedThinkingItemIds = [],
  capsuleRow,
}) => {
  const {
    onToolConfirm,
    onToolReject,
    onFileViewRequest,
    onTabOpen,
    sessionId,
    activeSessionOverride,
  } = useFlowChatContext();
  const isSubagentSurface = activeSessionOverride?.sessionKind === 'subagent';

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
          // The embedded panel owns the compact default, including persisted
          // expansion state from the primary session.
          forceExpanded={!isSubagentSurface && expandedThinkingItemIds.includes(item.id)}
        />
      );

    case 'tool': {
      const toolItem = item as FlowToolItem;

      return (
        <>
          <div className="flowchat-flow-item" data-thinking-continuation="" data-flow-item-id={item.id} data-flow-item-type="tool" data-openbitfun-product-component="model-round-item" data-openbitfun-product-part="toolItem">
            <FlowToolCard
              toolItem={toolItem}
              parallel={capsuleRow !== undefined}
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
          {capsuleRow === 'end' && <span aria-hidden="true" className="flowchat-capsule-row-break" />}
        </>
      );
    }

    default:
      return null;
  }
};
