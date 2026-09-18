import { requireSessionWorkspaceId } from '../../utils/sessionWorkspace';
/**
 * Persistence module
 * Handles persistence operations for dialog turn saving and metadata management
 */

import { createLogger } from '@/shared/utils/logger';
import type { UiSessionMetadataField } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowChatContext, DialogTurn } from './types';
import { buildSessionMetadata } from '../../utils/sessionMetadata';
import { settleInterruptedDialogTurn } from '../../utils/dialogTurnStability';
import {
  DEFERRED_TOOL_GATEWAY_NAME,
  effectiveToolInvocation,
} from '../../utils/toolInvocationIdentity';
import { resolveSessionDriverId } from '../../session-drivers/resolve';
import { resolveStorageTurnIndex } from '../../utils/flowChatTurnIdentity';

const log = createLogger('PersistenceModule');
const COALESCED_IMMEDIATE_SAVE_DELAY_MS = 500;

function isTransientSession(session: { isTransient?: boolean } | undefined): boolean {
  return session?.isTransient === true;
}

/**
 * Observer projections are target-owned; the controller must never persist
 * them as local sessions. Uses the driver resolver so a projection whose
 * config is not bound yet (startup race) is still recognized via the
 * observer-store membership signal.
 */
function isObserverOnlyDispatchSession(
  sessionId: string,
  session: Parameters<typeof resolveSessionDriverId>[1],
): boolean {
  return resolveSessionDriverId(sessionId, session) === 'dispatch';
}

function getDialogTurn(context: FlowChatContext, sessionId: string, turnId: string): DialogTurn | undefined {
  return context.flowChatStore
    .getState()
    .sessions
    .get(sessionId)
    ?.dialogTurns
    .find(turn => turn.id === turnId);
}

function isTerminalDialogTurnStatus(status: DialogTurn['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error';
}

function clearSaveTimer(context: FlowChatContext, key: string): void {
  const existingTimer = context.saveDebouncers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
    context.saveDebouncers.delete(key);
  }
}

async function runSerialDialogTurnSave(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): Promise<void> {
  const key = `${sessionId}:${turnId}`;
  const existingTask = context.turnSaveInFlight.get(key);
  if (existingTask) {
    context.turnSavePending.add(key);
    await existingTask;
    return;
  }

  const task = (async () => {
    try {
      do {
        context.turnSavePending.delete(key);
        await performSaveDialogTurnToDisk(context, sessionId, turnId);
      } while (context.turnSavePending.has(key));
    } finally {
      context.turnSaveInFlight.delete(key);
      context.turnSavePending.delete(key);
    }
  })();

  context.turnSaveInFlight.set(key, task);
  await task;
}

/**
 * Calculate content hash for dialog turn (for deduplication)
 */
export function calculateTurnHash(dialogTurn: DialogTurn): string {
  const keyData = JSON.stringify({
    status: dialogTurn.status,
    roundsCount: dialogTurn.modelRounds.length,
    lastRoundData: dialogTurn.modelRounds[dialogTurn.modelRounds.length - 1]
      ? {
          ...dialogTurn.modelRounds[dialogTurn.modelRounds.length - 1],
          items: dialogTurn.modelRounds[dialogTurn.modelRounds.length - 1].items,
        }
      : null,
    error: dialogTurn.error,
    endTime: dialogTurn.endTime,
    tokenUsage: dialogTurn.tokenUsage,
  });
  
  let hash = 0;
  for (let i = 0; i < keyData.length; i++) {
    const char = keyData.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Coalesce frequent dialog-turn updates into periodic latest-state saves.
 *
 * This intentionally behaves like a trailing throttle, not a pure debounce:
 * continuous model output must still reach persistence so Peer Device
 * snapshot recovery can advance while a turn is running.
 */
export function debouncedSaveDialogTurn(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  delay: number = 2000
): void {
  const key = `${sessionId}:${turnId}`;
  
  const existingTimer = context.saveDebouncers.get(key);
  if (existingTimer) {
    return;
  }
  
  const timer = setTimeout(() => {
    context.saveDebouncers.delete(key);
    saveDialogTurnToDisk(context, sessionId, turnId).catch(error => {
      log.warn('Coalesced checkpoint save failed', { sessionId, turnId, error });
    });
  }, delay);
  
  context.saveDebouncers.set(key, timer);
}

/**
 * Immediately save dialog turn (skip debounce)
 * Used for critical moments like round completion, tool execution completion, etc.
 */
export function immediateSaveDialogTurn(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  skipDuplicateCheck: boolean = false
): void {
  const key = `${sessionId}:${turnId}`;
  const dialogTurn = getDialogTurn(context, sessionId, turnId);
  
  if (!skipDuplicateCheck) {
    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (session) {
      if (dialogTurn) {
        const currentHash = calculateTurnHash(dialogTurn);
        const lastHash = context.lastSaveHashes.get(key);
        const lastTimestamp = context.lastSaveTimestamps.get(key) || 0;
        const now = Date.now();
        
        if (lastHash === currentHash && (now - lastTimestamp) < 5000) {
          return;
        }
        
        context.lastSaveHashes.set(key, currentHash);
        context.lastSaveTimestamps.set(key, now);
      }
    }
  }

  const shouldFlushImmediately =
    skipDuplicateCheck ||
    !dialogTurn ||
    isTerminalDialogTurnStatus(dialogTurn.status);

  if (shouldFlushImmediately) {
    clearSaveTimer(context, key);
    saveDialogTurnToDisk(context, sessionId, turnId).catch(error => {
      log.warn('Immediate save failed', { sessionId, turnId, error });
    });
    return;
  }

  clearSaveTimer(context, key);
  const timer = setTimeout(() => {
    context.saveDebouncers.delete(key);
    saveDialogTurnToDisk(context, sessionId, turnId).catch(error => {
      log.warn('Coalesced save failed', { sessionId, turnId, error });
    });
  }, COALESCED_IMMEDIATE_SAVE_DELAY_MS);
  context.saveDebouncers.set(key, timer);
}

/**
 * Clean up session save state
 * Called when session or turn is deleted
 */
export function cleanupSaveState(
  context: FlowChatContext,
  sessionId: string,
  turnId?: string
): void {
  if (turnId) {
    const key = `${sessionId}:${turnId}`;
    const timer = context.saveDebouncers.get(key);
    if (timer) {
      clearTimeout(timer);
      context.saveDebouncers.delete(key);
    }
    context.lastSaveTimestamps.delete(key);
    context.lastSaveHashes.delete(key);
    context.turnSavePending.delete(key);
    context.deferredStorageIdentitySaves?.delete(key);
    context.turnSaveInFlight.delete(key);
  } else {
    const keysToDelete = new Set<string>();
    for (const key of context.saveDebouncers.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        const timer = context.saveDebouncers.get(key);
        if (timer) {
          clearTimeout(timer);
        }
        keysToDelete.add(key);
      }
    }
    for (const key of context.lastSaveTimestamps.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.add(key);
      }
    }
    for (const key of context.lastSaveHashes.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.add(key);
      }
    }
    for (const key of context.turnSavePending.values()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.add(key);
      }
    }
    for (const key of context.turnSaveInFlight.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.add(key);
      }
    }
    for (const key of context.deferredStorageIdentitySaves ?? []) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToDelete.add(key);
      }
    }

    keysToDelete.forEach(key => {
      context.saveDebouncers.delete(key);
      context.lastSaveTimestamps.delete(key);
      context.lastSaveHashes.delete(key);
      context.turnSavePending.delete(key);
      context.deferredStorageIdentitySaves?.delete(key);
      context.turnSaveInFlight.delete(key);
    });
  }
}

/**
 * Save dialog turn to disk (FlowChat format → backend format)
 */
export async function saveDialogTurnToDisk(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): Promise<void> {
  clearSaveTimer(context, `${sessionId}:${turnId}`);
  await runSerialDialogTurnSave(context, sessionId, turnId);
}

async function performSaveDialogTurnToDisk(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): Promise<void> {
  try {
    const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');

    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) {
      log.debug('Session not found, skipping save', { sessionId, turnId });
      return;
    }
    if (isTransientSession(session) || isObserverOnlyDispatchSession(sessionId, session)) {
      return;
    }

    
    const dialogTurn = session.dialogTurns.find(turn => turn.id === turnId);
    if (!dialogTurn) {
      log.debug('Dialog turn not found, skipping save', { sessionId, turnId });
      return;
    }
    if (dialogTurn.recovery) {
      // The Runtime owns the durable snapshot and generation CAS for an
      // interrupted/recovered turn. A frontend whole-turn save can otherwise
      // overwrite newly appended rounds or restore stale recovery metadata.
      log.debug('Runtime owns persistence for recoverable dialog turn', {
        sessionId,
        turnId,
        recoveryStatus: dialogTurn.recovery.status,
        executionGeneration: dialogTurn.recovery.executionGeneration,
      });
      return;
    }

    const turnIndex = resolveStorageTurnIndex(session, dialogTurn);
    if (turnIndex === undefined) {
      context.deferredStorageIdentitySaves?.add(`${sessionId}:${turnId}`);
      log.debug('Dialog turn has no storage identity, deferring save', { sessionId, turnId });
      return;
    }
    const turnData = convertDialogTurnToBackendFormat(dialogTurn, turnIndex);
    await sessionAPI.saveSessionTurn(
      turnData,
      requireSessionWorkspaceId(session));
    
    await updateSessionMetadata(context, sessionId);
    
  } catch (error) {
    log.error('Failed to save dialog turn', { sessionId, turnId, error });
  }
}

/**
 * Save all in-progress dialog turns by settling them for persistence.
 * Call only when the app process is about to exit; hiding to tray/dock keeps the
 * app alive and settling here would clear in-memory "active" state (e.g. desktop pet bubbles).
 */
export async function saveAllInProgressTurns(context: FlowChatContext): Promise<void> {
  const state = context.flowChatStore.getState();
  const savePromises: Promise<void>[] = [];
  
  for (const [sessionId, session] of state.sessions.entries()) {
    if (isTransientSession(session) || isObserverOnlyDispatchSession(sessionId, session)) {
      continue;
    }
    const lastTurn = session.dialogTurns[session.dialogTurns.length - 1];
    
    if (lastTurn) {
      const key = `${sessionId}:${lastTurn.id}`;
      const timer = context.saveDebouncers.get(key);
      if (timer) {
        clearTimeout(timer);
        context.saveDebouncers.delete(key);
      }
      
      if (
        lastTurn.status !== 'completed' &&
        lastTurn.status !== 'cancelled' &&
        lastTurn.status !== 'error'
      ) {
        const settledAt = Date.now();
        context.flowChatStore.updateDialogTurn(sessionId, lastTurn.id, turn =>
          settleInterruptedDialogTurn(turn, settledAt, {
            interruptionReason: 'app_restart',
          })
        );

        // An interrupted shutdown still needs a visible-result acknowledgement.
        if (sessionId !== state.activeSessionId) {
          context.flowChatStore.markSessionUnreadCompletion(sessionId, 'interrupted', lastTurn.id);
        }

        savePromises.push(
          saveDialogTurnToDisk(context, sessionId, lastTurn.id).catch(error => {
            log.error('Failed to save in-progress turn', { sessionId, turnId: lastTurn.id, error });
          })
        );

        // Also persist the unread completion metadata
        if (sessionId !== state.activeSessionId) {
          savePromises.push(
            updateSessionMetadata(context, sessionId).catch(error => {
              log.error('Failed to update session metadata for unread completion', { sessionId, error });
            })
          );
        }
      }
    }
  }
  
  await Promise.all(savePromises);
}

/**
 * Convert FlowChat DialogTurn to backend format
 */
export function convertDialogTurnToBackendFormat(dialogTurn: DialogTurn, turnIndex: number): any {
  const userMetadata = dialogTurn.userMessage.metadata
    ? { ...dialogTurn.userMessage.metadata }
    : undefined;
  const mergedUserMetadata =
    dialogTurn.userMessage.images?.length
      ? {
          ...(userMetadata || {}),
          images: dialogTurn.userMessage.images.map(img => ({
            id: img.id,
            name: img.name,
            data_url: img.dataUrl,
            image_path: img.imagePath,
            mime_type: img.mimeType,
          })),
          original_text: dialogTurn.userMessage.content,
        }
      : userMetadata;

  return {
    turnId: dialogTurn.id,
    turnIndex,
    sessionId: dialogTurn.sessionId,
    timestamp: dialogTurn.startTime,
    kind: dialogTurn.kind || 'user_dialog',
    userMessage: {
      id: dialogTurn.userMessage.id,
      content: dialogTurn.userMessage.content,
      timestamp: dialogTurn.userMessage.timestamp,
      metadata: mergedUserMetadata,
    },
    modelRounds: dialogTurn.modelRounds.map((round, roundIndex) => {
      return {
        id: round.id,
        turnId: dialogTurn.id,
        roundIndex,
        roundGroupId: round.roundGroupId,
        timestamp: round.startTime,
        renderHints: round.renderHints,
        textItems: round.items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.type === 'text')
          .map(({ item, index }) => {
            return {
              id: item.id,
              content: (item as any).content || '',
              isStreaming: (item as any).isStreaming || false,
              isMarkdown: (item as any).isMarkdown !== undefined ? (item as any).isMarkdown : true,
              timestamp: item.timestamp,
              status: item.status || 'completed',
              orderIndex: index,
              subagentSessionId: (item as any).subagentSessionId,
              attemptId: item.attemptId,
              attemptIndex: item.attemptIndex,
            };
          }),
        toolItems: round.items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.type === 'tool')
          .map(({ item, index }) => {
            const toolItem = item as any;
            const effective = effectiveToolInvocation(toolItem.toolName, toolItem.toolCall?.input);
            if (
              toolItem.toolName === DEFERRED_TOOL_GATEWAY_NAME
              && toolItem.status === 'completed'
              && !effective.isDeferred
            ) {
              throw new Error(`Completed deferred tool is missing its wire invocation: ${item.id}`);
            }
            return {
              id: item.id,
              toolName: toolItem.toolName || '',
              interruptionReason: toolItem.interruptionReason,
              toolCall: toolItem.toolCall || { input: {}, id: item.id },
              toolResult: toolItem.toolResult,
              aiIntent: toolItem.aiIntent,
              requiresConfirmation: toolItem.requiresConfirmation,
              userConfirmed: toolItem.userConfirmed,
              acpPermission: toolItem.acpPermission,
              startTime: toolItem.startTime || item.timestamp,
              endTime: toolItem.endTime,
              status: item.status || 'completed',
              orderIndex: index,
              subagentSessionId: toolItem.subagentSessionId,
              subagentDialogTurnId: toolItem.subagentDialogTurnId,
              subagentModelId: toolItem.subagentModelId,
              subagentModelDisplayName: toolItem.subagentModelDisplayName,
              attemptId: item.attemptId,
              attemptIndex: item.attemptIndex,
            };
          }),
        thinkingItems: round.items
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.type === 'thinking')
          .map(({ item, index }) => {
            const thinkingItem = item as any;
            return {
              id: item.id,
              content: thinkingItem.content || '',
              isStreaming: thinkingItem.isStreaming || false,
              isCollapsed: thinkingItem.isCollapsed || false,
              timestamp: item.timestamp,
              status: item.status || 'completed',
              orderIndex: index,
              subagentSessionId: thinkingItem.subagentSessionId,
              attemptId: item.attemptId,
              attemptIndex: item.attemptIndex,
            };
          }),
        startTime: round.startTime,
        endTime: round.endTime,
        attemptCount: round.attemptCount,
        attemptDiagnostics: round.attemptDiagnostics,
        status: round.status || 'completed',
      };
    }),
    startTime: dialogTurn.startTime,
    endTime: dialogTurn.endTime,
    tokenUsage: dialogTurn.tokenUsage
      ? {
          inputTokens: dialogTurn.tokenUsage.inputTokens,
          outputTokens: dialogTurn.tokenUsage.outputTokens,
          totalTokens: dialogTurn.tokenUsage.totalTokens,
          timestamp: dialogTurn.tokenUsage.timestamp,
        }
      : undefined,
    finishReason: dialogTurn.finishReason,
    recovery: dialogTurn.recovery,
    recoveryEpoch: dialogTurn.recovery?.executionGeneration ?? dialogTurn.recoveryEpoch,
    hasFinalResponse: dialogTurn.hasFinalResponse,
    error: dialogTurn.error,
    errorDetail: dialogTurn.errorDetail,
    status: dialogTurn.status === 'completed' ? 'completed' : 
            dialogTurn.status === 'error' ? 'error' : 
            dialogTurn.status === 'cancelled' ? 'cancelled' : 'inprogress',
  };
}

/**
 * Update session metadata (lastActiveAt, statistics, etc.)
 * Loads existing metadata first to avoid overwriting correct historical counts
 * when the in-memory dialogTurns only has a partial view (e.g. remote-triggered turns
 * on a persisted session whose full turn history hasn't been loaded yet).
 */
export async function updateSessionMetadata(
  context: FlowChatContext,
  sessionId: string,
  fields?: UiSessionMetadataField[],
): Promise<void> {
  const scope = getActiveSurfaceScope();
  try {
    const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
    if (!scope.isCurrent()) return;

    const session = context.flowChatStore.getState().sessions.get(sessionId);
    if (!session) return;
    if (isTransientSession(session) || isObserverOnlyDispatchSession(sessionId, session)) return;


    let existingMetadata: any = null;
    try {
      if (!fields) {
        existingMetadata = await sessionAPI.loadSessionMetadata(
          sessionId,
          requireSessionWorkspaceId(session));
      }
    } catch {
      // ignore
    }
    if (!scope.isCurrent()) return;

    const metadata = buildSessionMetadata(session, existingMetadata);

    await sessionAPI.saveSessionMetadata(
      metadata,
      requireSessionWorkspaceId(session),
      fields ?? [
        'sessionName',
        'tags',
        'todos',
        'unreadCompletion',
        'needsUserAttention',
        'titleMetadata',
      ]);
  } catch (error) {
    log.warn('Failed to update session metadata', { sessionId, error });
  }
}

/**
 * Update session activity time (used for session switching)
 */
export async function touchSessionActivity(
  sessionId: string,
  workspaceId: string
): Promise<void> {
  try {
    const { sessionAPI } = await import('@/infrastructure/api/service-api/SessionAPI');
    await sessionAPI.touchSessionActivity(
      sessionId,
      workspaceId
    );
  } catch (error) {
    log.debug('Failed to touch session activity', { sessionId, error });
  }
}
