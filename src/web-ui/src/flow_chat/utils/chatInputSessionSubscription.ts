import type { Session } from '../types/flow-chat';
import { sessionWorktreeBindingSubscriptionKey } from './sessionWorktree';

/**
 * Render-relevant Session facts consumed directly by ChatInput.
 *
 * Keep this key in sync with the component's render reads. Mode changes and
 * in-place interruption/recovery must invalidate the snapshot even though the
 * Session id and Turn count stay unchanged. Streamed content is not a composer
 * input and must not invalidate it on every chunk.
 */
export function chatInputSessionSubscriptionKey(session: Session): string {
  const latestTurn = session.dialogTurns.at(-1);
  const recoveryFacts = JSON.stringify([
    session.sessionKind,
    session.subagentType,
    session.status,
    session.persistedStatus,
    session.hasUnreadCompletion,
    session.config.agentType,
    session.config.modelName,
    session.config.remoteConnectionId,
    session.config.remoteSshHost,
    session.config.dispatchJobId,
    session.threadGoal?.status,
    latestTurn?.id,
    latestTurn?.agentType,
    latestTurn?.status,
    latestTurn?.finishReason,
    latestTurn?.recovery?.status,
    latestTurn?.recovery?.executionGeneration,
    latestTurn?.recovery?.modelId,
  ]);
  return (
    `${session.sessionId}|${session.mode ?? ''}|${session.title ?? ''}|${session.workspacePath ?? ''}|` +
    `${session.remoteConnectionId ?? ''}|${session.remoteSshHost ?? ''}|${session.lastSubmittedMode ?? ''}|` +
    `${session.currentAcpContextUsage?.used ?? ''}|${session.currentAcpContextUsage?.size ?? ''}|` +
    `${session.currentTokenUsage?.inputTokens ?? ''}|${session.maxContextTokens ?? ''}|` +
    `${session.needsUserAttention ? '1' : '0'}|${session.dialogTurns.length}|` +
    `${session.totalTurnCount ?? ''}|${session.turnCatalog?.totalTurnCount ?? ''}|` +
    `${JSON.stringify(session.config.dispatchTarget ?? null)}|` +
    `${session.config.dispatchApprovalPolicy ?? ''}|${session.config.dispatchJobState ?? ''}|` +
    `${sessionWorktreeBindingSubscriptionKey(session)}|${recoveryFacts}`
  );
}
