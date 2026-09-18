/**
 * Tool event handling module
 * Handles various tool lifecycle events
 */

import { FlowChatStore } from '../../store/FlowChatStore';
import { extractFilePathFromJsonBuffer, parsePartialJson, splitFilePathAndContent } from '../../../shared/utils/partialJsonParser';
import { createLogger } from '@/shared/utils/logger';
import type { FlowChatContext, FlowToolItem, ToolEventOptions, DialogTurn, ModelRound } from './types';
import { immediateSaveDialogTurn } from './PersistenceModule';
import { applyPendingAcpPermissionForTool } from './AcpPermissionToolCardModule';
import { normalizeParamsPartialFragment } from '../EventBatcher';
import { effectiveToolInvocation } from '../../utils/toolInvocationIdentity';
import { requestRuntimeProjectionRepair } from './PeerSessionRefreshModule';
import type {
  CancelledToolEvent,
  CompletedToolEvent,
  ConfirmationNeededToolEvent,
  EarlyDetectedToolEvent,
  FailedToolEvent,
  FlowToolEvent,
  ParamsPartialToolEvent,
  ProgressToolEvent,
  QueuedToolEvent,
  RejectedToolEvent,
  StartedToolEvent,
  WaitingToolEvent,
} from '../EventBatcher';

const log = createLogger('ToolEventModule');
const pendingTerminalSessionIds = new Map<string, string>();
const TERMINAL_TOOL_STATUSES = new Set<FlowToolItem['status']>([
  'completed',
  'error',
  'cancelled',
  'rejected',
]);

function isTerminalToolStatus(status: FlowToolItem['status'] | undefined): boolean {
  return status !== undefined && TERMINAL_TOOL_STATUSES.has(status);
}

function resolveToolRoundId(dialogTurn: DialogTurn, roundId: string): string | undefined {
  if (dialogTurn.modelRounds.some(round => round.id === roundId)) {
    return roundId;
  }
  return dialogTurn.modelRounds.at(-1)?.id;
}

function ensureToolRoundId(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  dialogTurn: DialogTurn,
  roundId: string,
): string | undefined {
  if (dialogTurn.modelRounds.some(round => round.id === roundId)) {
    return roundId;
  }
  if (roundId) {
    const created: ModelRound = {
      id: roundId,
      index: dialogTurn.modelRounds.length,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: Date.now(),
    };
    store.addModelRound(sessionId, turnId, created);
    return roundId;
  }
  return resolveToolRoundId(dialogTurn, roundId);
}

function applyToolItemUpdateOrInsert(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  dialogTurn: DialogTurn,
  roundId: string,
  toolId: string,
  updates: Record<string, unknown>,
  createItem: () => FlowToolItem,
): void {
  if (store.findToolItem(sessionId, turnId, toolId)) {
    if (!store.updateModelRoundItem(sessionId, turnId, toolId, updates as any)) {
      requestRuntimeProjectionRepair(sessionId);
    }
    return;
  }
  const targetRoundId = ensureToolRoundId(store, sessionId, turnId, dialogTurn, roundId);
  if (!targetRoundId) {
    requestRuntimeProjectionRepair(sessionId);
    return;
  }
  store.addModelRoundItem(sessionId, turnId, createItem(), targetRoundId);
}

interface ToolTerminalReadyEvent {
  tool_use_id: string;
  terminal_session_id: string;
}

/**
 * Unified tool event handler
 * Supports both main session and subagent scenarios
 */
export function processToolEvent(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string,
  toolEvent: FlowToolEvent,
  attemptId?: string,
  attemptIndex?: number,
  options?: ToolEventOptions,
  onTodoWriteResult?: (sessionId: string, turnId: string, result: any) => void
): void {
  const store = FlowChatStore.getInstance();
  const state = store.getState();
  const session = state.sessions.get(sessionId);
  
  if (!session) {
    requestRuntimeProjectionRepair(sessionId);
    log.debug('Session not found (processToolEvent)', { sessionId });
    return;
  }

  const dialogTurn = session.dialogTurns.find((turn: DialogTurn) => turn.id === turnId);
  if (!dialogTurn) {
    requestRuntimeProjectionRepair(sessionId);
    log.debug('Dialog turn not found (processToolEvent)', { turnId });
    return;
  }

  reconcileToolEventWireIdentity(store, sessionId, turnId, toolEvent);

  switch (toolEvent.event_type) {
    case 'EarlyDetected': {
      handleEarlyDetected(context, store, sessionId, turnId, roundId, dialogTurn, toolEvent, attemptId, attemptIndex, options);
      break;
    }
    
    case 'ParamsPartial': {
      handleParamsPartial(store, sessionId, turnId, toolEvent);
      break;
    }

    case 'Queued': {
      handleQueued(store, sessionId, turnId, toolEvent);
      break;
    }

    case 'Waiting': {
      handleWaiting(store, sessionId, turnId, toolEvent);
      break;
    }
    
    case 'Started': {
      flushPendingBatchedEvents(context);
      handleStarted(store, sessionId, turnId, roundId, dialogTurn, toolEvent, attemptId, attemptIndex, options);
      break;
    }
    
    case 'Completed': {
      flushPendingBatchedEvents(context);
      handleCompleted(context, store, sessionId, turnId, roundId, dialogTurn, toolEvent, options, onTodoWriteResult);
      break;
    }
    
    case 'Failed': {
      flushPendingBatchedEvents(context);
      handleFailed(context, store, sessionId, turnId, roundId, dialogTurn, toolEvent);
      break;
    }
    
    case 'Cancelled': {
      flushPendingBatchedEvents(context);
      handleCancelled(context, store, sessionId, turnId, roundId, dialogTurn, toolEvent);
      break;
    }

    case 'Rejected': {
      flushPendingBatchedEvents(context);
      handleRejected(context, store, sessionId, turnId, roundId, dialogTurn, toolEvent);
      break;
    }
    
    case 'ConfirmationNeeded': {
      flushPendingBatchedEvents(context);
      handleConfirmationNeeded(store, sessionId, turnId, toolEvent);
      break;
    }
    
    case 'Progress': {
      handleProgress(store, sessionId, turnId, toolEvent);
      break;
    }

    case 'Streaming': {
      const existing = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
      if (isTerminalToolStatus(existing?.status)) {
        break;
      }
      updateToolItem(store, sessionId, turnId, toolEvent.tool_id, {
        status: 'streaming',
        isParamsStreaming: false,
      });
      break;
    }

    case 'Confirmed': {
      updateToolItem(store, sessionId, turnId, toolEvent.tool_id, {
        status: 'confirmed',
        userConfirmed: true,
        requiresConfirmation: false,
      });
      break;
    }

    case 'StreamChunk': {
      break;
    }
    
    default:
      break;
  }

}

function reconcileToolEventWireIdentity(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: FlowToolEvent,
): void {
  const existing = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  if (!existing || existing.type !== 'tool') {
    return;
  }

  const updates: Partial<FlowToolItem> = { toolName: toolEvent.tool_name };
  if (toolEvent.event_type === 'Started' || toolEvent.event_type === 'ConfirmationNeeded') {
    updates.toolCall = {
      input: toolEvent.params,
      id: toolEvent.tool_id,
      ...('timeout_seconds' in toolEvent && typeof toolEvent.timeout_seconds === 'number'
        ? { timeout_seconds: toolEvent.timeout_seconds }
        : {}),
    };
  }
  store.updateModelRoundItem(sessionId, turnId, toolEvent.tool_id, updates);
}

function flushPendingBatchedEvents(context: FlowChatContext): void {
  if (context.eventBatcher.getBufferSize() > 0) {
    context.eventBatcher.flushNow();
  }
}

function updateToolItem(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolId: string,
  updates: Record<string, any>,
  silent = false
): void {
  if (silent) {
    store.updateModelRoundItemSilent(sessionId, turnId, toolId, updates as any);
    return;
  }

  store.updateModelRoundItem(sessionId, turnId, toolId, updates as any);
}

function applyPendingTerminalSessionId(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolId: string,
  silent = false
): void {
  const terminalSessionId = pendingTerminalSessionIds.get(toolId);
  if (!terminalSessionId) {
    return;
  }

  updateToolItem(store, sessionId, turnId, toolId, {
    terminalSessionId,
  }, silent);
  pendingTerminalSessionIds.delete(toolId);
}

function isTodoWriteSuccessResult(result: unknown): result is Record<string, unknown> {
  return typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true;
}

function isWriteLikeToolName(toolName: string): boolean {
  return ['write', 'write_notebook', 'file_write', 'Write'].includes(toolName);
}

function shouldIgnoreParamsPartial(status: FlowToolItem['status'], toolName: string): boolean {
  if (isWriteLikeToolName(toolName)) {
    return ['completed', 'error', 'cancelled', 'rejected', 'pending_confirmation', 'confirmed'].includes(status);
  }

  return ['running', 'completed', 'error', 'cancelled', 'rejected', 'pending_confirmation', 'confirmed'].includes(status);
}

function applyParamsPartial(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: ParamsPartialToolEvent,
  silent = false
): void {
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  
  if (existingItem && existingItem.type === 'tool') {
    const existingToolItem = existingItem as FlowToolItem;
    const prevBuffer = existingToolItem._paramsBuffer || '';
    const currentEffectiveName = effectiveToolInvocation(
      existingToolItem.toolName,
      existingToolItem.toolCall?.input,
    ).toolName;
    if (shouldIgnoreParamsPartial(existingToolItem.status, currentEffectiveName)) {
      return;
    }

    const incomingParams = normalizeParamsPartialFragment(toolEvent.params);
    if (!incomingParams) {
      return;
    }
    const newBuffer = prevBuffer + incomingParams;
    
    let parsedParams: Record<string, any> = {};
    try {
      parsedParams = parsePartialJson(newBuffer);
    } catch {
    }

    const effective = effectiveToolInvocation(toolEvent.tool_name, parsedParams);
    const effectiveToolName = toolEvent.effective_tool_name || effective.toolName;
    const effectiveParams = effective.input && typeof effective.input === 'object'
      ? effective.input as Record<string, any>
      : {};
    const isWriteTool = isWriteLikeToolName(effectiveToolName);

    if (isWriteTool) {
      const combinedParts = splitFilePathAndContent(effectiveParams.payload);
      if (combinedParts) {
        Object.assign(effectiveParams, {
          file_path: combinedParts.filePath,
          content: combinedParts.content,
        });
      } else {
        if (typeof effectiveParams.payload === 'string') {
          effectiveParams.content = effectiveParams.payload;
        }
        const extractedPath = extractFilePathFromJsonBuffer(newBuffer);
        const hasPath = ['file_path', 'filePath', 'filepath', 'target_file', 'targetFile', 'path', 'filename']
          .some((key) => typeof effectiveParams[key] === 'string' && effectiveParams[key].length > 0);
        if (extractedPath && !hasPath) {
          effectiveParams.file_path = extractedPath;
        }
      }
    }
    
    const isEditTool = ['edit', 'search_replace', 'Edit'].includes(effectiveToolName);
    const hasContentField = 'content' in effectiveParams || 'contents' in effectiveParams;
    const hasNewString = 'new_string' in effectiveParams;
    
    let status: 'streaming' | 'receiving' = 'streaming';
    if ((isWriteTool && hasContentField) || (isEditTool && hasNewString)) {
      status = 'receiving';
    }
    
    updateToolItem(store, sessionId, turnId, toolEvent.tool_id, {
      toolName: toolEvent.tool_name,
      toolCall: {
        input: parsedParams,
        id: toolEvent.tool_id
      },
      partialParams: parsedParams,
      _paramsBuffer: newBuffer,
      status,
      isParamsStreaming: true,
      _contentSize: isWriteTool && hasContentField ? ((effectiveParams.content || effectiveParams.contents || '').length) : undefined
    }, silent);
    applyPendingTerminalSessionId(store, sessionId, turnId, toolEvent.tool_id, silent);
    applyPendingAcpPermissionForTool(store, toolEvent.tool_id);
  }
}

function applyProgress(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: ProgressToolEvent,
  silent = false
): void {
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  
  if (existingItem) {
    updateToolItem(store, sessionId, turnId, toolEvent.tool_id, {
      _progressMessage: toolEvent.message,
      _progressPercentage: toolEvent.percentage
    }, silent);
  }
}

export function processToolParamsPartialInternal(
  sessionId: string,
  turnId: string,
  toolEvent: ParamsPartialToolEvent
): void {
  applyParamsPartial(FlowChatStore.getInstance(), sessionId, turnId, toolEvent, false);
}

export function processToolProgressInternal(
  sessionId: string,
  turnId: string,
  toolEvent: ProgressToolEvent
): void {
  applyProgress(FlowChatStore.getInstance(), sessionId, turnId, toolEvent, true);
}

/**
 * Handle tool early detection event
 */
function handleEarlyDetected(
  context: FlowChatContext,
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  roundId: string,
  dialogTurn: DialogTurn,
  toolEvent: EarlyDetectedToolEvent,
  attemptId?: string,
  attemptIndex?: number,
  options?: ToolEventOptions
): void {
  flushPendingBatchedEvents(context);
  
  const preparingToolItem: FlowToolItem = {
    id: toolEvent.tool_id,
    type: 'tool',
    toolName: toolEvent.tool_name,
    toolCall: {
      input: {},
      id: toolEvent.tool_id
    },
    timestamp: options?.parentTimestamp ? options.parentTimestamp + 2 : Date.now(),
    status: 'preparing',
    requiresConfirmation: false,
    isParamsStreaming: true,
    startTime: options?.parentTimestamp ? options.parentTimestamp + 2 : Date.now(),
    attemptId,
    attemptIndex,
  };

  const targetRoundId = ensureToolRoundId(store, sessionId, turnId, dialogTurn, roundId);
  if (!targetRoundId) {
    requestRuntimeProjectionRepair(sessionId);
    log.error('Tool EarlyDetected event references missing round (backend bug)', {
      sessionId,
      turnId,
      roundId,
      toolId: toolEvent.tool_id,
      toolName: toolEvent.tool_name,
    });
    return;
  }

  store.addModelRoundItem(sessionId, turnId, preparingToolItem, targetRoundId);
  applyPendingAcpPermissionForTool(store, toolEvent.tool_id);
}

/**
 * Handle tool params partial update event
 */
function handleParamsPartial(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: ParamsPartialToolEvent
): void {
  applyParamsPartial(store, sessionId, turnId, toolEvent);
}

/**
 * Handle tool queued event
 */
function handleQueued(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: QueuedToolEvent
): void {
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  if (existingItem && existingItem.type === 'tool' && !isTerminalToolStatus(existingItem.status)) {
    updateToolItem(store, sessionId, turnId, toolEvent.tool_id, {
      status: 'queued',
    });
  }
}

/**
 * Handle tool waiting event
 */
function handleWaiting(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: WaitingToolEvent
): void {
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  if (existingItem && existingItem.type === 'tool' && !isTerminalToolStatus(existingItem.status)) {
    updateToolItem(store, sessionId, turnId, toolEvent.tool_id, {
      status: 'waiting',
    });
  }
}

/**
 * Handle tool started event
 */
function handleStarted(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  roundId: string,
  dialogTurn: DialogTurn,
  toolEvent: StartedToolEvent,
  attemptId?: string,
  attemptIndex?: number,
  options?: ToolEventOptions
): void {
  const existingItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  
  const toolCallData = {
    input: toolEvent.params,
    id: toolEvent.tool_id,
    ...(typeof toolEvent.timeout_seconds === 'number' && {
      timeout_seconds: toolEvent.timeout_seconds
    })
  };

  if (existingItem) {
    const keepTerminalStatus = isTerminalToolStatus(existingItem.status);
    store.updateModelRoundItem(sessionId, turnId, toolEvent.tool_id, {
      toolName: toolEvent.tool_name,
      toolCall: toolCallData,
      ...(keepTerminalStatus
        ? {}
        : {
            status: 'running',
            isParamsStreaming: false,
            partialParams: undefined,
          }),
      attemptId,
      attemptIndex,
    } as any);
    applyPendingTerminalSessionId(store, sessionId, turnId, toolEvent.tool_id);
    applyPendingAcpPermissionForTool(store, toolEvent.tool_id);
  } else {
    const toolItem: FlowToolItem = {
      id: toolEvent.tool_id,
      type: 'tool',
      toolName: toolEvent.tool_name,
      terminalSessionId: pendingTerminalSessionIds.get(toolEvent.tool_id),
      toolCall: toolCallData,
      timestamp: options?.parentTimestamp ? options.parentTimestamp + 2 : Date.now(),
      status: 'running',
      requiresConfirmation: false,
      startTime: options?.parentTimestamp ? options.parentTimestamp + 2 : Date.now(),
      attemptId,
      attemptIndex,
    };

    const targetRoundId = ensureToolRoundId(store, sessionId, turnId, dialogTurn, roundId);
    if (targetRoundId) {
      store.addModelRoundItem(sessionId, turnId, toolItem, targetRoundId);
      pendingTerminalSessionIds.delete(toolEvent.tool_id);
      applyPendingAcpPermissionForTool(store, toolEvent.tool_id);
    } else {
      requestRuntimeProjectionRepair(sessionId);
      log.error('Tool Started event references missing round (backend bug)', {
        sessionId,
        turnId,
        roundId,
        toolId: toolEvent.tool_id,
        toolName: toolEvent.tool_name
      });
    }
  }
}

/**
 * Handle tool execution completed event
 */
function handleCompleted(
  context: FlowChatContext,
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  roundId: string,
  dialogTurn: DialogTurn,
  toolEvent: CompletedToolEvent,
  options?: ToolEventOptions,
  onTodoWriteResult?: (sessionId: string, turnId: string, result: any) => void
): void {
  const effectiveToolName = toolEvent.effective_tool_name || toolEvent.tool_name;
  if (!options?.isSubagent && effectiveToolName === 'TodoWrite' && isTodoWriteSuccessResult(toolEvent.result)) {
    onTodoWriteResult?.(sessionId, turnId, toolEvent.result);
  }
  
  const updates = {
    toolResult: {
      result: toolEvent.result,
      success: true,
      resultForAssistant: toolEvent.result_for_assistant,
      imageAttachments: toolEvent.image_attachments,
      duration_ms: toolEvent.duration_ms
    },
    status: 'completed' as const,
    requiresConfirmation: false,
    acpPermission: undefined,
    isParamsStreaming: false,
    endTime: Date.now(),
    durationMs: toolEvent.duration_ms,
    queueWaitMs: toolEvent.queue_wait_ms,
    preflightMs: toolEvent.preflight_ms,
    confirmationWaitMs: toolEvent.confirmation_wait_ms,
    executionMs: toolEvent.execution_ms
  };

  applyToolItemUpdateOrInsert(
    store,
    sessionId,
    turnId,
    dialogTurn,
    roundId,
    toolEvent.tool_id,
    updates,
    () => ({
      id: toolEvent.tool_id,
      type: 'tool',
      toolName: toolEvent.tool_name,
      toolCall: {
        input: {},
        id: toolEvent.tool_id,
      },
      timestamp: Date.now(),
      ...updates,
    }),
  );

  store.clearSessionNeedsAttention(sessionId);

  immediateSaveDialogTurn(context, sessionId, turnId);
}

/**
 * Handle tool execution failed event
 */
function handleFailed(
  context: FlowChatContext,
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  roundId: string,
  dialogTurn: DialogTurn,
  toolEvent: FailedToolEvent
): void {
  const updates = {
    toolResult: {
      result: toolEvent.error_detail
        ? { error: toolEvent.error, error_detail: toolEvent.error_detail }
        : null,
      success: false,
      error: toolEvent.error,
      duration_ms: toolEvent.duration_ms
    },
    status: 'error' as const,
    requiresConfirmation: false,
    acpPermission: undefined,
    endTime: Date.now(),
    durationMs: toolEvent.duration_ms,
    queueWaitMs: toolEvent.queue_wait_ms,
    preflightMs: toolEvent.preflight_ms,
    confirmationWaitMs: toolEvent.confirmation_wait_ms,
    executionMs: toolEvent.execution_ms
  };

  applyToolItemUpdateOrInsert(
    store,
    sessionId,
    turnId,
    dialogTurn,
    roundId,
    toolEvent.tool_id,
    updates,
    () => ({
      id: toolEvent.tool_id,
      type: 'tool',
      toolName: toolEvent.tool_name,
      toolCall: {
        input: {},
        id: toolEvent.tool_id,
      },
      timestamp: Date.now(),
      ...updates,
    }),
  );

  store.clearSessionNeedsAttention(sessionId);

  immediateSaveDialogTurn(context, sessionId, turnId);
}

/**
 * Handle tool cancelled event
 */
function handleCancelled(
  context: FlowChatContext,
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  roundId: string,
  dialogTurn: DialogTurn,
  toolEvent: CancelledToolEvent
): void {
  const existingToolItem = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  const currentStatus = existingToolItem?.status;
  // Annotated so the literal type does not widen to `string` when it lands in
  // the mutable `updates` object below, which the insert factory then has to
  // satisfy as a `FlowToolItem`.
  const finalStatus: FlowToolItem['status'] =
    currentStatus === 'confirmed' ? 'confirmed' : 'cancelled';

  const updates = {
    toolResult: {
      result: null,
      success: false,
      error: toolEvent.reason || 'User cancelled operation',
      duration_ms: toolEvent.duration_ms
    },
    status: finalStatus,
    requiresConfirmation: false,
    acpPermission: undefined,
    endTime: Date.now(),
    durationMs: toolEvent.duration_ms,
    queueWaitMs: toolEvent.queue_wait_ms,
    preflightMs: toolEvent.preflight_ms,
    confirmationWaitMs: toolEvent.confirmation_wait_ms,
    executionMs: toolEvent.execution_ms
  };

  applyToolItemUpdateOrInsert(
    store,
    sessionId,
    turnId,
    dialogTurn,
    roundId,
    toolEvent.tool_id,
    updates,
    () => ({
      id: toolEvent.tool_id,
      type: 'tool',
      toolName: toolEvent.tool_name,
      toolCall: {
        input: {},
        id: toolEvent.tool_id,
      },
      timestamp: Date.now(),
      ...updates,
    }),
  );

  store.clearSessionNeedsAttention(sessionId);

  immediateSaveDialogTurn(context, sessionId, turnId);
}

/**
 * Handle tool rejected event
 */
function handleRejected(
  context: FlowChatContext,
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  roundId: string,
  dialogTurn: DialogTurn,
  toolEvent: RejectedToolEvent
): void {
  const updates = {
    toolResult: {
      result: null,
      success: false,
      error: 'User rejected operation',
    },
    status: 'rejected' as const,
    userConfirmed: false,
    requiresConfirmation: false,
    acpPermission: undefined,
    isParamsStreaming: false,
    endTime: Date.now(),
  };

  applyToolItemUpdateOrInsert(
    store,
    sessionId,
    turnId,
    dialogTurn,
    roundId,
    toolEvent.tool_id,
    updates,
    () => ({
      id: toolEvent.tool_id,
      type: 'tool',
      toolName: toolEvent.tool_name,
      toolCall: {
        input: {},
        id: toolEvent.tool_id,
      },
      timestamp: Date.now(),
      ...updates,
    }),
  );

  store.clearSessionNeedsAttention(sessionId);

  immediateSaveDialogTurn(context, sessionId, turnId);
}

/**
 * Handle tool confirmation needed event
 */
function handleConfirmationNeeded(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: ConfirmationNeededToolEvent
): void {
  const existing = store.findToolItem(sessionId, turnId, toolEvent.tool_id);
  if (isTerminalToolStatus(existing?.status)) {
    return;
  }

  store.updateModelRoundItem(sessionId, turnId, toolEvent.tool_id, {
    toolName: toolEvent.tool_name,
    toolCall: {
      input: toolEvent.params,
      id: toolEvent.tool_id,
    },
    requiresConfirmation: true,
    status: 'pending_confirmation',
  } as any);

  const state = store.getState();
  const activeSessionId = state.activeSessionId;
  if (sessionId !== activeSessionId) {
    const attentionKind = toolEvent.tool_name === 'AskUserQuestion' ? 'ask_user' : 'tool_confirm';
    store.setSessionNeedsAttention(sessionId, attentionKind);
  }
}

/**
 * Handle tool execution progress event
 */
function handleProgress(
  store: FlowChatStore,
  sessionId: string,
  turnId: string,
  toolEvent: ProgressToolEvent
): void {
  applyProgress(store, sessionId, turnId, toolEvent);
}

/**
 * Handle backend independent tool execution progress event
 */
export function handleToolExecutionProgress(
  event: any
): void {
  const eventData = (event as any).value || event;
  const { tool_use_id, tool_name, progress_message, percentage } = eventData;

  const store = FlowChatStore.getInstance();
  const state = store.getState();
  
  let found = false;
  
  for (const [sessionId, session] of state.sessions) {
    for (const dialogTurn of session.dialogTurns) {
      const toolItem = store.findToolItem(sessionId, dialogTurn.id, tool_use_id);
      
      if (toolItem) {
        const existingLogs: string[] = Array.isArray((toolItem as any)._progressLogs)
          ? (toolItem as any)._progressLogs
          : [];
        const lastLog = existingLogs.length > 0 ? existingLogs[existingLogs.length - 1] : undefined;
        const isTerminalLikeProgress =
          tool_name === 'ExecCommand' ||
          tool_name === 'WriteStdin' ||
          tool_name === 'ExecControl' ||
          (toolItem as any).toolName === 'ExecCommand' ||
          (toolItem as any).toolName === 'WriteStdin' ||
          (toolItem as any).toolName === 'ExecControl';
        const shouldAppend = typeof progress_message === 'string' && (
          isTerminalLikeProgress
            ? progress_message.length > 0
            : progress_message.trim().length > 0 && progress_message !== lastLog
        );
        const nextLogs = shouldAppend ? [...existingLogs, progress_message].slice(-200) : existingLogs;

        store.updateModelRoundItem(sessionId, dialogTurn.id, tool_use_id, {
          _progressMessage: progress_message,
          _progressPercentage: percentage,
          _progressLogs: nextLogs
        } as any);
        
        found = true;
        break;
      }
    }
    if (found) break;
  }
  
  if (!found) {
    log.debug('Tool item not found', { tool_use_id });
  }
}

export function handleToolTerminalReady(
  event: ToolTerminalReadyEvent
): void {
  const { tool_use_id, terminal_session_id } = event;
  if (!tool_use_id || !terminal_session_id) {
    return;
  }

  const store = FlowChatStore.getInstance();
  const state = store.getState();

  for (const [sessionId, session] of state.sessions) {
    for (const dialogTurn of session.dialogTurns) {
      const toolItem = store.findToolItem(sessionId, dialogTurn.id, tool_use_id);
      if (!toolItem) {
        continue;
      }

      store.updateModelRoundItem(sessionId, dialogTurn.id, tool_use_id, {
        terminalSessionId: terminal_session_id,
      } as any);
      pendingTerminalSessionIds.delete(tool_use_id);
      return;
    }
  }

  pendingTerminalSessionIds.set(tool_use_id, terminal_session_id);
  log.debug('Cached terminal session for pending tool item', {
    toolUseId: tool_use_id,
    terminalSessionId: terminal_session_id,
  });
}
