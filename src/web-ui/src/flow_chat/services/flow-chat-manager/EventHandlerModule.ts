/**
 * Event handling module
 * Initializes event listeners and handles various Agentic events
 */

import { projectUserQuestionTiming } from '../../utils/userQuestionTiming';
import { FlowChatStore, mergeModelRoundAttemptDiagnostics } from '../../store/FlowChatStore';
import { initializeAcpPlanState } from '../acpPlanState';
import { isSessionTurnRetired } from '../../store/sessionMutationStore';
import { stateMachineManager } from '../../state-machine';
import { SessionExecutionEvent, SessionExecutionState } from '../../state-machine/types';
import { agenticEventListener, type AgenticEventCallbacks } from '../AgenticEventListener';
import { 
  generateTextChunkKey,
  generateToolEventKey,
  normalizeParamsPartialFragment,
  parseEventKey,
  TEXT_CHUNK_MAX_LATENCY_MS,
  type FlowToolEvent,
  type SubagentParentInfo,
  type TextChunkEventData,
  type ToolEventData,
  type ParamsPartialToolEvent
} from '../EventBatcher';
import { notificationService } from '../../../shared/notification-system/services/NotificationService';
import { createLogger } from '@/shared/utils/logger';
import { handleThreadGoalUpdated } from '../threadGoalEventService';
import { resolveThreadGoalUserMessageDisplay } from '../../utils/threadGoalDisplay';
import { cleanRemoteUserInput } from '../../utils/userInputText';
import { getEffectiveToolName } from '../../utils/toolInvocationIdentity';
import { absoluteSessionTurnIndexForId } from '../../utils/flowChatTurnOrdinal';
import type {
  DeepReviewQueueStateChangedEvent,
  ImageAnalysisEvent,
  ModelRoundStartedEvent,
  ModelRoundCompletedEvent,
  ModelRoundAttemptSupersededEvent,
  OpenBuiltInBrowserEvent,
  AcpContextUsageUpdatedEvent,
  SessionModelFallbackAppliedEvent,
  SessionReasoningPresetAutoClearedEvent,
  SubagentSessionLinkedEvent,
  RecoverInterruptedDialogTurnResponse,
} from '@/infrastructure/api/service-api/AgentAPI';
import { MCPAPI } from '@/infrastructure/api/service-api/MCPAPI';
import { ACPClientAPI, type AcpPermissionRequestEvent } from '@/infrastructure/api/service-api/ACPClientAPI';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { FlowChatContext, DialogTurn, ModelRound, FlowToolItem } from './types';
import type { Session, SteeringImage } from '../../types/flow-chat';
import {
  normalizeAiErrorDetail,
  type AiErrorDetail,
} from '@/shared/ai-errors/aiErrorPresenter';
import { useReviewActionBarStore } from '../../store/deepReviewActionBarStore';
import { buildDeepReviewCapacityQueueStateFromEvent } from '../../utils/deepReviewQueueStateEvents';
import { useBackgroundCommandActivityStore } from '../../store/backgroundCommandActivityStore';
import { useBackgroundSubagentActivityStore } from '../../store/backgroundSubagentActivityStore';
import { createTab } from '@/shared/utils/tabUtils';
import type { TabCreationOptions } from '@/shared/utils/tabUtils';
import { interruptedTurnRecoveryGate } from '../interruptedTurnRecoveryGate';
import {
  clearHistorySessionOpenTransition,
  clearRecentHistorySessionOpenIntent,
} from '../sessionOpenIntent';

import { 
  debouncedSaveDialogTurn, 
  immediateSaveDialogTurn, 
  saveDialogTurnToDisk,
  cleanupSaveState,
} from './PersistenceModule';
import { 
  processNormalTextChunkInternal, 
  processThinkingChunkInternal,
  completeActiveTextItems,
  cleanupSessionBuffers
} from './TextChunkModule';
import { 
  processToolEvent,
  processToolParamsPartialInternal,
  processToolProgressInternal,
  handleToolExecutionProgress,
  handleToolTerminalReady,
} from './ToolEventModule';
import { handleAcpPermissionRequestForToolCard } from './AcpPermissionToolCardModule';
import {
  clearRuntimeStatus,
  scheduleModelResponseStatus,
} from './RuntimeStatusModule';
import { requestRuntimeProjectionRepair } from './PeerSessionRefreshModule';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import {
  optimisticTurnAdoptionKey,
  sessionPendingTurnAdoptionKey,
  stripOptimisticTurnAdoption,
} from '../../utils/optimisticTurnAdoption';
import { isAcpFlowSession } from '../../utils/acpSession';

const pendingImageAnalysisTurns = new Map<string, string>();

/** Apply host timing separately from model arguments and tolerate event batching. */
export function handleUserQuestionWaiting(context: FlowChatContext, event: {
  session_id: string;
  tool_id: string;
  questions: { responseDeadlineMs?: number | null; responseHostNowMs?: number };
}): void {
  if (!event || typeof event.session_id !== 'string' || typeof event.tool_id !== 'string') return;
  context.eventBatcher.flushNow();
  const session = context.flowChatStore.getState().sessions.get(event.session_id);
  for (const turn of session?.dialogTurns ?? []) {
    for (const round of turn.modelRounds) {
      const tool = round.items.find(item => item.type === 'tool'
        && (item.id === event.tool_id || (item as FlowToolItem).toolCall?.id === event.tool_id)) as FlowToolItem | undefined;
      if (!tool) continue;
      if (['completed', 'error', 'cancelled', 'rejected'].includes(tool.status)
        || tool.userQuestionWait) return;
      const updates: Partial<FlowToolItem> = {
        userQuestionWait: projectUserQuestionTiming(event.questions),
      };
      context.flowChatStore.updateModelRoundItem(event.session_id, turn.id, tool.id, updates);
      return;
    }
  }
  // Restore the authoritative mailbox if the tool/turn has not arrived yet.
  requestRuntimeProjectionRepair(event.session_id);
}
const log = createLogger('EventHandlerModule');
const TURN_COMPLETION_QUIET_WINDOW_MS = 500;

interface MCPInteractionRequestEvent {
  interactionId: string;
  serverId: string;
  serverName: string;
  method: string;
  params?: unknown;
}

function isStreamingExecutionState(state: SessionExecutionState): boolean {
  return state === SessionExecutionState.PROCESSING || state === SessionExecutionState.FINISHING;
}

const RECOVERABLE_IDLE_TURN_STATUSES = new Set<DialogTurn['status']>([
  'pending',
  'image_analyzing',
  'processing',
  'finishing',
]);

export function isAppWindowFocused(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }

  return document.visibilityState === 'visible' && document.hasFocus();
}

function resolveDialogTurnDisplayContent(
  userInput: unknown,
  originalUserInput: unknown,
  userMessageMetadata: unknown,
): string {
  const cleanedUserInput = cleanRemoteUserInput(typeof userInput === 'string' ? userInput : '');
  const cleanedOriginalUserInput = cleanRemoteUserInput(
    typeof originalUserInput === 'string' ? originalUserInput : ''
  );

  const base = cleanedOriginalUserInput || cleanedUserInput;
  const metadata =
    userMessageMetadata && typeof userMessageMetadata === 'object'
      ? (userMessageMetadata as Record<string, unknown>)
      : null;

  return resolveThreadGoalUserMessageDisplay(base, metadata);
}

function mergeParamsPartialEventData(
  existing: ToolEventData,
  incoming: ToolEventData,
): ToolEventData {
  const existingToolEvent = existing.toolEvent as ParamsPartialToolEvent;
  const incomingToolEvent = incoming.toolEvent as ParamsPartialToolEvent;
  const existingParams = normalizeParamsPartialFragment(existingToolEvent.params);
  const incomingParams = normalizeParamsPartialFragment(incomingToolEvent.params);

  return {
    ...existing,
    ...incoming,
    toolEvent: {
      ...existingToolEvent,
      ...incomingToolEvent,
      params: existingParams + incomingParams,
    },
  };
}

export const __test_only__ = {
  resolveDialogTurnDisplayContent,
  mergeParamsPartialEventData,
  findSubagentParentInfoByRound,
  handleDialogTurnStarted,
  handleDialogTurnFailed,
  handleSubagentSessionLinked,
  handleModelRoundStart,
  handleTokenUsageUpdate,
  handleCompressionCompleted,
  handleDialogTurnInterrupted,
  handleDialogTurnRecovered,
  handleDialogTurnCancelled,
  buildBuiltInBrowserTabOptions,
};

function eventOwnsLatestSessionTurn(
  session: Session,
  sessionId: string,
  turnId: string,
): boolean {
  if (session.dialogTurns.at(-1)?.id !== turnId) return false;
  const machine = stateMachineManager.get(sessionId);
  const currentTurnId = machine?.getContext().currentDialogTurnId;
  return !currentTurnId || currentTurnId === turnId;
}

function logDroppedDataEvent(
  eventName: string,
  sessionId: string,
  turnId: string | null,
  details: Record<string, unknown>
): void {
  requestRuntimeProjectionRepair(sessionId);
  log.debug('Dropped agentic data event', {
    eventName,
    sessionId,
    turnId,
    ...details,
  });
}

function recoverIdleLatestTurnDataEvent(
  eventName: string,
  sessionId: string,
  turnId: string | null,
  currentState: SessionExecutionState,
  currentDialogTurnId: string | null
): boolean {
  if (
    currentState !== SessionExecutionState.IDLE ||
    !turnId ||
    currentDialogTurnId
  ) {
    return false;
  }

  const session = FlowChatStore.getInstance().getState().sessions.get(sessionId);
  const latestTurn = session?.dialogTurns[session.dialogTurns.length - 1];
  if (
    !latestTurn ||
    latestTurn.id !== turnId ||
    !RECOVERABLE_IDLE_TURN_STATUSES.has(latestTurn.status)
  ) {
    return false;
  }

  const machine = stateMachineManager.get(sessionId);
  const machineContext = machine?.getContext();
  if (machineContext) {
    machineContext.currentDialogTurnId = turnId;
  }

  void stateMachineManager
    .transition(sessionId, SessionExecutionEvent.START, {
      taskId: sessionId,
      dialogTurnId: turnId,
    })
    .catch(error => {
      log.error('State machine transition failed while recovering active data event', {
        sessionId,
        turnId,
        eventName,
        error,
      });
    });

  log.debug('Recovered active data event after idle state', {
    sessionId,
    turnId,
    eventName,
  });
  return true;
}

function isRecoveringIdleTurn(
  sessionId: string,
  turnId: string | null,
  currentState: SessionExecutionState,
  currentDialogTurnId: string | null,
): boolean {
  if (
    currentState !== SessionExecutionState.IDLE ||
    !turnId ||
    currentDialogTurnId !== turnId
  ) {
    return false;
  }

  const session = FlowChatStore.getInstance().getState().sessions.get(sessionId);
  const latestTurn = session?.dialogTurns[session.dialogTurns.length - 1];
  return Boolean(
    latestTurn &&
    latestTurn.id === turnId &&
    RECOVERABLE_IDLE_TURN_STATUSES.has(latestTurn.status)
  );
}

function handleDeepReviewQueueStateChanged(event: DeepReviewQueueStateChangedEvent): void {
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(event.sessionId);
  const queueState = buildDeepReviewCapacityQueueStateFromEvent(event, session);
  if (!queueState) {
    return;
  }

  const actionBar = useReviewActionBarStore.getState();
  const existingActionState = actionBar.getSessionState(event.sessionId);
  if (existingActionState) {
    actionBar.applyCapacityQueueState(queueState, event.sessionId);
    const nextActionBar = useReviewActionBarStore.getState();
    const nextActionState = nextActionBar.getSessionState(event.sessionId);
    if (
      queueState.status !== 'running' &&
      queueState.status !== 'capacity_skipped' &&
      (nextActionState?.phase === 'idle' || nextActionState?.phase === 'review_running')
    ) {
      actionBar.updatePhase('review_waiting_capacity', undefined, event.sessionId);
    }
    return;
  }

  if (queueState.status === 'running' || queueState.status === 'capacity_skipped') {
    return;
  }

  actionBar.showCapacityQueueBar({
    childSessionId: event.sessionId,
    parentSessionId: session?.parentSessionId ?? null,
    capacityQueueState: queueState,
  });
}

function attachSubagentSessionToParentTool(
  parentInfo: SubagentParentInfo,
  subagentSessionId: string,
  subagentDialogTurnId?: string,
): void {
  const store = FlowChatStore.getInstance();
  const parentSession = store.getState().sessions.get(parentInfo.sessionId);
  if (!parentSession) {
    return;
  }

  const parentTurn = parentSession.dialogTurns.find((turn) => turn.id === parentInfo.dialogTurnId);
  if (!parentTurn) {
    return;
  }

  const parentTool = store.findToolItem(
    parentInfo.sessionId,
    parentInfo.dialogTurnId,
    parentInfo.toolCallId,
  );
  const parentTaskTool = parentTool?.type === 'tool' ? parentTool as FlowToolItem : null;

  if (
    parentTaskTool?.subagentSessionId === subagentSessionId &&
    (!subagentDialogTurnId || parentTaskTool.subagentDialogTurnId === subagentDialogTurnId)
  ) {
    return;
  }

  store.updateModelRoundItem(
    parentInfo.sessionId,
    parentInfo.dialogTurnId,
    parentInfo.toolCallId,
    {
      subagentSessionId,
      ...(subagentDialogTurnId ? { subagentDialogTurnId } : {}),
    } as any,
  );
}

function readTaskInputString(
  value: unknown,
  ...keys: string[]
): string {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function getParentTaskTool(parentInfo: SubagentParentInfo): FlowToolItem | null {
  const store = FlowChatStore.getInstance();
  const item = store.findToolItem(
    parentInfo.sessionId,
    parentInfo.dialogTurnId,
    parentInfo.toolCallId,
  );
  return item?.type === 'tool' ? item as FlowToolItem : null;
}

function isBackgroundSubagent(parentInfo: SubagentParentInfo): boolean {
  const parentTool = getParentTaskTool(parentInfo);
  if (!parentTool) {
    return false;
  }

  const inputValue = parentTool.toolCall?.input;
  if (inputValue && typeof inputValue === 'object') {
    const runInBackground = (inputValue as Record<string, unknown>).run_in_background;
    if (typeof runInBackground === 'boolean') {
      return runInBackground;
    }
  }

  const resultValue = parentTool.toolResult?.result;
  if (resultValue && typeof resultValue === 'object') {
    const runInBackground = (resultValue as Record<string, unknown>).run_in_background;
    if (typeof runInBackground === 'boolean') {
      return runInBackground;
    }
  }

  return false;
}

function resolveSubagentType(
  parentInfo: SubagentParentInfo,
  explicitSubagentType?: string,
): string | undefined {
  const normalizedExplicitType = explicitSubagentType?.trim();
  if (normalizedExplicitType) {
    return normalizedExplicitType;
  }

  const parentTool = getParentTaskTool(parentInfo);
  const input = parentTool?.toolCall?.input;
  const inferredType = readTaskInputString(
    input,
    'subagent_type',
    'subagentType',
    'agent_type',
    'agentType',
  );
  return inferredType || undefined;
}

function buildSubagentSessionTitleWithType(
  parentInfo: SubagentParentInfo,
  explicitSubagentType?: string,
): string {
  const parentTool = getParentTaskTool(parentInfo);
  const input = parentTool?.toolCall?.input;
  const subagentType = resolveSubagentType(parentInfo, explicitSubagentType);
  const description = readTaskInputString(input, 'description');
  const fallback = subagentType || 'Subagent';
  const rawTitle = description ? `${fallback}: ${description}` : fallback;
  return rawTitle.length > 72 ? `${rawTitle.slice(0, 69)}...` : rawTitle;
}

function ensureSubagentSession(
  context: FlowChatContext,
  parentInfo: SubagentParentInfo,
  subagentSessionId: string,
  event?: Record<string, unknown>,
  explicitSubagentType?: string,
  focusedReviewDisplayLabel?: SubagentSessionLinkedEvent['focusedReviewDisplayLabel'],
): void {
  const store = FlowChatStore.getInstance();
  const existing = store.getState().sessions.get(subagentSessionId);
  const subagentType = resolveSubagentType(parentInfo, explicitSubagentType);
  if (existing) {
    if (
      existing.sessionKind !== 'subagent' ||
      existing.parentSessionId !== parentInfo.sessionId ||
      existing.parentToolCallId !== parentInfo.toolCallId ||
      existing.subagentType !== (subagentType || existing.subagentType)
    ) {
      store.updateSessionRelationship(subagentSessionId, {
        parentSessionId: parentInfo.sessionId,
        sessionKind: 'subagent',
        parentToolCallId: parentInfo.toolCallId,
        subagentType: subagentType || undefined,
      });
    }
    store.updateSessionFocusedReviewDisplayLabel(subagentSessionId, focusedReviewDisplayLabel);
    return;
  }

  const parentSession = store.getState().sessions.get(parentInfo.sessionId);
  const parentTurnIndex = parentSession
    ? absoluteSessionTurnIndexForId(parentSession, parentInfo.dialogTurnId)
    : undefined;
  store.addExternalSession(
    subagentSessionId,
    buildSubagentSessionTitleWithType(parentInfo, explicitSubagentType),
    subagentType || parentSession?.mode || 'Standard',
    parentSession?.workspacePath || resolveExternalSessionWorkspacePath(context, event),
    {
      parentSessionId: parentInfo.sessionId,
      sessionKind: 'subagent',
      parentToolCallId: parentInfo.toolCallId,
      subagentType: subagentType || undefined,
      btwOrigin: {
        parentSessionId: parentInfo.sessionId,
        parentDialogTurnId: parentInfo.dialogTurnId,
        parentTurnIndex,
      },
      focusedReviewDisplayLabel,
      projectWorkspacePath:
        parentSession?.projectWorkspacePath
        || parentSession?.config.projectWorkspacePath
        || parentSession?.workspacePath,
      executionTarget: parentSession?.config.executionTarget,
      workspaceId: parentSession?.workspaceId,
    },
    parentSession?.remoteConnectionId || extractEventRemoteConnectionId(event),
    parentSession?.remoteSshHost || extractEventRemoteSshHost(event),
  );
}

function reconcileBackgroundSubagentSession(subagentSessionId?: string | null): void {
  if (!subagentSessionId) {
    return;
  }

  const flowState = FlowChatStore.getInstance().getState();
  useBackgroundSubagentActivityStore
    .getState()
    .reconcileSession(flowState, subagentSessionId);
}

function reconcileBackgroundSubagentFromParentTool(
  parentSessionId: string,
  parentDialogTurnId: string,
  parentToolCallId: string,
): void {
  const store = FlowChatStore.getInstance();
  const parentTool = store.findToolItem(parentSessionId, parentDialogTurnId, parentToolCallId);
  if (parentTool?.type !== 'tool') {
    return;
  }

  const subagentSessionId = (parentTool as FlowToolItem).subagentSessionId;
  if (typeof subagentSessionId !== 'string' || !subagentSessionId.trim()) {
    return;
  }

  reconcileBackgroundSubagentSession(subagentSessionId);
}

function handleSubagentSessionLinked(
  context: FlowChatContext,
  event: SubagentSessionLinkedEvent,
): void {
  const childSessionId = event?.sessionId ?? (event as any)?.childSessionId;
  const parentSessionId = event?.parentSessionId ?? (event as any)?.parent_session_id;
  const parentDialogTurnId =
    event?.parentDialogTurnId ?? (event as any)?.parent_dialog_turn_id;
  const parentToolCallId = event?.parentToolCallId ?? (event as any)?.parent_tool_call_id;
  const subagentDialogTurnId =
    event?.subagentDialogTurnId ?? (event as any)?.subagent_dialog_turn_id;
  const agentType = event?.agentType ?? (event as any)?.agent_type;
  const modelId = event?.modelId ?? (event as any)?.model_id;
  const rawFocusedReviewDisplayLabel = event?.focusedReviewDisplayLabel
    ?? (event as any)?.focused_review_display_label;
  const focusedReviewDisplayLabel = typeof rawFocusedReviewDisplayLabel === 'string'
    ? rawFocusedReviewDisplayLabel
    : undefined;

  if (!childSessionId || !parentSessionId || !parentDialogTurnId || !parentToolCallId) {
    log.warn('SubagentSessionLinked missing required fields', { event });
    return;
  }

  const parentInfo: SubagentParentInfo = {
    sessionId: parentSessionId,
    dialogTurnId: parentDialogTurnId,
    toolCallId: parentToolCallId,
  };

  attachSubagentSessionToParentTool(parentInfo, childSessionId, subagentDialogTurnId);
  ensureSubagentSession(
    context,
    parentInfo,
    childSessionId,
    event as Record<string, unknown>,
    agentType,
    focusedReviewDisplayLabel,
  );
  if (typeof modelId === 'string' && modelId.trim()) {
    FlowChatStore.getInstance().updateSessionModelName(childSessionId, modelId.trim());
  }
  reconcileBackgroundSubagentSession(childSessionId);
}

function getLinkedSubagentParentInfo(sessionId: string): SubagentParentInfo | undefined {
  const session = FlowChatStore.getInstance().getState().sessions.get(sessionId);
  if (
    !session ||
    session.sessionKind !== 'subagent' ||
    !session.parentSessionId ||
    !session.parentToolCallId
  ) {
    return undefined;
  }

  const parentTurnId = session.btwOrigin?.parentDialogTurnId;
  if (!parentTurnId) {
    return undefined;
  }

  return {
    sessionId: session.parentSessionId,
    dialogTurnId: parentTurnId,
    toolCallId: session.parentToolCallId,
  };
}

function findSubagentParentInfoByRound(
  subagentSessionId: string,
  subagentDialogTurnId: string,
): SubagentParentInfo | undefined {
  const state = FlowChatStore.getInstance().getState();

  for (const session of state.sessions.values()) {
    for (const turn of session.dialogTurns) {
      for (const round of turn.modelRounds) {
        for (const item of round.items) {
          if (item.type !== 'tool') {
            continue;
          }

          const toolItem = item as FlowToolItem;
          if (
            getEffectiveToolName(toolItem).toLowerCase() === 'task' &&
            toolItem.subagentSessionId === subagentSessionId &&
            toolItem.subagentDialogTurnId === subagentDialogTurnId
          ) {
            return {
              sessionId: session.sessionId,
              dialogTurnId: turn.id,
              toolCallId: toolItem.toolCall?.id || toolItem.id,
            };
          }
        }
      }
    }
  }

  return undefined;
}

function updateSubagentParentTaskModel(
  context: FlowChatContext,
  parentInfo: SubagentParentInfo,
  modelConfigId: string | undefined,
  effectiveModelName: string,
): void {
  const store = FlowChatStore.getInstance();
  store.updateModelRoundItem(
    parentInfo.sessionId,
    parentInfo.dialogTurnId,
    parentInfo.toolCallId,
    {
      subagentModelId: modelConfigId,
      subagentModelDisplayName: effectiveModelName,
    } as Partial<FlowToolItem>,
  );
  debouncedSaveDialogTurn(context, parentInfo.sessionId, parentInfo.dialogTurnId, 800);
}

/**
 * Event filtering mechanism: determines if an event should be processed
 */
export function shouldProcessEvent(
  sessionId: string,
  turnId: string | null,
  eventType: 'data' | 'control' | 'state_sync',
  eventName = 'unknown'
): boolean {
  if (turnId && isSessionTurnRetired(sessionId, turnId)) {
    if (eventType === 'data') {
      logDroppedDataEvent(eventName, sessionId, turnId, { reason: 'retired_turn' });
    }
    return false;
  }

  if (eventType === 'state_sync') {
    return true;
  }

  const machine = stateMachineManager.get(sessionId);
  if (!machine) {
    if (eventType === 'data') {
      logDroppedDataEvent(eventName, sessionId, turnId, { reason: 'missing_state_machine' });
    }
    return false;
  }

  const currentState = machine.getCurrentState();
  const context = machine.getContext();

  if (eventType === 'control') {
    if (currentState === SessionExecutionState.IDLE || currentState === SessionExecutionState.ERROR) {
      return true;
    }
    return false;
  }

  if (!isStreamingExecutionState(currentState)) {
    if (recoverIdleLatestTurnDataEvent(
      eventName,
      sessionId,
      turnId,
      currentState,
      context.currentDialogTurnId,
    )) {
      return true;
    }

    if (isRecoveringIdleTurn(sessionId, turnId, currentState, context.currentDialogTurnId)) {
      return true;
    }

    logDroppedDataEvent(eventName, sessionId, turnId, {
      reason: 'state_not_accepting_data',
      currentState,
      currentDialogTurnId: context.currentDialogTurnId,
    });
    return false;
  }

  if (turnId && context.currentDialogTurnId !== turnId) {
    logDroppedDataEvent(eventName, sessionId, turnId, {
      reason: 'turn_id_mismatch',
      sessionId,
      currentState,
      currentDialogTurnId: context.currentDialogTurnId,
    });
    return false;
  }

  return true;
}

/**
 * Map backend state to frontend state
 */
export function mapBackendStateToFrontend(backendState: any): SessionExecutionState {
  if (typeof backendState === 'object' && backendState !== null) {
    if ('Idle' in backendState) {
      return SessionExecutionState.IDLE;
    }
    if ('Processing' in backendState) {
      return SessionExecutionState.PROCESSING;
    }
    if ('Error' in backendState) {
      return SessionExecutionState.ERROR;
    }
  }
  
  if (typeof backendState === 'string') {
    switch (backendState) {
      case 'Idle':
      case 'Completed':
      case 'Cancelled':
        return SessionExecutionState.IDLE;
        
      case 'Processing':
      case 'WaitingForToolResponse':
      case 'Paused':
        return SessionExecutionState.PROCESSING;
        
      case 'Error':
        return SessionExecutionState.ERROR;
        
      default:
        log.warn('Unknown backend state', { backendState });
        return SessionExecutionState.IDLE;
    }
  }
  
  log.warn('Unable to parse backend state', { backendState });
  return SessionExecutionState.IDLE;
}

/**
 * Initialize global event listeners
 * Returns a cleanup function that removes all registered listeners
 */
export async function initializeEventListeners(
  context: FlowChatContext,
  onTodoWriteResult: (sessionId: string, turnId: string, result: any) => void
): Promise<() => void> {
  const { api } = await import('@/infrastructure/api/service-api/ApiClient');
  const unlistenUserQuestion = api.listen('backend-event-toolawaitinguserinput', (payload: any) => {
    handleUserQuestionWaiting(context, payload?.value ?? payload);
  });
  const unlistenProgress = api.listen('backend-event-toolexecutionprogress', (payload: any) => {
    handleToolExecutionProgress(payload);
  });
  const unlistenTerminalReady = api.listen('backend-event-toolterminalready', (payload: any) => {
    const eventData = (payload as any)?.value || payload;
    handleToolTerminalReady(eventData);
  });
  const unlistenBackgroundCommandLifecycle = api.listen('backend-event-backgroundcommandlifecycle', (payload: any) => {
    const eventData = (payload as any)?.value || payload;
    useBackgroundCommandActivityStore.getState().applyLifecycleEvent(eventData);
  });
  const unlistenMcpInteractionRequest = api.listen('backend-event-mcpinteractionrequest', (payload: any) => {
    void handleMcpInteractionRequest((payload as any)?.value || payload);
  });
  const unlistenAcpPermissionRequest = api.listen('backend-event-acppermissionrequest', (payload: any) => {
    void handleAcpPermissionRequest((payload as any)?.value || payload);
  });

  const callbacks: AgenticEventCallbacks = {
    onSessionCreated: (event) => {
      handleSessionCreated(context, event);
    },
    onSessionDeleted: (event) => {
      handleSessionDeleted(context, event);
    },
    onSessionStateChanged: (event) => {
      handleSessionStateChanged(context, event);
    },
    onSessionHistoryChanged: (event) => {
      handleSessionHistoryChanged(context, event);
    },
    onImageAnalysisStarted: (event) => {
      handleImageAnalysisStarted(context, event as ImageAnalysisEvent);
    },
    onImageAnalysisCompleted: (event) => {
      handleImageAnalysisCompleted(context, event as ImageAnalysisEvent);
    },
    onDialogTurnStarted: (event) => {
      handleDialogTurnStarted(context, event);
    },
    onTextChunk: (event) => {
      handleTextChunk(context, event);
    },
    onToolEvent: (event) => {
      handleToolEvent(context, event, onTodoWriteResult);
    },
    onSubagentSessionLinked: (event) => {
      handleSubagentSessionLinked(context, event);
    },
    onDeepReviewQueueStateChanged: (event) => {
      handleDeepReviewQueueStateChanged(event);
    },
    onModelRoundStarted: (event) => {
      handleModelRoundStart(context, event);
    },
    onModelRoundCompleted: (event) => {
      handleModelRoundComplete(context, event);
    },
    onModelRoundAttemptSuperseded: (event) => {
      handleModelRoundAttemptSuperseded(context, event);
    },
    onDialogTurnCompleted: (event) => {
      handleDialogTurnComplete(context, event, onTodoWriteResult);
    },
    onDialogTurnFailed: (event) => {
      handleDialogTurnFailed(context, event);
    },
    onDialogTurnCancelled: (event) => {
      handleDialogTurnCancelled(context, event, onTodoWriteResult);
    },
    onDialogTurnInterrupted: (event) => {
      handleDialogTurnInterrupted(context, event);
    },
    onDialogTurnRecovered: (event) => {
      handleDialogTurnRecovered(context, event);
    },
    onTokenUsageUpdated: (event) => {
      handleTokenUsageUpdate(context, event);
    },
    onAcpContextUsageUpdated: (event) => {
      handleAcpContextUsageUpdate(event);
    },
    onContextCompressionStarted: (event) => {
      handleCompressionStarted(context, event);
    },
    onContextCompressionCompleted: (event) => {
      handleCompressionCompleted(context, event);
    },
    onContextCompressionFailed: (event) => {
      handleCompressionFailed(context, event);
    },
    onThreadGoalUpdated: (event) => {
      handleThreadGoalUpdatedEvent(event);
    },
    onOpenBuiltInBrowser: (event) => {
      handleOpenBuiltInBrowser(event);
    },
    onSessionTitleGenerated: (event) => {
      handleSessionTitleGenerated(event);
    },
    onSessionModelFallbackApplied: (event) => {
      handleSessionModelFallbackApplied(event);
    },
    onSessionReasoningPresetAutoCleared: (event) => {
      handleSessionReasoningPresetAutoCleared(event);
    },
    onUserSteeringInjected: (event) => {
      handleUserSteeringInjected(context, event);
    }
  };

  await agenticEventListener.startListening(callbacks);
  const cleanupAcpPlanState = initializeAcpPlanState();

  return () => {
    unlistenProgress();
    unlistenUserQuestion();
    unlistenTerminalReady();
    unlistenBackgroundCommandLifecycle();
    unlistenMcpInteractionRequest();
    unlistenAcpPermissionRequest();
    cleanupAcpPlanState();
    agenticEventListener.stopListening();
  };
}

async function handleMcpInteractionRequest(rawEvent: unknown): Promise<void> {
  const event = rawEvent as MCPInteractionRequestEvent | undefined;
  const interactionId = event?.interactionId;
  const method = event?.method;

  if (!interactionId || !method) {
    log.warn('Received invalid MCP interaction request event', { rawEvent });
    return;
  }

  const emitted = globalEventBus.emit('mcp:interaction:request', event);
  if (!emitted) {
    log.warn('No MCP interaction UI handler registered, rejecting request', {
      interactionId,
      method,
    });
    try {
      await MCPAPI.submitMCPInteractionResponse({
        interactionId,
        approve: false,
        error: {
          message: 'No MCP interaction UI handler registered',
        },
      });
    } catch (submitError) {
      log.error('Failed to submit MCP interaction auto-rejection', {
        interactionId,
        method,
        submitError,
      });
      notificationService.error(`MCP interaction failed: ${method}`);
    }
  }
}

async function handleAcpPermissionRequest(rawEvent: unknown): Promise<void> {
  const event = rawEvent as AcpPermissionRequestEvent | undefined;
  const permissionId = event?.permissionId;
  if (!permissionId) {
    log.warn('Received invalid ACP permission request event', { rawEvent });
    return;
  }

  if (handleAcpPermissionRequestForToolCard(event)) return;

  log.warn('ACP permission request cannot be matched to a tool card, rejecting request', { permissionId });
  try {
    await ACPClientAPI.submitPermissionResponse({
      permissionId,
      approve: false,
    });
  } catch (error) {
    log.error('Failed to submit ACP permission auto-rejection', { permissionId, error });
    notificationService.error('Failed to respond to ACP permission request');
  }
}

/**
 * Handle session created event (e.g. remote mobile created a session)
 */
function handleSessionCreated(context: FlowChatContext, event: any): void {
  const { sessionId, sessionName, agentType } = event;

  const store = FlowChatStore.getInstance();
  const existing = store.getState().sessions.get(sessionId);
  const workspacePath = resolveExternalSessionWorkspacePath(context, event);
  const projectWorkspacePath =
    (typeof event.projectWorkspacePath === 'string' && event.projectWorkspacePath)
    || (typeof event.project_workspace_path === 'string' && event.project_workspace_path)
    || workspacePath;
  const executionTarget =
    event.executionTarget && typeof event.executionTarget === 'object'
      ? event.executionTarget
      : event.execution_target && typeof event.execution_target === 'object'
        ? event.execution_target
        : undefined;
  const workspaceId =
    (typeof event.workspaceId === 'string' && event.workspaceId)
    || (typeof event.workspace_id === 'string' && event.workspace_id)
    || undefined;
  const remoteConnectionId = extractEventRemoteConnectionId(event);
  const remoteSshHost = extractEventRemoteSshHost(event);

  if (existing) return;

  store.addExternalSession(
    sessionId,
    sessionName || 'Remote Session',
    agentType || 'Standard',
    workspacePath,
    {
      projectWorkspacePath,
      executionTarget,
      workspaceId,
    },
    remoteConnectionId,
    remoteSshHost
  );
}

function resolveExternalSessionWorkspacePath(
  context: FlowChatContext,
  event?: Record<string, unknown> | null,
): string | undefined {
  const candidate =
    (typeof event?.workspacePath === 'string' && event.workspacePath) ||
    (typeof event?.workspace_path === 'string' && event.workspace_path) ||
    context.currentWorkspacePath ||
    undefined;

  return candidate || undefined;
}

function extractEventRemoteConnectionId(event?: Record<string, unknown> | null): string | undefined {
  if (!event) return undefined;
  const id =
    (typeof event.remoteConnectionId === 'string' && event.remoteConnectionId) ||
    (typeof event.remote_connection_id === 'string' && event.remote_connection_id) ||
    undefined;
  return id?.trim() || undefined;
}

function extractEventRemoteSshHost(event?: Record<string, unknown> | null): string | undefined {
  if (!event) return undefined;
  const h =
    (typeof event.remoteSshHost === 'string' && event.remoteSshHost) ||
    (typeof event.remote_ssh_host === 'string' && event.remote_ssh_host) ||
    undefined;
  return h?.trim() || undefined;
}

function clearPendingTurnCompletion(
  context: FlowChatContext,
  sessionId: string,
  turnId?: string
): void {
  const pending = context.pendingTurnCompletions.get(sessionId);
  if (!pending) {
    return;
  }

  if (turnId && pending.turnId !== turnId) {
    return;
  }

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  context.pendingTurnCompletions.delete(sessionId);
}

function touchPendingTurnCompletion(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): void {
  const pending = context.pendingTurnCompletions.get(sessionId);
  if (!pending || pending.turnId !== turnId) {
    return;
  }

  pending.lastActivityAt = Date.now();
  schedulePendingTurnCompletion(context, sessionId, turnId);
}

function schedulePendingTurnCompletion(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): void {
  const pending = context.pendingTurnCompletions.get(sessionId);
  if (!pending || pending.turnId !== turnId) {
    return;
  }

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    finalizePendingTurnCompletion(context, sessionId, turnId);
  }, TURN_COMPLETION_QUIET_WINDOW_MS);
}

function beginTurnCompletion(context: FlowChatContext, sessionId: string, turnId: string, partialRecoveryReason?: string): void {
  clearPendingTurnCompletion(context, sessionId);

  context.pendingTurnCompletions.set(sessionId, {
    turnId,
    lastActivityAt: Date.now(),
    timer: null,
    partialRecoveryReason,
  });

  schedulePendingTurnCompletion(context, sessionId, turnId);
}

function flushPendingBatchedEvents(context: FlowChatContext): void {
  if (context.eventBatcher.getBufferSize() > 0) {
    context.eventBatcher.flushNow();
  }
}

function finalizeTurnCompletionState(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): void {
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);

  if (!session) {
    clearPendingTurnCompletion(context, sessionId, turnId);
    return;
  }
  const runtimeOwnsTurnPersistence = Boolean(
    session.dialogTurns.find(turn => turn.id === turnId)?.recovery,
  );
  const shouldReconcileRuntimeTurn = !isAcpFlowSession(session);

  completeActiveTextItems(context, sessionId, turnId);
  clearRuntimeStatus(context, sessionId, turnId);

  const sessionContentBuffer = context.contentBuffers.get(sessionId);
  if (sessionContentBuffer) {
    sessionContentBuffer.clear();
  }

  context.flowChatStore.markSessionFinished(sessionId);

  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => {
    const completedAt = Date.now();
    const updatedModelRounds = turn.modelRounds.map((round) => {
      if (round.isStreaming) {
        return {
          ...round,
          isStreaming: false,
          isComplete: true,
          status: 'completed' as const,
          endTime: round.endTime ?? completedAt
        };
      }
      return round;
    });

    return {
      ...turn,
      modelRounds: updatedModelRounds,
      status: 'completed' as const,
      endTime: turn.endTime ?? completedAt,
      recoveryEpoch: turn.recovery?.executionGeneration ?? turn.recoveryEpoch,
      recovery: undefined,
    };
  });
  reconcileBackgroundSubagentSession(sessionId);

  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (isStreamingExecutionState(currentState)) {
    stateMachineManager.transition(sessionId, SessionExecutionEvent.FINISHING_SETTLED);
  } else {
    log.debug('Skipping FINISHING_SETTLED transition', { currentState, sessionId, turnId });
  }

  if (!runtimeOwnsTurnPersistence) {
    saveDialogTurnToDisk(context, sessionId, turnId).catch(error => {
      log.warn('Failed to save dialog turn (non-critical)', { sessionId, turnId, error });
    });
  }
  // Reconcile from the host tail only once the durable history fence for this
  // session has been observed. Reading before the fence races the Runtime's
  // persistence commit and can only return a pre-terminal record; when the
  // fence arrives after this finalizer, `handleSessionHistoryChanged` performs
  // the (single) reconcile instead.
  if (shouldReconcileRuntimeTurn && context.pendingHistoryFenceSessions.delete(sessionId)) {
    void context.flowChatStore
      .reconcileSettledDialogTurn(sessionId, turnId)
      .then(applied => {
        if (applied) {
          reconcileBackgroundSubagentSession(sessionId);
        }
      })
      .catch(error => {
        log.warn('Failed to reconcile settled dialog turn', { sessionId, turnId, error });
      });
  }

  context.userCancelledSessionIds.delete(sessionId);

  const pending = context.pendingTurnCompletions.get(sessionId);
  const isPartialRecovery = !!pending?.partialRecoveryReason;
  // Selection/focus cannot prove that the result is visible. The transcript
  // acknowledges this specific completion after it has actually been shown.
  context.flowChatStore.markSessionUnreadCompletion(sessionId, isPartialRecovery ? 'interrupted' : 'completed', turnId);

  clearPendingTurnCompletion(context, sessionId, turnId);
}

function finalizePendingTurnCompletion(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): void {
  const pending = context.pendingTurnCompletions.get(sessionId);
  if (!pending || pending.turnId !== turnId) {
    return;
  }

  const elapsed = Date.now() - pending.lastActivityAt;
  if (elapsed < TURN_COMPLETION_QUIET_WINDOW_MS) {
    schedulePendingTurnCompletion(context, sessionId, turnId);
    return;
  }

  flushPendingBatchedEvents(context);
  finalizeTurnCompletionState(context, sessionId, turnId);
}

function finalizePendingTurnCompletionNow(context: FlowChatContext, sessionId: string): void {
  const pending = context.pendingTurnCompletions.get(sessionId);
  if (!pending) {
    return;
  }

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  flushPendingBatchedEvents(context);
  finalizeTurnCompletionState(context, sessionId, pending.turnId);
}

function findFinishingTurnForBackendIdle(
  context: FlowChatContext,
  sessionId: string,
  turnId?: string | null
): string | null {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (turnId) {
    const trackedTurn = session.dialogTurns.find(turn => turn.id === turnId);
    if (trackedTurn?.status === 'finishing') {
      return trackedTurn.id;
    }
  }

  const latestTurn = session.dialogTurns[session.dialogTurns.length - 1];
  return latestTurn?.status === 'finishing' ? latestTurn.id : null;
}

/**
 * Handle session title changes delivered through the compatible title event.
 */
function handleSessionTitleGenerated(event: any): void {
  const { sessionId, title } = event;
  if (!sessionId || !title) return;

  const store = FlowChatStore.getInstance();
  store.updateSessionTitle(sessionId, title, 'generated');
  reconcileBackgroundSubagentSession(sessionId);
}

function handleSessionModelFallbackApplied(event: SessionModelFallbackAppliedEvent): void {
  const { sessionId, previousModelId, newModelId, reason } = event;
  if (!sessionId || !newModelId) return;

  const store = FlowChatStore.getInstance();
  const applied = store.applySessionModelFallback(
    sessionId,
    previousModelId ?? '',
    newModelId,
  );
  if (!applied) {
    log.debug('Ignoring stale session model fallback', {
      sessionId,
      previousModelId,
      newModelId,
      reason,
      currentModelId: store.getState().sessions.get(sessionId)?.config.modelName,
    });
  }
}

function handleSessionReasoningPresetAutoCleared(
  event: SessionReasoningPresetAutoClearedEvent,
): void {
  const { sessionId, previousPresetId, reason } = event;
  if (!sessionId || !previousPresetId) return;

  const store = FlowChatStore.getInstance();
  const applied = store.applySessionReasoningPresetAutoClear(sessionId, previousPresetId);
  if (!applied) {
    log.debug('Ignoring stale session reasoning preset auto-clear', {
      sessionId,
      previousPresetId,
      reason,
      currentPresetId: store.getState().sessions.get(sessionId)?.config.reasoningPreset,
    });
  }
}

/**
 * Upsert a `user-steering` flow item into the latest model round of the given
 * dialog turn. Used both by the optimistic client-side path (right after
 * `steerDialogTurn` succeeds, status `pending`) and by the
 * `UserSteeringInjected` event handler (status `completed`). Dedupes by
 * `steering_${steeringId}`. If the item already exists, its status/roundIndex
 * is upgraded in place.
 *
 * Returns true if the item was inserted (newly added), false if it already
 * existed (status was upgraded if applicable) or the target turn/round is not
 * yet available.
 */
export function insertSteeringItemIfAbsent(params: {
  sessionId: string;
  turnId: string;
  steeringId: string;
  content: string;
  /** Images sent with the steering message, rendered under its text. */
  images?: SteeringImage[];
  roundIndex?: number;
  status?: 'pending' | 'completed';
}): boolean {
  const { sessionId, turnId, steeringId, content, images } = params;
  const roundIndex = typeof params.roundIndex === 'number' ? params.roundIndex : 0;
  const status = params.status ?? 'completed';

  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  if (!session) return false;
  const dialogTurn = session.dialogTurns.find(turn => turn.id === turnId);
  if (!dialogTurn) return false;

  const itemId = `steering_${steeringId}`;
  const existing = dialogTurn.modelRounds
    .flatMap(round => round.items)
    .find(it => it.id === itemId) as
      | { status: string; roundIndex?: number }
      | undefined;
  if (existing) {
    // Upgrade pending -> completed when the backend confirms injection.
    if (existing.status !== 'completed' && status === 'completed') {
      store.updateModelRoundItem(sessionId, turnId, itemId, {
        status: 'completed',
        roundIndex,
      } as any);
    }
    return false;
  }

  const item = {
    id: itemId,
    type: 'user-steering' as const,
    timestamp: Date.now(),
    status,
    steeringId,
    content,
    images: images?.length ? images : undefined,
    roundIndex,
  };

  const lastModelRound = dialogTurn.modelRounds[dialogTurn.modelRounds.length - 1];
  if (!lastModelRound) {
    const modelRound: ModelRound = {
      id: `steering_round_${steeringId}`,
      index: roundIndex,
      items: [item as any],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: Date.now(),
    };
    store.updateDialogTurn(sessionId, turnId, turn => ({
      ...turn,
      modelRounds: [...turn.modelRounds, modelRound],
      status: 'processing',
    }));
    return true;
  }

  store.addModelRoundItem(sessionId, turnId, item as any, lastModelRound.id);
  return true;
}

/**
 * Handle the `UserSteeringInjected` event: render an inline `user-steering`
 * item inside the latest model round of the running dialog turn so the user
 * can see the steering message they just submitted. Idempotent — if the
 * client-side optimistic path already added the item, this is a no-op.
 */
function handleUserSteeringInjected(_context: FlowChatContext, event: any): void {
  const sessionId: string | undefined = event?.sessionId;
  const turnId: string | undefined = event?.turnId;
  const steeringId: string | undefined = event?.steeringId;
  const content: string | undefined = event?.displayContent ?? event?.content;
  const roundIndex: number =
    typeof event?.roundIndex === 'number' ? event.roundIndex : 0;

  if (!sessionId || !turnId || !steeringId || !content) {
    log.warn('UserSteeringInjected: missing fields', { event });
    return;
  }

  insertSteeringItemIfAbsent({
    sessionId,
    turnId,
    steeringId,
    content,
    roundIndex,
  });
}

/**
 * Handle session deleted event (backend already deleted; only remove from store)
 */
function handleSessionDeleted(context: FlowChatContext, event: any): void {
  const { sessionId } = event;
  
  const store = FlowChatStore.getInstance();
  const removedSessionIds = store.getCascadeSessionIds(sessionId);
  if (removedSessionIds.length === 0) return;

  removedSessionIds.forEach(removedSessionId => {
    clearRecentHistorySessionOpenIntent(removedSessionId);
    clearHistorySessionOpenTransition(removedSessionId);
  });

  log.info('Remote session deleted', { sessionId });
  removedSessionIds.forEach(id => {
    clearPendingTurnCompletion(context, id);
    pendingImageAnalysisTurns.delete(id);
    context.pendingHistoryFenceSessions.delete(id);
    stateMachineManager.delete(id);
    context.processingManager.clearSessionStatus(id);
    cleanupSaveState(context, id);
    cleanupSessionBuffers(context, id);
  });
  store.removeSession(sessionId);
}

/**
 * Handle backend session state sync event
 */
export function handleSessionStateChanged(context: FlowChatContext, event: any): void {
  const { sessionId, newState } = event;
  
  const machine = stateMachineManager.get(sessionId);
  if (!machine) {
    log.debug('State sync: state machine not found', { sessionId });
    return;
  }
  
  const frontendState = mapBackendStateToFrontend(newState);
  const currentFrontendState = machine.getCurrentState();
  const isExpectedFinishingDrift =
    currentFrontendState === SessionExecutionState.FINISHING &&
    frontendState === SessionExecutionState.IDLE;
  
  const machineContext = machine.getContext();
  machineContext.backendSyncedAt = Date.now();

  if (isExpectedFinishingDrift) {
    if (context.userCancelledSessionIds.has(sessionId)) {
      log.debug('Holding FINISHING until the cancellation outcome is authoritative', {
        sessionId,
      });
      return;
    }
    finalizePendingTurnCompletionNow(context, sessionId);
    if (stateMachineManager.getCurrentState(sessionId) === SessionExecutionState.FINISHING) {
      const finishingTurnId = findFinishingTurnForBackendIdle(
        context,
        sessionId,
        machineContext.currentDialogTurnId,
      );
      if (finishingTurnId) {
        finalizeTurnCompletionState(context, sessionId, finishingTurnId);
      } else {
        void stateMachineManager
          .transition(sessionId, SessionExecutionEvent.FINISHING_SETTLED)
          .catch(error => {
            log.error('State machine transition failed on backend idle sync', { sessionId, error });
          });
      }
    }
    return;
  }
  
  if (currentFrontendState !== frontendState && !isExpectedFinishingDrift) {
    log.warn('Frontend and backend state mismatch', {
      sessionId,
      frontend: currentFrontendState,
      backend: frontendState,
      rawBackendState: newState
    });
  }
}

/**
 * Re-read the terminal tail only after the Runtime announces that its Turn is
 * durable. DialogTurnCompleted is intentionally lower latency than the final
 * persistence write, so relying on that event alone can preserve a painted
 * prefix when the last TextChunk was missed.
 *
 * The fence usually lands while the local Turn is still inside its completion
 * quiet window. Reading the host tail at that moment wastes a restore round
 * trip on a record the finalizer will re-read anyway, so the fence is parked
 * and consumed by `finalizeTurnCompletionState`. Each settled Turn therefore
 * performs exactly one reconcile, and only after the terminal record is
 * durable.
 */
export function handleSessionHistoryChanged(context: FlowChatContext, event: any): void {
  const sessionId = event?.sessionId ?? event?.session_id;
  if (!sessionId) {
    return;
  }

  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session || isAcpFlowSession(session)) {
    return;
  }

  const latestTurn = session.dialogTurns[session.dialogTurns.length - 1];
  if (latestTurn && !['completed', 'cancelled', 'error'].includes(latestTurn.status)) {
    // The local projection has not settled yet (completion quiet window, or
    // the next Turn already started). Defer to the completion finalizer.
    context.pendingHistoryFenceSessions.add(sessionId);
    return;
  }

  const settledTurn = [...session.dialogTurns]
    .reverse()
    .find(turn => ['completed', 'cancelled', 'error'].includes(turn.status));
  if (!settledTurn) {
    return;
  }

  context.pendingHistoryFenceSessions.delete(sessionId);
  reconcileDurableSessionHistory(context, sessionId, settledTurn.id);
}

function reconcileDurableSessionHistory(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
): void {
  void context.flowChatStore
    .reconcileSettledDialogTurn(sessionId, turnId)
    .then(applied => {
      if (applied) {
        reconcileBackgroundSubagentSession(sessionId);
      }
    })
    .catch(error => {
      log.warn('Failed to reconcile durable session history', {
        sessionId,
        turnId,
        error,
      });
    });
}

/**
 * Handle image analysis started event (backend vision pre-analysis).
 *
 * Two paths:
 * - Desktop: MessageModule already created the turn locally → just update its status.
 * - Remote (mobile/bot): No turn exists yet → create a temporary turn.
 */
function handleImageAnalysisStarted(context: FlowChatContext, event: ImageAnalysisEvent): void {
  const { sessionId, imageCount, userInput, imageMetadata } = event as any;

  const store = FlowChatStore.getInstance();
  let session = store.getState().sessions.get(sessionId);

  if (!session) {
    store.addExternalSession(
      sessionId,
      'Remote Session',
      'Standard',
      resolveExternalSessionWorkspacePath(context, event as any),
      undefined,
      extractEventRemoteConnectionId(event as any),
      extractEventRemoteSshHost(event as any)
    );
    session = store.getState().sessions.get(sessionId);
  }

  // Desktop path: the turn was created by MessageModule before the backend call.
  if (session) {
    const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
    if (lastTurn && (lastTurn.status === 'pending' || lastTurn.status === 'processing' || lastTurn.status === 'image_analyzing')) {
      store.updateDialogTurn(sessionId, lastTurn.id, turn => ({
        ...turn,
        status: 'image_analyzing' as const,
        userMessage: { ...turn.userMessage, hasImages: true },
      }));
      reconcileBackgroundSubagentSession(sessionId);
      log.info('Image analysis started: updated existing turn', {
        sessionId,
        turnId: lastTurn.id,
        imageCount,
      });
      return;
    }
  }

  // Extract image display data from metadata (same logic as handleDialogTurnStarted)
  const metaImages = imageMetadata?.images;
  const hasMetaImages = Array.isArray(metaImages) && metaImages.length > 0;
  const images = hasMetaImages
    ? metaImages.map((img: any) => ({
        id: img.id || img.name || `img-${Date.now()}`,
        name: img.name || 'image',
        dataUrl: img.data_url,
        imagePath: img.image_path,
        mimeType: img.mime_type,
      }))
    : undefined;
  const displayInput = imageMetadata?.original_text
    ? cleanRemoteUserInput(imageMetadata.original_text)
    : cleanRemoteUserInput(userInput || '');

  // Remote path: create a temporary turn so the desktop UI shows activity.
  const tempTurnId = `_img_analysis_${sessionId}_${Date.now()}`;

  const tempTurn: DialogTurn = {
    id: tempTurnId,
    sessionId,
    userMessage: {
      id: `user_img_${Date.now()}`,
      content: displayInput,
      timestamp: Date.now(),
      hasImages: true,
      images,
    },
    modelRounds: [],
    status: 'image_analyzing',
    startTime: Date.now(),
  };

  store.addDialogTurn(sessionId, tempTurn);
  reconcileBackgroundSubagentSession(sessionId);
  pendingImageAnalysisTurns.set(sessionId, tempTurnId);

  context.contentBuffers.set(sessionId, new Map());
  context.activeTextItems.set(sessionId, new Map());

  stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
    taskId: sessionId,
    dialogTurnId: tempTurnId,
  }).catch(error => {
    log.error('State machine transition failed on image analysis start', { sessionId, error });
  });

  log.info('Image analysis started: created temp turn for remote', {
    sessionId,
    tempTurnId,
    imageCount,
  });
}

/**
 * Handle image analysis completed event.
 * Updates the turn status so the UI transitions from "analyzing" to "processing".
 */
function handleImageAnalysisCompleted(_context: FlowChatContext, event: ImageAnalysisEvent): void {
  const { sessionId, success, durationMs } = event;

  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);

  if (session) {
    const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
    if (lastTurn && lastTurn.status === 'image_analyzing') {
      store.updateDialogTurn(sessionId, lastTurn.id, turn => ({
        ...turn,
        status: 'processing' as const,
      }));
      reconcileBackgroundSubagentSession(sessionId);
    }
  }

  log.info('Image analysis completed', { sessionId, success, durationMs });
}

function handleDialogTurnStarted(context: FlowChatContext, event: any): void {
  const { sessionId, turnId, turnIndex, userInput, originalUserInput, userMessageMetadata } = event;

  if (isSessionTurnRetired(sessionId, turnId)) {
    log.debug('Dropped DialogTurnStarted for retired turn', { sessionId, turnId });
    return;
  }

  finalizePendingTurnCompletionNow(context, sessionId);
  clearPendingTurnCompletion(context, sessionId, turnId);

  const store = FlowChatStore.getInstance();

  // Clean up temp image analysis turn if one exists for this session
  const tempTurnId = pendingImageAnalysisTurns.get(sessionId);
  const hadTempTurn = !!tempTurnId;
  if (tempTurnId) {
    pendingImageAnalysisTurns.delete(sessionId);

    // State machine was already transitioned to PROCESSING by ImageAnalysisStarted.
    // Update the context's dialogTurnId to the real turn ID.
    const machine = stateMachineManager.get(sessionId);
    if (machine) {
      const ctx = machine.getContext();
      ctx.currentDialogTurnId = turnId;
    }

    log.info('Adopting temp image analysis turn as real turn', {
      sessionId,
      tempTurnId,
      realTurnId: turnId,
    });
  }

  const state = store.getState();
  const session = state.sessions.get(sessionId);

  if (!session) {
    // Hidden MiniApp agent runs (e.g. PPT Live) submit turns with
    // `surface: 'miniapp_agent'`. Register them as transient miniapp sessions
    // so they stay out of the session list and the agent companion bubbles.
    const isMiniAppAgentRun = userMessageMetadata?.surface === 'miniapp_agent';
    const miniAppId = typeof userMessageMetadata?.appId === 'string'
      ? userMessageMetadata.appId
      : undefined;
    log.warn('DialogTurnStarted: session not in store, creating placeholder', { sessionId, sessionsCount: state.sessions.size, isMiniAppAgentRun });
    store.addExternalSession(
      sessionId,
      isMiniAppAgentRun ? (miniAppId ? `MiniApp: ${miniAppId}` : 'MiniApp Agent') : 'Remote Session',
      'Standard',
      resolveExternalSessionWorkspacePath(context, event),
      isMiniAppAgentRun
        ? { sessionKind: 'miniapp', isTransient: true, agentBackedTransient: true }
        : undefined,
      extractEventRemoteConnectionId(event),
      extractEventRemoteSshHost(event)
    );
  }

  // Extract image display data from metadata (sent by coordinator for all platforms)
  const metaImages = userMessageMetadata?.images;
  const hasImages = Array.isArray(metaImages) && metaImages.length > 0;
  const images = hasImages
    ? metaImages.map((img: any) => ({
        id: img.id || img.name || `img-${Date.now()}`,
        name: img.name || 'image',
        dataUrl: img.data_url,
        imagePath: img.image_path,
        mimeType: img.mime_type,
      }))
    : undefined;
  const displayContent = resolveDialogTurnDisplayContent(
    userInput,
    originalUserInput,
    userMessageMetadata,
  );
  const turnKind =
    userMessageMetadata?.kind === 'manual_compaction' ? 'manual_compaction' : 'user_dialog';

  const freshSession = store.getState().sessions.get(sessionId);
  let dialogTurn = freshSession?.dialogTurns.find((turn: DialogTurn) => turn.id === turnId);
  let projectedNewTurn = false;

  if (!dialogTurn && freshSession) {
    // Adoption is keyed purely by turn metadata: a driver that projected an
    // optimistic turn marked it with the session's pending adoption key, and
    // the executor's own DialogTurnStarted adopts it in place. No transport
    // check — a session whose turns carry no key never matches.
    const pendingAdoptionKey = sessionPendingTurnAdoptionKey(freshSession);
    const optimisticTurn = pendingAdoptionKey
      ? freshSession.dialogTurns.find(
          turn => optimisticTurnAdoptionKey(turn) === pendingAdoptionKey,
        )
      : undefined;
    if (optimisticTurn) {
      const optimisticMetadata = stripOptimisticTurnAdoption(
        optimisticTurn.userMessage.metadata,
      );
      const mergedMetadata =
        optimisticMetadata || userMessageMetadata
          ? { ...optimisticMetadata, ...userMessageMetadata }
          : undefined;
      store.replaceOptimisticDialogTurn(sessionId, optimisticTurn.id, {
        ...optimisticTurn,
        id: turnId,
        kind: optimisticTurn.kind || turnKind,
        userMessage: {
          ...optimisticTurn.userMessage,
          content: optimisticTurn.userMessage.content || displayContent,
          hasImages,
          metadata: mergedMetadata,
          images,
        },
        status: 'pending',
        storageTurnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
        backendTurnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
      });
      dialogTurn = store.getState().sessions
        .get(sessionId)
        ?.dialogTurns.find((turn: DialogTurn) => turn.id === turnId);
      projectedNewTurn = !!dialogTurn;
      const deferredOldKey = `${sessionId}:${optimisticTurn.id}`;
      const deferredNewKey = `${sessionId}:${turnId}`;
      const hadDeferredOldSave = context.deferredStorageIdentitySaves?.delete(deferredOldKey) === true;
      const hadDeferredNewSave = context.deferredStorageIdentitySaves?.delete(deferredNewKey) === true;
      if (hadDeferredOldSave || hadDeferredNewSave) {
        void saveDialogTurnToDisk(context, sessionId, turnId);
      }
    }
  }

  if (!dialogTurn) {
    const newTurn: DialogTurn = {
      id: turnId,
      sessionId,
      kind: turnKind,
      userMessage: {
        id: `user_remote_${Date.now()}`,
        content: displayContent,
        timestamp: Date.now(),
        hasImages,
        metadata: userMessageMetadata,
        images,
      },
      modelRounds: [],
      status: 'pending',
      startTime: Date.now(),
      storageTurnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
      backendTurnIndex: typeof turnIndex === 'number' ? turnIndex : undefined,
    };
    const replacedTempTurn = tempTurnId
      ? store.replaceOptimisticDialogTurn(sessionId, tempTurnId, newTurn)
      : false;
    if (!replacedTempTurn) {
      store.addDialogTurn(sessionId, newTurn);
    }
    projectedNewTurn = true;
  }

  if (projectedNewTurn) {
    reconcileBackgroundSubagentSession(sessionId);

    // Backend admission of a distinct new Turn supersedes any stale local
    // cancellation gate for the previous Turn. Late terminal events remain
    // identity-guarded and cannot settle this new execution.
    context.userCancelledSessionIds.delete(sessionId);

    context.contentBuffers.set(sessionId, new Map());
    context.activeTextItems.set(sessionId, new Map());

    if (!hadTempTurn) {
      stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
        taskId: sessionId,
        dialogTurnId: turnId,
      }).catch(error => {
        log.error('State machine transition failed on dialog turn start', { sessionId, error });
      });
    }
    return;
  }

  if (!dialogTurn) {
    return;
  }

  if (
    typeof turnIndex === 'number'
    && dialogTurn.storageTurnIndex === undefined
    && dialogTurn.backendTurnIndex === undefined
  ) {
    store.updateDialogTurn(sessionId, turnId, turn => ({
      ...turn,
      kind: turn.kind || turnKind,
      userMessage: {
        ...turn.userMessage,
        metadata: {
          ...(turn.userMessage.metadata ?? {}),
          ...(userMessageMetadata ?? {}),
        },
      },
      storageTurnIndex: turnIndex,
      backendTurnIndex: turnIndex,
    }));
    const deferredKey = `${sessionId}:${turnId}`;
    if (context.deferredStorageIdentitySaves?.delete(deferredKey)) {
      void saveDialogTurnToDisk(context, sessionId, turnId);
    }
  }
  reconcileBackgroundSubagentSession(sessionId);

  // User may have pre-added this turn from the composer while the previous turn was still running;
  // START failed then (PROCESSING/FINISHING cannot take START). When the backend dispatches this
  // turn, align currentDialogTurnId so streaming events are not dropped.
  const machine = stateMachineManager.get(sessionId);
  if (machine) {
    const ctx = machine.getContext();
    if (ctx.currentDialogTurnId !== turnId) {
      ctx.currentDialogTurnId = turnId;
    }
    if (machine.getCurrentState() === SessionExecutionState.IDLE) {
      void stateMachineManager.transition(sessionId, SessionExecutionEvent.START, {
        taskId: sessionId,
        dialogTurnId: turnId,
      });
    }
  }
}

/**
 * Handle text chunk event
 */
function handleTextChunk(context: FlowChatContext, event: any): void {
  const {
    sessionId,
    turnId,
    roundId,
    text,
    contentType = 'text',
    reasoningKind,
    isThinkingEnd = false,
  } = event;
  if (!shouldProcessEvent(sessionId, turnId, 'data', 'TextChunk')) {
    return;
  }
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  
  if (!session) {
    if (!context.contentBuffers.has(sessionId)) {
      log.debug('Session not found (text chunk event)', { sessionId });
    }
    return;
  }

  const dialogTurn = session.dialogTurns.find((turn: DialogTurn) => turn.id === turnId);
  if (!dialogTurn) {
    requestRuntimeProjectionRepair(sessionId);
    log.debug('Dialog turn not found', { turnId });
    return;
  }

  clearRuntimeStatus(context, sessionId, turnId, { roundId });
  touchPendingTurnCompletion(context, sessionId, turnId);
  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (isStreamingExecutionState(currentState)) {
    stateMachineManager.transition(sessionId, SessionExecutionEvent.TEXT_CHUNK_RECEIVED, {
      content: text,
    }).catch(error => {
      log.error('State machine transition failed on text chunk', { sessionId, error });
    });
  }

  const eventData: TextChunkEventData = {
    sessionId,
    turnId,
    roundId,
    attemptId: event.attemptId,
    attemptIndex: event.attemptIndex,
    text,
    contentType: contentType as 'text' | 'thinking',
    reasoningKind,
    isThinkingEnd,
  };
  
  const key = generateTextChunkKey(eventData);
  
  context.eventBatcher.add(
    key,
    eventData,
    'accumulate',
    (existing, incoming) => ({
      ...existing,
      text: existing.text + incoming.text,
      isThinkingEnd: existing.isThinkingEnd || incoming.isThinkingEnd
    }),
    { maxLatencyMs: TEXT_CHUNK_MAX_LATENCY_MS }
  );
}

/**
 * Process batched events
 */
export function processBatchedEvents(
  context: FlowChatContext,
  events: Array<{ key: string; payload: any }>,
  _onTodoWriteResult: (sessionId: string, turnId: string, result: any) => void
): void {
  if (events.length === 0) return;
  
  context.flowChatStore.beginSilentMode();
  
  try {
    for (const { key, payload } of events) {
      const parsed = parseEventKey(key);
      if (!parsed) continue;
      
      const { eventType } = parsed;
      
      if (eventType === 'text') {
        const {
          sessionId,
          turnId,
          roundId,
          attemptId,
          attemptIndex,
          text,
          contentType,
          reasoningKind,
          isThinkingEnd,
        } = payload;
        if (contentType === 'thinking') {
          processThinkingChunkInternal(
            context,
            sessionId,
            turnId,
            roundId,
            text,
            isThinkingEnd,
            attemptId,
            attemptIndex,
            reasoningKind,
          );
        } else {
          processNormalTextChunkInternal(context, sessionId, turnId, roundId, text, attemptId, attemptIndex);
        }
        
        // The executing host owns turn persistence. A Peer controller receives
        // the same chunks for rendering and must not echo a save RPC for every
        // checkpoint, especially on a weak link.
        if (!isPeerDeviceModeActive()) {
          debouncedSaveDialogTurn(context, sessionId, turnId, 2000);
        }
      } else if (eventType === 'tool:params') {
        const { sessionId, turnId, toolEvent } = payload;
        processToolParamsPartialInternal(sessionId, turnId, toolEvent);
        reconcileBackgroundSubagentFromParentTool(sessionId, turnId, toolEvent.tool_id);
      } else if (eventType === 'tool:progress') {
        const { sessionId, turnId, toolEvent } = payload;
        processToolProgressInternal(sessionId, turnId, toolEvent);
        reconcileBackgroundSubagentFromParentTool(sessionId, turnId, toolEvent.tool_id);
      }
    }
  } finally {
    context.flowChatStore.endSilentMode();
  }
}

/**
 * Handle tool event
 */
function handleToolEvent(
  context: FlowChatContext,
  event: {
    sessionId: string;
    turnId?: string;
    roundId?: string;
    attemptId?: string;
    attemptIndex?: number;
    toolEvent: FlowToolEvent;
  },
  onTodoWriteResult: (sessionId: string, turnId: string, result: any) => void
): void {
  const { sessionId, turnId, roundId, attemptId, attemptIndex, toolEvent } = event;
  if (!turnId) {
    log.debug('Tool event missing turnId', { sessionId, toolId: toolEvent.tool_id, eventType: toolEvent.event_type });
    return;
  }
  if (!roundId) {
    log.error('Tool event missing roundId (backend bug)', {
      sessionId,
      turnId,
      toolId: toolEvent.tool_id,
      eventType: toolEvent.event_type,
    });
    return;
  }

  if (!shouldProcessEvent(sessionId, turnId, 'data', 'ToolEvent')) {
    return;
  }

  clearRuntimeStatus(context, sessionId, turnId, { roundId });
  touchPendingTurnCompletion(context, sessionId, turnId);
  
  const eventData: ToolEventData = {
    sessionId,
    turnId,
    roundId,
    attemptId,
    attemptIndex,
    toolEvent,
  };
  
  const keyInfo = generateToolEventKey(eventData);
  
  if (keyInfo) {
    const { key, strategy } = keyInfo;
    
    if (strategy === 'accumulate') {
      context.eventBatcher.add(
        key,
        eventData,
        'accumulate',
        mergeParamsPartialEventData,
      );
    } else {
      context.eventBatcher.add(key, eventData, 'replace');
    }
    return;
  }

  processToolEvent(context, sessionId, turnId, roundId, toolEvent, attemptId, attemptIndex, undefined, onTodoWriteResult);
  reconcileBackgroundSubagentFromParentTool(sessionId, turnId, toolEvent.tool_id);
}

/**
 * Handle model round started event
 */
function handleModelRoundStart(context: FlowChatContext, event: ModelRoundStartedEvent): void {
  const { sessionId, turnId, roundId, roundIndex, roundGroupId } = event;
  
  if (!shouldProcessEvent(sessionId, turnId, 'data', 'ModelRoundStarted')) {
    return;
  }
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  
  if (!session) {
    log.debug('Session not found (model round start)', { sessionId });
    return;
  }

  const dialogTurn = session.dialogTurns.find((turn: DialogTurn) => turn.id === turnId);
  if (!dialogTurn) {
    requestRuntimeProjectionRepair(sessionId);
    log.debug('Dialog turn not found (model round start)', { turnId });
    return;
  }

  touchPendingTurnCompletion(context, sessionId, turnId);

  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (isStreamingExecutionState(currentState)) {
    stateMachineManager.transition(sessionId, SessionExecutionEvent.MODEL_ROUND_START, {
      modelRoundId: roundId,
    }).catch(error => {
      log.error('State machine transition failed on model round start', { sessionId, error });
    });
  }

  completeActiveTextItems(context, sessionId, turnId);

  const disableExploreGrouping =
    event.renderHints?.disableExploreGrouping === true ||
    event.metadata?.disableExploreGrouping === true ||
    event.disableExploreGrouping === true;
  const modelRound: ModelRound = {
    id: roundId,
    index: roundIndex || 0,
    roundGroupId,
    items: [],
    isStreaming: true,
    isComplete: false,
    status: 'streaming',
    startTime: Date.now(),
    // Model identity is optional: external ACP agents carry none.
    ...(event.modelConfigId ? { modelConfigId: event.modelConfigId.trim() } : {}),
    ...(event.effectiveModelName ? { effectiveModelName: event.effectiveModelName.trim() } : {}),
    ...(disableExploreGrouping
      ? { renderHints: { disableExploreGrouping: true } }
      : {}),
  };

  context.flowChatStore.addModelRound(sessionId, turnId, modelRound);
  scheduleModelResponseStatus(context, sessionId, turnId, roundId);

  const linkedParentInfo =
    findSubagentParentInfoByRound(sessionId, turnId) ||
    getLinkedSubagentParentInfo(sessionId);
  if (linkedParentInfo && modelRound.effectiveModelName) {
    updateSubagentParentTaskModel(
      context,
      linkedParentInfo,
      modelRound.modelConfigId,
      modelRound.effectiveModelName,
    );
  }
  
  immediateSaveDialogTurn(context, sessionId, turnId);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function handleModelRoundAttemptSuperseded(
  context: FlowChatContext,
  event: ModelRoundAttemptSupersededEvent,
): void {
  const sessionId = event?.sessionId ?? (event as any)?.session_id;
  const turnId = event?.turnId ?? (event as any)?.turn_id;
  const roundId = event?.roundId ?? (event as any)?.round_id;
  const diagnostic = event?.diagnostic;

  if (!sessionId || !turnId || !roundId) {
    log.warn('ModelRoundAttemptSuperseded missing identity fields', { event });
    return;
  }

  if (
    !diagnostic ||
    typeof diagnostic.attemptId !== 'string' ||
    typeof diagnostic.attemptIndex !== 'number' ||
    typeof diagnostic.category !== 'string'
  ) {
    log.warn('ModelRoundAttemptSuperseded has an invalid diagnostic', { sessionId, turnId, roundId });
    return;
  }

  if (!shouldProcessEvent(sessionId, turnId, 'data', 'ModelRoundAttemptSuperseded')) {
    return;
  }

  const round = context.flowChatStore.getState().sessions.get(sessionId)
    ?.dialogTurns.find(dialogTurn => dialogTurn.id === turnId)
    ?.modelRounds.find(modelRound => modelRound.id === roundId);
  if (!round) {
    log.debug('Model round not found (attempt superseded)', { sessionId, turnId, roundId });
    return;
  }

  context.flowChatStore.updateModelRound(
    sessionId,
    turnId,
    roundId,
    current => mergeModelRoundAttemptDiagnostics(current, [diagnostic], {
      supersedeMatchingAttempts: true,
    }),
  );
}

/**
 * Handle model round completed event.
 */
function handleModelRoundComplete(context: FlowChatContext, event: ModelRoundCompletedEvent): void {
  const sessionId = event?.sessionId ?? (event as any)?.session_id;
  const turnId = event?.turnId ?? (event as any)?.turn_id;
  const roundId = event?.roundId ?? (event as any)?.round_id;

  if (!sessionId || !turnId || !roundId) {
    log.warn('ModelRoundCompleted missing identity fields', { event });
    return;
  }

  if (!shouldProcessEvent(sessionId, turnId, 'data', 'ModelRoundCompleted')) {
    return;
  }

  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  const dialogTurn = session?.dialogTurns.find((turn: DialogTurn) => turn.id === turnId);
  const round = dialogTurn?.modelRounds.find(modelRound => modelRound.id === roundId);
  if (!round) {
    log.debug('Model round not found (model round complete)', { sessionId, turnId, roundId });
    return;
  }

  const durationMs = optionalNumber(event.durationMs ?? (event as any).duration_ms);
  const completedAt = Date.now();
  const endTime = round.endTime ?? (durationMs !== undefined ? round.startTime + durationMs : completedAt);

  context.flowChatStore.updateModelRound(sessionId, turnId, roundId, current => ({
    ...current,
    isStreaming: false,
    isComplete: true,
    status: current.status === 'error' || current.status === 'cancelled'
      ? current.status
      : 'completed',
    endTime,
    durationMs,
    providerId: event.providerId ?? (event as any).provider_id,
    modelConfigId: event.modelConfigId,
    effectiveModelName: event.effectiveModelName,
    firstChunkMs: optionalNumber(event.firstChunkMs ?? (event as any).first_chunk_ms),
    firstVisibleOutputMs: optionalNumber(event.firstVisibleOutputMs ?? (event as any).first_visible_output_ms),
    streamDurationMs: optionalNumber(event.streamDurationMs ?? (event as any).stream_duration_ms),
    attemptCount: optionalNumber(event.attemptCount ?? (event as any).attempt_count),
    failureCategory: event.failureCategory ?? (event as any).failure_category,
    tokenDetails: event.tokenDetails ?? (event as any).token_details,
  }));

  immediateSaveDialogTurn(context, sessionId, turnId);

  const linkedParentInfo = getLinkedSubagentParentInfo(sessionId);
  if (linkedParentInfo && !isBackgroundSubagent(linkedParentInfo)) {
    immediateSaveDialogTurn(context, linkedParentInfo.sessionId, linkedParentInfo.dialogTurnId);
  }
}

/**
 * Handle token usage update event
 */
function handleTokenUsageUpdate(context: FlowChatContext, event: any): void {
  const sessionId = event.sessionId ?? event.session_id;
  const turnId = event.turnId ?? event.turn_id;
  const inputTokens = event.inputTokens ?? event.input_tokens;
  const outputTokens = event.outputTokens ?? event.output_tokens;
  const totalTokens = event.totalTokens ?? event.total_tokens;
  const maxContextTokens = event.maxContextTokens ?? event.max_context_tokens;
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  
  if (!session) {
    log.debug('Session not found (token usage update)', { sessionId });
    return;
  }
  if (
    typeof turnId !== 'string'
    || !session.dialogTurns.some(turn => turn.id === turnId)
  ) {
    log.debug('Dropped token usage update for non-visible turn', { sessionId, turnId });
    return;
  }
  if (typeof inputTokens !== 'number' || typeof totalTokens !== 'number') {
    log.debug('Dropped invalid token usage update', { event });
    return;
  }

  store.updateTokenUsage(sessionId, {
    inputTokens,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    totalTokens,
    turnId,
    source: 'model_request',
  }, turnId);

  if (maxContextTokens !== undefined && maxContextTokens !== null) {
    store.updateSessionMaxContextTokens(sessionId, maxContextTokens);
  }

  if (turnId) {
    immediateSaveDialogTurn(context, sessionId, turnId);
  }
}

function handleAcpContextUsageUpdate(event: AcpContextUsageUpdatedEvent): void {
  const { sessionId, used, size, cost } = event;

  if (!sessionId || typeof used !== 'number' || typeof size !== 'number') {
    log.debug('Dropped invalid ACP context usage update', { event });
    return;
  }

  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);

  if (!session) {
    log.debug('Session not found (ACP context usage update)', { sessionId });
    return;
  }

  store.updateAcpContextUsage(
    sessionId,
    cost ? { used, size, cost } : { used, size },
  );
}

/**
 * Handle context compression started event
 */
function handleCompressionStarted(_context: FlowChatContext, event: any): void {
  const { sessionId, turnId, compressionId, trigger, tokensBefore, contextWindow } = event;
  
  log.info('Context compression started', {
    sessionId, turnId, compressionId, trigger, tokensBefore, contextWindow
  });
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  
  if (!session) {
    log.debug('Session not found (compression started)', { sessionId });
    return;
  }
  
  const dialogTurn = session.dialogTurns.find(turn => turn.id === turnId);
  if (!dialogTurn) {
    log.debug('Dialog turn not found (compression started)', { turnId });
    return;
  }

  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (isStreamingExecutionState(currentState)) {
    void stateMachineManager
      .transition(sessionId, SessionExecutionEvent.COMPACTION_STARTED)
      .catch(error => {
        log.error('State machine transition failed on compression start', { sessionId, error });
      });
  }
  
  const compressionItem: FlowToolItem = {
    id: compressionId,
    type: 'tool',
    toolName: 'ContextCompression',
    toolCall: {
      input: {
        trigger,
        tokens_before: tokensBefore,
        context_window: contextWindow,
      },
      id: compressionId
    },
    timestamp: Date.now(),
    status: 'running',
    requiresConfirmation: false,
    startTime: Date.now()
  };
  
  let lastModelRound = dialogTurn.modelRounds[dialogTurn.modelRounds.length - 1];
  if (!lastModelRound) {
    const newRoundId = `round_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    lastModelRound = {
      id: newRoundId,
      index: 0,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: Date.now()
    };
    store.addModelRound(sessionId, turnId, lastModelRound);
  }
  
  store.addModelRoundItem(sessionId, turnId, compressionItem, lastModelRound.id);
}

/**
 * Handle context compression completed event
 */
function handleCompressionCompleted(context: FlowChatContext, event: any): void {
  const { 
    sessionId, turnId, compressionId, compressionCount, applied,
    tokensBefore, tokensAfter, compressionRatio, durationMs, hasSummary, summarySource
  } = event;
  
  log.info('Context compression completed', {
    sessionId, turnId, compressionId, compressionCount, applied,
    tokensBefore, tokensAfter, compressionRatio, durationMs
  });
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  if (
    typeof turnId !== 'string'
    || !session?.dialogTurns.some(turn => turn.id === turnId)
  ) {
    log.debug('Dropped compression completion for non-visible turn', { sessionId, turnId });
    return;
  }
  
  store.updateModelRoundItem(sessionId, turnId, compressionId, {
    toolResult: {
      result: {
        compression_count: compressionCount,
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        compression_ratio: compressionRatio,
        duration: durationMs,
        has_summary: hasSummary,
        summary_source: summarySource,
      },
      success: true,
      duration_ms: durationMs || 0
    },
    status: 'completed',
    endTime: Date.now()
  } as any);

  // Keep the input-box context usage display in sync: a completed compression
  // shrinks the context immediately, but no TokenUsageUpdated event follows it
  // (that event is only emitted after a model response). Reflect the compacted
  // size here so the percentage and "last request input context" refresh right
  // away. Do not pass a dialogTurnId: compression is not a model invocation, so
  // it must not accumulate into the turn's token usage.
  if (applied === true && typeof tokensAfter === 'number' && tokensAfter >= 0) {
    store.updateTokenUsage(sessionId, {
      inputTokens: tokensAfter,
      totalTokens: tokensAfter,
      outputTokens: undefined,
      turnId,
      source: 'context_compression',
    });
  }
  
  immediateSaveDialogTurn(context, sessionId, turnId);
}

/**
 * Handle context compression failed event
 */
function handleCompressionFailed(context: FlowChatContext, event: any): void {
  const { sessionId, turnId, compressionId, error } = event;
  
  log.error('Context compression failed', { sessionId, turnId, compressionId, error });
  
  const store = FlowChatStore.getInstance();
  
  store.updateModelRoundItem(sessionId, turnId, compressionId, {
    toolResult: {
      result: null,
      success: false,
      error,
      duration_ms: 0
    },
    status: 'error',
    endTime: Date.now()
  } as any);
  
  immediateSaveDialogTurn(context, sessionId, turnId);
}

/**
 * Handle dialog turn completed event
 */
function buildUnsuccessfulCompletionError(finishReason?: string): string {
  if (finishReason === 'empty_round') {
    return 'Model returned an empty response after retrying. finish_reason=empty_round';
  }

  return finishReason
    ? `Dialog turn ended without a usable result. finish_reason=${finishReason}`
    : 'Dialog turn ended without a usable result.';
}

function handleThreadGoalUpdatedEvent(event: any): void {
  const sessionId = event?.sessionId ?? event?.session_id;
  if (typeof sessionId !== 'string' || !sessionId) {
    log.warn('ThreadGoalUpdated missing sessionId', { event });
    return;
  }

  handleThreadGoalUpdated({
    sessionId,
    goal: event?.goal ?? null,
  });
}

function buildBuiltInBrowserTabOptions(
  event: OpenBuiltInBrowserEvent,
): TabCreationOptions | null {
  const url = typeof event?.url === 'string' ? event.url.trim() : '';
  if (!url) return null;

  const title = typeof event?.title === 'string' && event.title.trim()
    ? event.title.trim()
    : 'Browser';
  const requestId = typeof event?.requestId === 'string' && event.requestId.trim()
    ? event.requestId.trim()
    : undefined;
  const replaceExisting = event?.replaceExisting !== false;
  // Replacing uses one stable product surface. A true new-tab request gets a
  // request-scoped key so identical URLs can still open as distinct targets.
  const duplicateCheckKey = replaceExisting
    ? 'browser-panel'
    : `browser-panel:${requestId ?? url}`;

  return {
    type: 'browser',
    title,
    data: { url, openRequestId: requestId },
    metadata: { duplicateCheckKey },
    checkDuplicate: true,
    duplicateCheckKey,
    replaceExisting,
    mode: 'agent',
  };
}

function handleOpenBuiltInBrowser(event: OpenBuiltInBrowserEvent): void {
  const options = buildBuiltInBrowserTabOptions(event);
  if (!options) {
    log.warn('OpenBuiltInBrowser missing url', { event });
    return;
  }
  createTab(options);
}

export function handleDialogTurnComplete(
  context: FlowChatContext,
  event: any,
  _onTodoWriteResult: (sessionId: string, turnId: string, result: any) => void
): void {
  const sessionId = event?.sessionId ?? event?.session_id;
  const turnId = event?.turnId ?? event?.turn_id;
  // Partial recovery reason from backend (stream was interrupted mid-way)
  const partialRecoveryReason = event?.partialRecoveryReason ?? event?.partial_recovery_reason;
  const success = event?.success;
  const finishReason = event?.finishReason ?? event?.finish_reason;
  const hasFinalResponse = event?.hasFinalResponse ?? event?.has_final_response;
  const durationMs = optionalNumber(event?.durationMs ?? event?.duration_ms);

  if (!sessionId || !turnId) {
    log.warn('DialogTurnCompleted missing sessionId or turnId', { event });
    return;
  }
  interruptedTurnRecoveryGate.clearTerminal(sessionId, turnId);


  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);

  if (success === false) {
    handleDialogTurnFailed(context, {
      ...event,
      sessionId,
      turnId,
      error: event?.error || buildUnsuccessfulCompletionError(finishReason),
    });
    return;
  }

  // P1-11: Idempotent terminal-event handling. The backend may emit
  // DialogTurnCompleted only once for a turn, but if a future change adds a
  // duplicate emit path, we want this handler to be a no-op the second time.
  const terminalKey = `${sessionId}:${turnId}`;
  if (context.handledTerminalTurnEvents.has(terminalKey)) {
    log.debug('Ignoring duplicate DialogTurnCompleted', { sessionId, turnId });
    return;
  }
  context.handledTerminalTurnEvents.add(terminalKey);

  if (!session) {
    log.debug('Session not found (dialog turn complete)', { sessionId });
    return;
  }
  const ownsSessionSettlement = eventOwnsLatestSessionTurn(session, sessionId, turnId);

  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => {
    if (!ownsSessionSettlement) {
      const completedAt = Date.now();
      return {
        ...turn,
        modelRounds: turn.modelRounds.map(round => round.isStreaming
          ? {
              ...round,
              isStreaming: false,
              isComplete: true,
              status: 'completed' as const,
              endTime: round.endTime ?? completedAt,
            }
          : round),
        status: 'completed' as const,
        endTime: durationMs === undefined
          ? turn.endTime ?? completedAt
          : turn.startTime + Math.max(0, durationMs),
        success: success ?? undefined,
        finishReason: finishReason ?? undefined,
        hasFinalResponse: typeof hasFinalResponse === 'boolean' ? hasFinalResponse : undefined,
        recovery: undefined,
      };
    }
    return {
      ...turn,
      status: 'finishing' as const,
      endTime: durationMs === undefined
        ? turn.endTime
        : turn.startTime + Math.max(0, durationMs),
      success: success ?? undefined,
      finishReason: finishReason ?? undefined,
      hasFinalResponse: typeof hasFinalResponse === 'boolean' ? hasFinalResponse : undefined,
    };
  });
  reconcileBackgroundSubagentSession(sessionId);

  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (ownsSessionSettlement && currentState === SessionExecutionState.PROCESSING) {
    void stateMachineManager
      .transition(sessionId, SessionExecutionEvent.BACKEND_STREAM_COMPLETED)
      .catch(error => {
        log.error('State machine transition failed on backend stream completed', { sessionId, error });
      });
  } else {
    log.debug('Skipping BACKEND_STREAM_COMPLETED transition', { currentState, sessionId, turnId });
  }

  if (ownsSessionSettlement) {
    beginTurnCompletion(context, sessionId, turnId, partialRecoveryReason);
  }
}

function normalizeDialogErrorDetail(event: any): AiErrorDetail {
  const rawCategory = typeof event.errorCategory === 'string' ? event.errorCategory : undefined;
  const detail = event.errorDetail && typeof event.errorDetail === 'object'
    ? event.errorDetail
    : { category: rawCategory, rawMessage: event.error };

  return normalizeAiErrorDetail(detail, event.error);
}

function handleDialogTurnFailed(context: FlowChatContext, event: any): void {
  const { sessionId, turnId, error } = event;
  const errorDetail = normalizeDialogErrorDetail(event);

  if (sessionId && turnId) {
    interruptedTurnRecoveryGate.clearTerminal(sessionId, turnId);
  }

  // P1-11: Idempotent terminal-event handling.
  if (sessionId && turnId) {
    const terminalKey = `${sessionId}:${turnId}`;
    if (context.handledTerminalTurnEvents.has(terminalKey)) {
      log.debug('Ignoring duplicate DialogTurnFailed', { sessionId, turnId });
      return;
    }
    context.handledTerminalTurnEvents.add(terminalKey);
  }

  log.error('Dialog turn failed', { sessionId, turnId, error, errorDetail });
  clearPendingTurnCompletion(context, sessionId, turnId);
  clearRuntimeStatus(context, sessionId, turnId);
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  
  if (!session) {
    log.debug('Session not found (dialog turn failed)', { sessionId });
    return;
  }
  const ownsSessionSettlement = eventOwnsLatestSessionTurn(session, sessionId, turnId);
  
  if (ownsSessionSettlement) {
    cleanupSessionBuffers(context, sessionId);
    context.flowChatStore.markSessionFinished(sessionId);
  }
  
  const dialogTurn = session.dialogTurns.find(turn => turn.id === turnId);
  if (dialogTurn) {
    const runtimeOwnsTurnPersistence = Boolean(dialogTurn.recovery);
    const terminalError = typeof error === 'string' && error.trim()
      ? error
      : errorDetail.rawMessage || errorDetail.providerMessage || 'Execution failed';
    context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => {
      const updatedModelRounds = turn.modelRounds.map((round) => {
        if (round.isStreaming) {
          return {
            ...round,
            isStreaming: false,
            isComplete: true,
            status: 'error' as const,
            endTime: Date.now()
          };
        }
        return round;
      });
      
      return {
        ...turn,
        modelRounds: updatedModelRounds,
        status: 'error' as const,
        error: terminalError,
        errorDetail,
        endTime: Date.now(),
        recoveryEpoch: turn.recovery?.executionGeneration ?? turn.recoveryEpoch,
        recovery: undefined,
      };
    });
    
    if (!runtimeOwnsTurnPersistence) {
      saveDialogTurnToDisk(context, sessionId, turnId).catch(err => {
        log.warn('Failed to save failed dialog turn', { sessionId, turnId, error: err });
      });
    }
  }
  reconcileBackgroundSubagentSession(sessionId);
  
  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (ownsSessionSettlement && isStreamingExecutionState(currentState)) {
    stateMachineManager.transition(sessionId, SessionExecutionEvent.ERROR_OCCURRED, {
      error: error || 'Execution failed'
    }).catch(err => {
      log.error('State machine transition failed on error occurred', { sessionId, error: err });
    });
    stateMachineManager.transition(sessionId, SessionExecutionEvent.RESET).catch(err => {
      log.error('State machine transition failed on reset', { sessionId, error: err });
    });
  }
  
  if (ownsSessionSettlement) {
    context.flowChatStore.markSessionUnreadCompletion(sessionId, 'error', turnId);
  }
  if (ownsSessionSettlement) {
    context.userCancelledSessionIds.delete(sessionId);
  }
}

/**
 * Handle dialog turn cancelled event
 */
function handleDialogTurnCancelled(
  context: FlowChatContext,
  event: any,
  _onTodoWriteResult: (sessionId: string, turnId: string, result: any) => void
): void {
  const { sessionId, turnId } = event;

  if (sessionId && turnId) {
    interruptedTurnRecoveryGate.clearTerminal(sessionId, turnId);
  }

  // P1-11: Idempotent terminal-event handling. The execution engine may emit
  // DialogTurnCancelled when it detects cancellation between rounds, and the
  // coordinator wrapper unconditionally re-emits one when the turn returns
  // OpenBitFunError::Cancelled. Both paths can fire on the same turn — make
  // sure we only run the visible side-effects once.
  if (sessionId && turnId) {
    const terminalKey = `${sessionId}:${turnId}`;
    if (context.handledTerminalTurnEvents.has(terminalKey)) {
      log.debug('Ignoring duplicate DialogTurnCancelled', { sessionId, turnId });
      return;
    }
    context.handledTerminalTurnEvents.add(terminalKey);
  }

  log.info('Dialog turn cancelled', { sessionId, turnId });
  clearPendingTurnCompletion(context, sessionId, turnId);
  clearRuntimeStatus(context, sessionId, turnId);
  
  const store = FlowChatStore.getInstance();
  const session = store.getState().sessions.get(sessionId);
  
  if (!session) {
    log.debug('Session not found (dialog turn cancelled)', { sessionId });
    return;
  }
  const ownsSessionSettlement = eventOwnsLatestSessionTurn(session, sessionId, turnId);
  
  if (ownsSessionSettlement) {
    cleanupSessionBuffers(context, sessionId);
    context.flowChatStore.markSessionFinished(sessionId);
  }
  const runtimeOwnsTurnPersistence = Boolean(
    session.dialogTurns.find(turn => turn.id === turnId)?.recovery,
  );
  
  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => {
    const updatedModelRounds = turn.modelRounds.map((round) => {
      if (round.isStreaming) {
        return {
          ...round,
          isStreaming: false,
          isComplete: true,
          status: 'cancelled' as const,
          endTime: Date.now()
        };
      }
      return round;
    });
    
    return {
      ...turn,
      modelRounds: updatedModelRounds,
      status: 'cancelled' as const,
      endTime: Date.now(),
      recoveryEpoch: turn.recovery?.executionGeneration ?? turn.recoveryEpoch,
      recovery: undefined,
    };
  });
  reconcileBackgroundSubagentSession(sessionId);
   
  if (!runtimeOwnsTurnPersistence) {
    saveDialogTurnToDisk(context, sessionId, turnId).catch(err => {
      log.warn('Failed to save cancelled dialog turn', { sessionId, turnId, error: err });
    });
  }

  // Transition state machine to IDLE.  When the desktop's own stop button
  // is used, USER_CANCEL is dispatched before DialogTurnCancelled arrives,
  // so the machine is already IDLE.  When cancellation comes from an
  // external source (mobile remote), the machine is still PROCESSING.
  const currentState = stateMachineManager.getCurrentState(sessionId);
  if (ownsSessionSettlement && isStreamingExecutionState(currentState)) {
    void stateMachineManager
      .transition(sessionId, SessionExecutionEvent.FINISHING_SETTLED)
      .catch(error => {
        log.error('State machine transition failed on cancelled finishing settled', { sessionId, error });
      });
  }

  if (
    ownsSessionSettlement
    && !context.userCancelledSessionIds.has(sessionId)
  ) {
    context.flowChatStore.markSessionUnreadCompletion(sessionId, 'interrupted', turnId);
  }
  if (ownsSessionSettlement) {
    context.userCancelledSessionIds.delete(sessionId);
  }
}

function handleDialogTurnInterrupted(context: FlowChatContext, event: any): void {
  const sessionId = event?.sessionId ?? event?.session_id;
  const turnId = event?.turnId ?? event?.turn_id;
  const executionGeneration = optionalNumber(
    event?.executionGeneration ?? event?.execution_generation,
  );
  const rawModelId = event?.modelId ?? event?.model_id;
  const modelId = typeof rawModelId === 'string' && rawModelId.trim()
    ? rawModelId.trim()
    : undefined;
  if (!sessionId || !turnId || executionGeneration === undefined) {
    log.warn('DialogTurnInterrupted missing identity or generation', { event });
    return;
  }
  interruptedTurnRecoveryGate.clearInterrupted({ sessionId, turnId, executionGeneration });
  if (context.handledTerminalTurnEvents.has(`${sessionId}:${turnId}`)) {
    log.debug('Ignoring DialogTurnInterrupted after authoritative terminal settlement', {
      sessionId,
      turnId,
      executionGeneration,
    });
    return;
  }
  const currentTurn = context.flowChatStore
    .getState()
    .sessions.get(sessionId)
    ?.dialogTurns.find(turn => turn.id === turnId);
  const currentGeneration = currentTurn?.recovery?.executionGeneration;
  if (
    currentGeneration !== undefined
    && (currentGeneration > executionGeneration
      || (currentGeneration === executionGeneration
        && currentTurn?.recovery?.status === 'interrupted'))
  ) {
    log.debug('Ignoring stale or duplicate DialogTurnInterrupted', {
      sessionId,
      turnId,
      executionGeneration,
      currentGeneration,
    });
    return;
  }

  const machine = stateMachineManager.get(sessionId);
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  const latestTurnId = session?.dialogTurns.at(-1)?.id;
  const currentState = stateMachineManager.getCurrentState(sessionId);
  const ownsSessionSettlement = latestTurnId === turnId
    && (machine?.getContext().currentDialogTurnId === turnId
      || currentState === SessionExecutionState.IDLE);

  clearPendingTurnCompletion(context, sessionId, turnId);
  clearRuntimeStatus(context, sessionId, turnId);
  if (ownsSessionSettlement) {
    cleanupSessionBuffers(context, sessionId);
    context.flowChatStore.markSessionFinished(sessionId);
  }
  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => ({
    ...turn,
    modelRounds: turn.modelRounds.map(round => ({
      ...round,
      isStreaming: false,
      isComplete: true,
      status: round.isStreaming ? 'cancelled' as const : round.status,
      endTime: round.isStreaming ? Date.now() : round.endTime,
    })),
    status: 'cancelled' as const,
    finishReason: 'interrupted',
    endTime: Date.now(),
    recovery: {
      status: 'interrupted' as const,
      executionGeneration,
      resumeCount: executionGeneration,
      interruptedAt: Date.now(),
      modelId: modelId ?? turn.recovery?.modelId,
    },
  }));

  if (ownsSessionSettlement && isStreamingExecutionState(currentState)) {
    void stateMachineManager
      .transition(sessionId, SessionExecutionEvent.FINISHING_SETTLED)
      .catch(error => {
        log.error('State machine transition failed on interrupted turn settlement', {
          sessionId,
          turnId,
          error,
        });
      });
  }
  if (ownsSessionSettlement) {
    context.flowChatStore.markSessionUnreadCompletion(sessionId, 'interrupted', turnId);
  }
  if (ownsSessionSettlement) {
    context.userCancelledSessionIds.delete(sessionId);
  }
}

function handleDialogTurnRecovered(context: FlowChatContext, event: any): void {
  const sessionId = event?.sessionId ?? event?.session_id;
  const turnId = event?.turnId ?? event?.turn_id;
  const executionGeneration = optionalNumber(
    event?.executionGeneration ?? event?.execution_generation,
  );
  if (!sessionId || !turnId || executionGeneration === undefined) {
    log.warn('DialogTurnRecovered missing identity or generation', { event });
    return;
  }
  if (projectDialogTurnRecovered(context, { sessionId, turnId, executionGeneration })) {
    interruptedTurnRecoveryGate.clearRecovered({ sessionId, turnId, executionGeneration });
  }
}

/** Apply one authoritative recovery admission from either RPC or broadcast. */
export function projectDialogTurnRecovered(
  context: FlowChatContext,
  outcome: RecoverInterruptedDialogTurnResponse,
): boolean {
  const { sessionId, turnId, executionGeneration } = outcome;
  const currentTurn = context.flowChatStore
    .getState()
    .sessions.get(sessionId)
    ?.dialogTurns.find(turn => turn.id === turnId);
  const recovery = currentTurn?.recovery;
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  const isMonotonicRecovery = session?.dialogTurns.at(-1)?.id === turnId
    && currentTurn?.status === 'cancelled'
    && currentTurn.finishReason === 'interrupted'
    && recovery?.status === 'interrupted'
    && executionGeneration === recovery.executionGeneration + 1;
  if (!isMonotonicRecovery) {
    log.debug('Ignoring non-monotonic DialogTurnRecovered', {
      sessionId,
      turnId,
      executionGeneration,
      currentGeneration: recovery?.executionGeneration,
      recoveryStatus: recovery?.status,
    });
    return false;
  }

  context.handledTerminalTurnEvents.delete(`${sessionId}:${turnId}`);
  context.contentBuffers.set(sessionId, new Map());
  context.activeTextItems.set(sessionId, new Map());
  context.flowChatStore.updateDialogTurn(sessionId, turnId, turn => ({
    ...turn,
    status: 'processing' as const,
    finishReason: undefined,
    endTime: undefined,
    success: undefined,
    hasFinalResponse: undefined,
    recoveryEpoch: executionGeneration,
    recovery: {
      ...turn.recovery,
      status: 'recovering' as const,
      executionGeneration,
      resumeCount: executionGeneration,
    },
  }));

  const machine = stateMachineManager.get(sessionId);
  if (machine) {
    const machineContext = machine.getContext();
    machineContext.taskId = sessionId;
    machineContext.currentDialogTurnId = turnId;
  }
  if (stateMachineManager.getCurrentState(sessionId) === SessionExecutionState.IDLE) {
    void stateMachineManager
      .transition(sessionId, SessionExecutionEvent.START, {
        taskId: sessionId,
        dialogTurnId: turnId,
      })
      .catch(error => {
        log.error('State machine transition failed on interrupted turn recovery', {
          sessionId,
          turnId,
          error,
        });
      });
  }
  return true;
}
