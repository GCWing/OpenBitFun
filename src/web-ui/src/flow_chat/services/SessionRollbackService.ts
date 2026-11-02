import { hostQueueSupported, hostDialogQueue } from './hostDialogQueue';
import { agentAPI } from '@/infrastructure/api';
import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '../store/FlowChatStore';
import {
  assertSessionMutationLease,
  completeSessionMutationReconciliation,
  endSessionMutation,
  markSessionTurnsRetired,
  requireSessionMutationReconciliation,
  tryBeginSessionMutation,
  type SessionMutationLease,
  type SessionMutationKind,
} from '../store/sessionMutationStore';
import {
  resolveMaterializedSessionTurnIdentity,
  resolveStorageTurnIndex,
} from '../utils/flowChatTurnIdentity';
import type { Session } from '../types/flow-chat';
import type { SessionTurnCatalog } from '@/shared/types/session-history';
import { pendingQueueManager } from './flow-chat-manager/PendingQueueModule';
import { resolveSessionDriverId } from '../session-drivers/resolve';
import { SessionExecutionState, stateMachineManager } from '../state-machine';

const log = createLogger('SessionRollbackService');

export interface RollbackSessionToTurnRequest {
  sessionId: string;
  targetTurnId: string;
  kind: SessionMutationKind;
  lease?: SessionMutationLease;
}

export interface RollbackSessionToTurnResult {
  restoredFiles: string[];
  fromTurnIndex: number;
  composerText?: string;
}

async function reloadAuthoritativeSession(sessionId: string): Promise<void> {
  await flowChatStore.loadSessionHistory(sessionId, {
    deferFullHistoryUntilActive: true,
  });
  completeSessionMutationReconciliation(sessionId);
}

function refreshFiles(paths: string[]): void {
  globalEventBus.emit('file-tree:refresh');
  paths.forEach(filePath => globalEventBus.emit('editor:file-changed', { filePath }));
}

function assertSessionIdleForHistoryMutation(sessionId: string): void {
  if (stateMachineManager.getCurrentState(sessionId) !== SessionExecutionState.IDLE) {
    throw new Error('Wait until the Session is idle before changing its history');
  }
  if (pendingQueueManager.list(sessionId).length > 0) {
    throw new Error('Clear the pending message queue before changing Session history');
  }
}

function validProjectedCatalogRevision(
  session: Session,
  catalog: SessionTurnCatalog | undefined,
): string | undefined {
  if (!catalog || catalog.sessionId !== session.sessionId) {
    return undefined;
  }
  const coversProjectedTurns = session.dialogTurns.every((turn) => {
    const storageTurnIndex = resolveStorageTurnIndex(session, turn);
    return storageTurnIndex !== undefined && catalog.entries.some(
      entry => entry.storageTurnIndex === storageTurnIndex && entry.turnId === turn.id,
    );
  });
  return coversProjectedTurns ? catalog.revision : undefined;
}

export async function rollbackSessionToTurn(
  request: RollbackSessionToTurnRequest,
): Promise<RollbackSessionToTurnResult> {
  if (resolveSessionDriverId(request.sessionId, flowChatStore.getState().sessions.get(request.sessionId)) === 'dispatch') {
    throw new Error('History rollback is unavailable for a detached remote session.');
  }
  if (hostQueueSupported(request.sessionId)) {
    const queue = await hostDialogQueue(request.sessionId).refresh();
    if (queue.items.length) throw new Error('Clear the host message queue before changing Session history');
  }
  const lease = request.lease
    ?? tryBeginSessionMutation(request.sessionId, request.kind, request.targetTurnId);
  if (!lease) {
    throw new Error('Another Session history mutation is already in progress');
  }
  if (request.lease) {
    if (
      lease.sessionId !== request.sessionId
      || lease.kind !== request.kind
      || lease.targetTurnId !== request.targetTurnId
    ) {
      throw new Error('Session history mutation lease does not match the rollback request');
    }
    assertSessionMutationLease(lease);
  }
  const releaseLease = request.lease === undefined;

  try {
    assertSessionIdleForHistoryMutation(request.sessionId);
    const session = flowChatStore.getState().sessions.get(request.sessionId);
    if (!session) {
      throw new Error(`Session does not exist: ${request.sessionId}`);
    }
    const target = resolveMaterializedSessionTurnIdentity(
      session,
      flowChatStore.getSessionHistoryViewState(request.sessionId),
      request.targetTurnId,
    );
    if (!target) {
      throw new Error('Rollback target is no longer available');
    }
    const expectedStorageTurnIndex = target.storageTurnIndex;
    const expectedCatalogRevision = validProjectedCatalogRevision(session, target.catalog);
    const fromTurnIndex = target.ordinal
      ?? session.dialogTurns.findIndex(turn => turn.id === request.targetTurnId);

    const workspaceId = session.workspaceId ?? session.config.workspaceId;
    if (!workspaceId) throw new Error('Session workspace ID is unavailable; reload the workspace catalog');
    const outcome = await agentAPI.rollbackSessionToTurn({
      workspaceId,
      sessionId: request.sessionId,
      targetTurnId: request.targetTurnId,
      expectedStorageTurnIndex,
      expectedCatalogRevision,
    });
    if (outcome.status === 'recovery_required') {
      refreshFiles(outcome.affectedFiles);
      requireSessionMutationReconciliation(lease, outcome.reason);
      await reloadAuthoritativeSession(request.sessionId);
      throw new Error(`Rollback requires recovery: ${outcome.reason}`);
    }

    markSessionTurnsRetired(request.sessionId, outcome.retiredTurnIds);
    refreshFiles(outcome.restoredFiles);
    try {
      await reloadAuthoritativeSession(request.sessionId);
    } catch (error) {
      requireSessionMutationReconciliation(
        lease,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return {
      restoredFiles: outcome.restoredFiles,
      fromTurnIndex: Math.max(0, fromTurnIndex),
      composerText: outcome.composer.kind === 'replace' ? outcome.composer.text : undefined,
    };
  } catch (error) {
    log.error('Session rollback failed', {
      sessionId: request.sessionId,
      targetTurnId: request.targetTurnId,
      error,
    });
    throw error;
  } finally {
    if (releaseLease) {
      endSessionMutation(lease);
    }
  }
}
