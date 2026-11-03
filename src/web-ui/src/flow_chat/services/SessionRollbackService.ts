import { hostQueueSupported, hostDialogQueue } from './hostDialogQueue';
import { agentAPI } from '@/infrastructure/api';
import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '../store/FlowChatStore';
import { getActiveSurfaceScope, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { finishSubmittedMessagePreview } from './submittedMessagePresentation';
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
  isHostIssuedTurnCatalogRevision,
  resolveMaterializedSessionTurnIdentity,
  resolveStorageTurnIndex,
} from '../utils/flowChatTurnIdentity';
import type { Session, SessionHistoryViewState } from '../types/flow-chat';
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

async function reloadAuthoritativeSession(sessionId: string, scope: SurfaceScope): Promise<void> {
  await flowChatStore.loadSessionHistory(sessionId, {
    deferFullHistoryUntilActive: true,
  });
  scope.assertCurrent('finish rollback history reload');
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
  if (
    !catalog
    || catalog.sessionId !== session.sessionId
    || !isHostIssuedTurnCatalogRevision(catalog.revision)
  ) {
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

function projectedRollbackTurnIds(
  session: Session,
  historyView: SessionHistoryViewState | undefined,
  targetTurnId: string,
  boundaryStorageTurnIndex: number | undefined,
): Set<string> {
  const ids = new Set([targetTurnId]);
  if (boundaryStorageTurnIndex === undefined) return ids;
  for (const turn of [
    ...session.dialogTurns,
    ...(historyView?.loadedRanges.flatMap(range => range.turns) ?? []),
  ]) {
    const index = resolveStorageTurnIndex(session, turn);
    if (index !== undefined && index >= boundaryStorageTurnIndex) ids.add(turn.id);
  }
  for (const catalog of [session.turnCatalog, historyView?.catalog]) {
    if (catalog?.sessionId !== session.sessionId) continue;
    for (const entry of catalog.entries) {
      if (entry.turnId && entry.storageTurnIndex >= boundaryStorageTurnIndex) ids.add(entry.turnId);
    }
  }
  return ids;
}

export async function rollbackSessionToTurn(
  request: RollbackSessionToTurnRequest,
): Promise<RollbackSessionToTurnResult> {
  const scope = getActiveSurfaceScope();
  if (resolveSessionDriverId(request.sessionId, flowChatStore.getState().sessions.get(request.sessionId)) === 'dispatch') {
    throw new Error('History rollback is unavailable for a detached remote session.');
  }
  if (hostQueueSupported(request.sessionId)) {
    const queue = await hostDialogQueue(request.sessionId).refresh();
    scope.assertCurrent('check rollback queue');
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
    const historyView = flowChatStore.getSessionHistoryViewState(request.sessionId);
    const target = resolveMaterializedSessionTurnIdentity(
      session,
      historyView,
      request.targetTurnId,
    );
    if (!target) {
      throw new Error('Rollback target is no longer available');
    }
    const expectedStorageTurnIndex = target.storageTurnIndex;
    const expectedCatalogRevision = validProjectedCatalogRevision(session, target.catalog);
    const fromTurnIndex = target.ordinal
      ?? session.dialogTurns.findIndex(turn => turn.id === request.targetTurnId);
    // Capture identities before the RPC. Older peers omit retiredTurnIds or
    // report only active/queued Turns; a completed targeted rollback still
    // confirms that this already-observed suffix is no longer visible.
    // Do not collect by storage index after the await: an edit may reuse it.
    const retiredTurnIds = projectedRollbackTurnIds(
      session, historyView, request.targetTurnId, expectedStorageTurnIndex,
    );

    const workspaceId = session.workspaceId ?? session.config.workspaceId;
    if (!workspaceId) throw new Error('Session workspace ID is unavailable; reload the workspace catalog');
    const outcome = await agentAPI.rollbackSessionToTurn({
      workspaceId,
      sessionId: request.sessionId,
      targetTurnId: request.targetTurnId,
      expectedStorageTurnIndex,
      expectedCatalogRevision,
    });
    scope.assertCurrent('apply session rollback');
    if (outcome.status === 'recovery_required') {
      refreshFiles(outcome.affectedFiles);
      requireSessionMutationReconciliation(lease, outcome.reason);
      await reloadAuthoritativeSession(request.sessionId, scope);
      throw new Error(`Rollback requires recovery: ${outcome.reason}`);
    }

    outcome.retiredTurnIds.forEach(turnId => retiredTurnIds.add(turnId));
    markSessionTurnsRetired(request.sessionId, retiredTurnIds);
    // A device surface renders a host replica that reloading does not rewrite.
    flowChatStore.retireRelaySessionTurns(request.sessionId, [...retiredTurnIds]);
    // A send preview renders whenever its Turn is absent; never let a retired
    // Turn's preview stand in for it.
    retiredTurnIds.forEach(turnId => (
      finishSubmittedMessagePreview(scope, request.sessionId, turnId)
    ));
    refreshFiles(outcome.restoredFiles);
    try {
      await reloadAuthoritativeSession(request.sessionId, scope);
    } catch (error) {
      if (scope.isCurrent()) {
        requireSessionMutationReconciliation(
          lease,
          error instanceof Error ? error.message : String(error),
        );
      }
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
