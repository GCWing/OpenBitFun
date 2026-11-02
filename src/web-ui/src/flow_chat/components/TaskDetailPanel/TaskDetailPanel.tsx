/**
 * TaskDetailPanel - Subtask detail panel.
 * Minimal layout to match the FlowChat background.
 */

import { Disclosure, OverflowText, Icon, IconButton, Spinner, Toolbar, ToolbarGroup, Tooltip } from '@openbitfun/ui';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Square } from 'lucide-react';
import type { FlowToolItem, FlowItem, FlowChatState } from '../../types/flow-chat';
import { FlowChatStore } from '../../store/FlowChatStore';
import { ToolTimeoutIndicator } from '../../tool-cards/ToolTimeoutIndicator';
import { createLogger } from '@/shared/utils/logger';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type { ReviewerContext } from '@/shared/services/reviewTeamService';
import { SubagentProjectionView } from '../subagent/SubagentProjectionView';
import { getSubagentProjectionState } from '../../utils/subagentProjection';
import { useSessionGoalModeActive } from '../../hooks/useSessionGoalModeActive';
import { SubagentDelegationAvatar, resolveSubagentNameKey } from '../../subagent-identity';
import './TaskDetailPanel.scss';

const log = createLogger('TaskDetailPanel');
const TASK_DETAIL_INITIAL_RENDER_COUNT = 18;
const TASK_DETAIL_RENDER_BATCH_SIZE = 32;

type FlowChatSession = NonNullable<ReturnType<FlowChatStore['getState']>['sessions'] extends Map<string, infer S> ? S : never>;

interface TaskDetailSnapshot {
  toolItem: FlowToolItem | null;
  subagentSessionId?: string;
  subagentDialogTurnId?: string;
  subagentModelName?: string;
  subagentItems: FlowItem[];
  isSubagentRunning: boolean;
}

function isRunningStatus(status: FlowItem['status'] | undefined): boolean {
  return status === 'preparing' || status === 'streaming' || status === 'running';
}

function readTaskDurationMs(toolResult: FlowToolItem['toolResult'] | undefined): number | undefined {
  const resultDuration = toolResult?.result?.duration;
  if (typeof resultDuration === 'number') {
    return resultDuration;
  }
  if (typeof toolResult?.duration_ms === 'number') {
    return toolResult.duration_ms;
  }
  return undefined;
}

function areFlowItemsEqual(prev: FlowItem[], next: FlowItem[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;

  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i] as any;
    const b = next[i] as any;

    if (
      a.id !== b.id ||
      a.type !== b.type ||
      a.content !== b.content ||
      a.status !== b.status ||
      a.isStreaming !== b.isStreaming ||
      a.isParamsStreaming !== b.isParamsStreaming ||
      a.toolResult !== b.toolResult ||
      a.partialParams !== b.partialParams ||
      a.interruptionReason !== b.interruptionReason
    ) {
      return false;
    }
  }

  return true;
}

function areSnapshotsEqual(prev: TaskDetailSnapshot, next: TaskDetailSnapshot): boolean {
  return (
    prev.toolItem === next.toolItem &&
    prev.subagentSessionId === next.subagentSessionId &&
    prev.subagentDialogTurnId === next.subagentDialogTurnId &&
    prev.subagentModelName === next.subagentModelName &&
    prev.isSubagentRunning === next.isSubagentRunning &&
    areFlowItemsEqual(prev.subagentItems, next.subagentItems)
  );
}

function collectTaskDetailSnapshot(
  state: FlowChatState,
  sessionId: string | undefined,
  parentTaskToolIds: Set<string>,
  directSubagentSessionId?: string,
  directSubagentDialogTurnId?: string,
): TaskDetailSnapshot {
  if (parentTaskToolIds.size === 0 && !directSubagentSessionId) {
    return { toolItem: null, subagentItems: [], subagentSessionId: undefined, isSubagentRunning: false };
  }

  const preferredSession = sessionId ? state.sessions.get(sessionId) : undefined;
  const sessionsToSearch = preferredSession
    ? [preferredSession]
    : Array.from(state.sessions.values());

  const collectToolItem = (sessions: Iterable<FlowChatSession>): FlowToolItem | null => {
    let toolItem: FlowToolItem | null = null;

    for (const session of sessions) {
      for (const turn of session.dialogTurns) {
        for (const round of turn.modelRounds) {
          for (const item of round.items) {
            if (!toolItem && item.type === 'tool' && parentTaskToolIds.has(item.id)) {
              toolItem = item as FlowToolItem;
            }
            if (toolItem) {
              return toolItem;
            }
          }
        }
      }
    }

    return toolItem;
  };

  const preferredToolItem = collectToolItem(sessionsToSearch);
  const toolItem = preferredToolItem || (preferredSession ? collectToolItem(state.sessions.values()) : null);

  const projection = getSubagentProjectionState(state, {
    parentSessionId: sessionId,
    parentToolIds: parentTaskToolIds,
    directSubagentSessionId,
    directSubagentDialogTurnId,
  });

  if (toolItem || projection.items.length > 0 || projection.session || !preferredSession) {
    return {
      toolItem,
      subagentSessionId: projection.session?.sessionId,
      subagentDialogTurnId: projection.turn?.id,
      subagentModelName: projection.session?.config?.modelName,
      subagentItems: projection.items,
      isSubagentRunning: projection.isRunning,
    };
  }

  const fallbackProjection = getSubagentProjectionState(state, {
    parentSessionId: undefined,
    parentToolIds: parentTaskToolIds,
    directSubagentSessionId,
    directSubagentDialogTurnId,
  });

  return {
    toolItem,
    subagentSessionId: fallbackProjection.session?.sessionId,
    subagentDialogTurnId: fallbackProjection.turn?.id,
    subagentModelName: fallbackProjection.session?.config?.modelName,
    subagentItems: fallbackProjection.items,
    isSubagentRunning: fallbackProjection.isRunning,
  };
}

export interface TaskDetailData {
  toolItem: FlowToolItem;
  taskInput: {
    description: string;
    prompt: string;
    agentType: string;
    modelName?: string;
    reviewerContext?: ReviewerContext | null;
    isReviewCoverageTask?: boolean;
  } | null;
  sessionId?: string;
}

export interface TaskDetailPanelProps {
  data: TaskDetailData;
}

export const TaskDetailPanel: React.FC<TaskDetailPanelProps> = ({ data }) => {
  const { t } = useTranslation('flow-chat');
  const { t: tAgents } = useTranslation('scenes/agents');
  const { toolItem: initialToolItem, taskInput, sessionId } = data || {};
  const isReviewCoverageTask = Boolean(taskInput?.isReviewCoverageTask);
  const defaultTimeoutDisabled = useSessionGoalModeActive(sessionId);
  const parentTaskToolId = initialToolItem?.id;
  const parentTaskToolCallId = initialToolItem?.toolCall?.id;
  const directSubagentSessionId = initialToolItem?.subagentSessionId;
  const directSubagentDialogTurnId = initialToolItem?.subagentDialogTurnId;
  const parentTaskToolIds = useMemo(
    () => new Set([parentTaskToolId, parentTaskToolCallId].filter(Boolean) as string[]),
    [parentTaskToolId, parentTaskToolCallId],
  );
  const projectionParentTaskToolIds = useMemo(
    () => isReviewCoverageTask ? new Set<string>() : parentTaskToolIds,
    [isReviewCoverageTask, parentTaskToolIds],
  );
  const projectionSubagentSessionId = isReviewCoverageTask
    ? undefined
    : directSubagentSessionId;
  const projectionSubagentDialogTurnId = isReviewCoverageTask
    ? undefined
    : directSubagentDialogTurnId;
  
  const [taskSnapshot, setTaskSnapshot] = useState<TaskDetailSnapshot>(() => ({
    toolItem: initialToolItem ?? null,
    subagentItems: [],
    subagentSessionId: initialToolItem?.subagentSessionId,
    subagentDialogTurnId: initialToolItem?.subagentDialogTurnId,
    isSubagentRunning: false,
  }));
  const [isSnapshotHydrated, setIsSnapshotHydrated] = useState(false);
  const [visibleSubagentCount, setVisibleSubagentCount] = useState(0);
  const [stoppingSubagent, setStoppingSubagent] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  
  const contentRef = useRef<HTMLDivElement>(null);
  // Track auto-scroll; disable when the user scrolls up.
  const shouldAutoScrollRef = useRef(true);

  // Collect only the state this detail panel cares about, and avoid re-rendering
  // when unrelated flow-chat updates arrive.
  useEffect(() => {
    if (projectionParentTaskToolIds.size === 0 && !projectionSubagentSessionId) {
      setTaskSnapshot({
        toolItem: initialToolItem ?? null,
        subagentItems: [],
        subagentSessionId: initialToolItem?.subagentSessionId,
        subagentDialogTurnId: initialToolItem?.subagentDialogTurnId,
        isSubagentRunning: false,
      });
      setIsSnapshotHydrated(true);
      return;
    }
    
    const flowChatStore = FlowChatStore.getInstance();
    let previousSnapshot: TaskDetailSnapshot = {
      toolItem: initialToolItem ?? null,
      subagentItems: [],
      subagentSessionId: initialToolItem?.subagentSessionId,
      subagentDialogTurnId: initialToolItem?.subagentDialogTurnId,
      isSubagentRunning: false,
    };
    let hydrationFrameId: number | null = null;
    let frameId: number | null = null;
    let latestState: FlowChatState | null = null;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    setIsSnapshotHydrated(false);
    setTaskSnapshot(current => areSnapshotsEqual(current, previousSnapshot) ? current : previousSnapshot);

    const updateTaskSnapshot = (state: FlowChatState) => {
      latestState = state;
      if (frameId !== null) {
        return;
      }

      frameId = requestAnimationFrame(() => {
        frameId = null;
        if (!latestState || disposed) {
          return;
        }

        const nextSnapshot = collectTaskDetailSnapshot(
          latestState,
          sessionId,
          projectionParentTaskToolIds,
          projectionSubagentSessionId,
          projectionSubagentDialogTurnId,
        );

        if (!areSnapshotsEqual(previousSnapshot, nextSnapshot)) {
          previousSnapshot = nextSnapshot;
          setTaskSnapshot(nextSnapshot);
        }

        if (!isRunningStatus(nextSnapshot.toolItem?.status ?? initialToolItem?.status)) {
          unsubscribe?.();
          unsubscribe = null;
        }
      });
    };

    const hydrateSnapshot = () => {
      if (disposed) {
        return;
      }

      previousSnapshot = collectTaskDetailSnapshot(
        flowChatStore.getState(),
        sessionId,
        projectionParentTaskToolIds,
        projectionSubagentSessionId,
        projectionSubagentDialogTurnId,
      );

      setTaskSnapshot(current => areSnapshotsEqual(current, previousSnapshot) ? current : previousSnapshot);
      setIsSnapshotHydrated(true);

      // Completed/cancelled/error task details are static. Avoid keeping a global
      // FlowChatStore subscription alive, because streaming elsewhere would still
      // force this panel to scan the conversation tree on every store update.
      if (isRunningStatus(previousSnapshot.toolItem?.status ?? initialToolItem?.status)) {
        unsubscribe = flowChatStore.subscribe(updateTaskSnapshot);
      }
    };

    // Let the panel chrome paint before scanning and rendering a potentially
    // large subagent transcript.
    hydrationFrameId = requestAnimationFrame(() => {
      hydrationFrameId = requestAnimationFrame(hydrateSnapshot);
    });

    return () => {
      disposed = true;
      if (hydrationFrameId !== null) {
        cancelAnimationFrame(hydrationFrameId);
      }
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      unsubscribe?.();
    };
  }, [
    sessionId,
    projectionParentTaskToolIds,
    projectionSubagentSessionId,
    projectionSubagentDialogTurnId,
    initialToolItem,
    initialToolItem?.status,
  ]);

  const toolItem = taskSnapshot.toolItem || initialToolItem;
  const status = toolItem?.status;
  const toolResult = toolItem?.toolResult;
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running' || taskSnapshot.isSubagentRunning;
  const isFailed = status === 'error' || toolResult?.success === false;
  const taskDurationMs = readTaskDurationMs(toolResult);
  const isCompleted = status === 'completed' && !isFailed;
  const shouldDisplaySubagentProjection =
    !isReviewCoverageTask && taskSnapshot.isSubagentRunning;
  const subagentItems = useMemo(() => {
    if (!shouldDisplaySubagentProjection) {
      return [];
    }

    return taskSnapshot.subagentItems;
  }, [shouldDisplaySubagentProjection, taskSnapshot.subagentItems]);
  const subagentSessionId = taskSnapshot.subagentSessionId || toolItem?.subagentSessionId || directSubagentSessionId;
  const canStopSubagent = Boolean(isRunning && subagentSessionId);
  const visibleSubagentItems = useMemo(
    () => subagentItems.slice(0, visibleSubagentCount),
    [subagentItems, visibleSubagentCount],
  );
  const hasPendingSubagentRender = visibleSubagentCount < subagentItems.length;

  useEffect(() => {
    const total = subagentItems.length;

    if (total === 0) {
      setVisibleSubagentCount(0);
      return;
    }

    setVisibleSubagentCount(current => {
      if (current === 0) {
        return Math.min(TASK_DETAIL_INITIAL_RENDER_COUNT, total);
      }

      if (current > total) {
        return total;
      }

      if (isRunning && current >= total - 2) {
        return total;
      }

      return current;
    });
  }, [isRunning, subagentItems.length]);

  useEffect(() => {
    if (visibleSubagentCount >= subagentItems.length) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      setVisibleSubagentCount(current =>
        Math.min(current + TASK_DETAIL_RENDER_BATCH_SIZE, subagentItems.length)
      );
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [visibleSubagentCount, subagentItems.length]);

  const getErrorMessage = () => {
    if (isReviewCoverageTask) {
      return t('toolCards.taskTool.reviewCheckUnavailable');
    }
    if (toolResult && 'error' in toolResult) {
      return toolResult.error as string;
    }
    return t('toolCards.taskTool.subAgentFailed');
  };

  // Detect user-initiated scroll to pause auto-scroll.
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolls up, pause auto-scroll.
        shouldAutoScrollRef.current = false;
      } else if (e.deltaY > 0) {
        const { scrollTop, scrollHeight, clientHeight } = container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        if (distanceFromBottom < 100) {
          // Re-enable auto-scroll near the bottom.
          shouldAutoScrollRef.current = true;
        }
      }
    };
    
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // Auto-scroll during streaming output.
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !isRunning) return;
    
    if (shouldAutoScrollRef.current) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight - container.clientHeight;
      });
    }
  }, [isRunning, subagentItems]);
  
  // Reset auto-scroll when a run starts.
  useEffect(() => {
    if (isRunning) {
      shouldAutoScrollRef.current = true;
    }
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) {
      setStoppingSubagent(false);
    }
  }, [isRunning]);

  const handleStopSubagent = useCallback(async () => {
    if (!subagentSessionId || stoppingSubagent) {
      return;
    }

    setStoppingSubagent(true);
    setStopError(null);

    try {
      const result = await agentAPI.cancelSession(subagentSessionId);
      if (!result.cancelled) {
        setStopError(t('toolCards.taskDetailPanel.stopSubagentFailed'));
        setStoppingSubagent(false);
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('toolCards.taskDetailPanel.stopSubagentFailed');
      setStopError(message);
      log.error('Failed to stop subagent session', {
        subagentSessionId,
        error,
      });
      setStoppingSubagent(false);
    }
  }, [stoppingSubagent, subagentSessionId, t]);

  if (!toolItem) {
    return (
      <div data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="root" data-openbitfun-state="empty" className="task-detail-panel task-detail-panel--empty">
        <div className="task-detail-panel__header" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="header">
          <Toolbar size="sm" leading={<OverflowText className="task-detail-panel__header-title">
            {t('toolCards.taskDetailPanel.untitled')}
          </OverflowText>} />
        </div>
        <div className="task-detail-panel__empty-content" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="empty">
          {t('toolCards.taskDetailPanel.noData')}
        </div>
      </div>
    );
  }

  const rc = taskInput?.isReviewCoverageTask ? null : taskInput?.reviewerContext;
  const agentName = isReviewCoverageTask
    ? t('toolCards.taskTool.reviewCoverageLabel')
    : t(resolveSubagentNameKey(subagentSessionId || `${sessionId ?? ''}:${parentTaskToolCallId || parentTaskToolId}`));
  const modelName = toolItem?.subagentModelDisplayName?.trim()
    || taskSnapshot.subagentModelName?.trim()
    || taskInput?.modelName?.trim()
    || toolItem?.subagentModelId?.trim();
  const stopLabel = stoppingSubagent
    ? t('toolCards.taskDetailPanel.stoppingSubagent')
    : taskInput?.isReviewCoverageTask
      ? t('toolCards.taskDetailPanel.stopReviewWork')
      : t('toolCards.taskDetailPanel.stopSubagent');

  return (
    <div data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="root" className="task-detail-panel">
      <div className="task-detail-panel__header" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="header">
        <Toolbar size="sm" leading={(
          <div className="task-detail-panel__header-main">
            <SubagentDelegationAvatar sessionId={subagentSessionId} name={agentName} pending={isRunning} size={24} motion={false} showStatus={false} />
            <OverflowText className="task-detail-panel__header-title">
              {agentName}
            </OverflowText>
            {modelName && <OverflowText className="task-detail-panel__header-model">{modelName}</OverflowText>}
          </div>
        )} trailing={(
          <div data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="actions">
            <ToolbarGroup>
              <ToolTimeoutIndicator
                startTime={toolItem?.startTime}
                isRunning={isRunning}
                timeoutMs={
                  typeof toolItem?.toolCall?.input?.timeout_seconds === 'number' && toolItem.toolCall.input.timeout_seconds > 0
                    ? toolItem.toolCall.input.timeout_seconds * 1000
                    : undefined
                }
                showControls={true}
                subagentSessionId={subagentSessionId}
                defaultTimeoutDisabled={defaultTimeoutDisabled}
                completedDurationMs={taskDurationMs}
                completedStatus={isFailed ? 'error' : status === 'cancelled' ? 'cancelled' : isCompleted ? 'success' : undefined}
                completedFailureReason={isFailed ? getErrorMessage() : undefined}
              />
              {canStopSubagent && <Tooltip content={`${stopLabel} · ${taskInput?.isReviewCoverageTask
                ? t('toolCards.taskDetailPanel.stopReviewWorkHint')
                : t('toolCards.taskDetailPanel.stopSubagentHint')}`}>
                <IconButton size="sm" tone="danger" icon={<Icon glyph={Square} size="sm" />}
                  aria-label={stopLabel} loading={stoppingSubagent} onClick={() => void handleStopSubagent()} />
              </Tooltip>}
            </ToolbarGroup>
          </div>
        )} />
      </div>

      {isFailed && (
        <div className="task-detail-panel__error-banner" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="errorBanner" data-openbitfun-state="error">
          <Icon glyph={AlertCircle} size="sm" className="task-detail-panel__error-banner-icon" />
          <span className="task-detail-panel__error-banner-text">{getErrorMessage()}</span>
        </div>
      )}

      <div
        ref={contentRef}
        className="task-detail-panel__content"
        data-openbitfun-product-component="task-detail-panel"
        data-openbitfun-product-part="content"
      >
        {rc ? (
          <Disclosure className="task-detail-panel__reviewer-section" contentInnerClassName="task-detail-panel__details-content" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="reviewer" summary={t('toolCards.taskDetailPanel.reviewerContextLabel')}>
            <div className="task-detail-panel__reviewer-context">
              <div className="task-detail-panel__reviewer-role" style={{ color: rc.accentColor }}>
                {tAgents(`reviewTeams.members.${rc.definitionKey}.role`, {
                  defaultValue: rc.roleName,
                })}
              </div>
              <div className="task-detail-panel__reviewer-desc">
                {tAgents(`reviewTeams.members.${rc.definitionKey}.description`, {
                  defaultValue: rc.description,
                })}
              </div>
              <ul className="task-detail-panel__reviewer-responsibilities">
                {rc.responsibilities.map((resp, idx) => (
                  <li key={idx}>
                    {tAgents(`reviewTeams.members.${rc.definitionKey}.responsibilities.${idx}`, {
                      defaultValue: resp,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          </Disclosure>
        ) : taskInput?.prompt && taskInput.prompt !== 'Not provided' && (
          <Disclosure className="task-detail-panel__prompt-section" contentInnerClassName="task-detail-panel__details-content" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="prompt" summary={t('toolCards.taskDetailPanel.promptLabel')}>
            <div className="task-detail-panel__prompt-content">{taskInput.prompt}</div>
          </Disclosure>
        )}

        {stopError && (
          <div className="task-detail-panel__error" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="error" data-openbitfun-state="error">
            <Icon glyph={AlertCircle} size="sm" />
            <span>{stopError}</span>
          </div>
        )}

        {subagentItems.length > 0 && (
          <div className="task-detail-panel__execution" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="execution">
            {subagentSessionId && (
              <SubagentProjectionView
                parentTaskToolId={toolItem.id}
                subagentSessionId={subagentSessionId}
                directSubagentDialogTurnId={taskSnapshot.subagentDialogTurnId}
                items={visibleSubagentItems}
                sessionId={subagentSessionId}
                compactText={false}
              />
            )}
          </div>
        )}

        {hasPendingSubagentRender && (
          <div className="task-detail-panel__loading task-detail-panel__loading--inline" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="loading" data-openbitfun-state="loading">
            <Spinner size="sm" />
            <span>
              {t('toolCards.taskDetailPanel.loadingMore')}
            </span>
          </div>
        )}

        {((isRunning || !isSnapshotHydrated) && subagentItems.length === 0) && (
          <div className="task-detail-panel__loading" data-openbitfun-product-component="task-detail-panel" data-openbitfun-product-part="loading" data-openbitfun-state="loading">
            <Spinner size="md" />
            <span>
              {isSnapshotHydrated
                ? t('toolCards.taskDetailPanel.status.running')
                : t('toolCards.taskDetailPanel.loading')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskDetailPanel;
