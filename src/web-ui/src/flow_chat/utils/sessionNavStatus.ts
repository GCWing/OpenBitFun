import type { PermissionRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { SessionActivitySummary } from '@/shared/types/session-history';
import type { SessionDriverReachability } from '../session-drivers/types';
import { SessionExecutionState, type SessionStateMachine } from '../state-machine/types';
import type { Session } from '../types/flow-chat';
import { findPendingAskUserQuestion, TRANSIENT_TURN_STATUSES } from './askUserQuestionState';
import { effectiveToolInvocation } from './toolInvocationIdentity';
import { lastUserDialogTurn } from './flowChatTurnIdentity';
import { isTurnAwaitingRecovery } from './interruptedTurnRecovery';

export type SessionNavStatusKind =
  | 'idle' | 'running' | 'approval' | 'input' | 'error' | 'unread'
  | 'paused' | 'stopped' | 'queued' | 'syncing';

export interface SessionNavStatus {
  kind: SessionNavStatusKind;
  pendingCount: number;
}

export interface SessionNavStatusInput {
  session?: Session;
  machine?: SessionStateMachine | null;
  permissions?: readonly PermissionRequest[];
  reachability?: SessionDriverReachability;
  activity?: SessionActivitySummary;
  unavailable?: boolean;
}

const status = (kind: SessionNavStatusKind, pendingCount = 0): SessionNavStatus => ({ kind, pendingCount });
const terminalToolStates = new Set(['completed', 'error', 'cancelled', 'rejected']);

/** A terminal outcome is a notification only while its result is unread. */
function resultNotification(unread: Session['hasUnreadCompletion'], outcome?: string): SessionNavStatus {
  if (!unread) return status('idle');
  if (outcome === 'error') return status('error');
  if (outcome === 'cancelled' || outcome === 'inprogress') return status('stopped');
  return status(unread === 'error' ? 'error' : unread === 'interrupted' ? 'stopped' : 'unread');
}

/** Selection is deliberately absent: a selected session can still need approval. */
export function deriveSessionNavStatus({
  session, machine, permissions = [], reachability, activity, unavailable,
}: SessionNavStatusInput): SessionNavStatus {
  if (!session) return status('idle');
  if (unavailable) return status('syncing');
  const latestTurn = lastUserDialogTurn(session);
  const trackedId = machine?.context.currentDialogTurnId;
  const turn = trackedId && latestTurn?.id !== trackedId
    ? session.dialogTurns.find(candidate => candidate.id === trackedId) ?? latestTurn
    : latestTurn;
  const dispatchState = session.config.dispatchJobState;
  const executing = machine?.currentState === SessionExecutionState.PROCESSING
    || machine?.currentState === SessionExecutionState.FINISHING
    || Boolean(turn && TRANSIENT_TURN_STATUSES.has(turn.status));

  // A delivered mailbox is authoritative even before the matching turn has
  // hydrated. Only discard requests contradicted by their own settled owner.
  const pending = permissions.filter(request => {
    if (request.sessionId !== session.sessionId
      && request.delegation?.parentSessionId !== session.sessionId) return false;
    const parentTurnId = request.delegation?.parentSessionId === session.sessionId
      ? request.delegation.parentDialogTurnId : undefined;
    const owner = parentTurnId
      ? session.dialogTurns.find(candidate => candidate.id === parentTurnId)
      : session.dialogTurns.find(candidate => candidate.modelRounds.some(round => round.id === request.roundId));
    if (owner && !TRANSIENT_TURN_STATUSES.has(owner.status)) return false;
    return !request.toolCallId || !owner?.modelRounds.some(round => round.items.some(item =>
      item.type === 'tool' && (item.id === request.toolCallId || item.toolCall?.id === request.toolCallId)
        && terminalToolStates.has(item.status)));
  });
  if (pending.length > 0) return status('approval', new Set(pending.map(request => request.requestId)).size);

  // An unopened Session has no transcript/state-machine projection. The host
  // summary also corrects old hydrated history after a reconnect or restart.
  if (activity && activity.execution !== 'external') {
    if (activity.pendingApprovals > 0) return status('approval', activity.pendingApprovals);
    if (activity.pendingQuestions > 0) return status('input');
    if (activity.execution === 'running') {
      if (turn?.id === activity.activeTurnId && findPendingAskUserQuestion(turn)) return status('input');
      return status('running');
    }
    if (activity.execution === 'queued') return status('queued');
    if (activity.execution !== 'idle' && activity.execution !== 'error') return status('syncing');

    // A local submission enters PROCESSING before the host accepts its Turn.
    // A read issued in that gap may still describe the preceding idle result.
    // Protect only this pending Turn, not an old processing transcript; a host
    // result for this same Turn and local failure/cancellation remain authoritative.
    if (machine?.currentState === SessionExecutionState.PROCESSING
      && trackedId === turn?.id && turn?.status === 'pending'
      && activity.lastTurn?.turnId !== turn.id) return status('running');

    // Idle/error settle execution; neither says whether the result was read.
    // Only a resumable checkpoint remains visible after acknowledgement. Old
    // summaries may borrow that fact from the matching hydrated user Turn.
    const last = activity.lastTurn;
    const historyTurn = !last || (last.turnId === latestTurn?.id && last.status === latestTurn.status
      && (last.executionGeneration === undefined
        || last.executionGeneration === (latestTurn.recovery?.executionGeneration ?? latestTurn.recoveryEpoch)))
      ? latestTurn : undefined;
    if (last?.recoveryPending ?? isTurnAwaitingRecovery(historyTurn)) return status('paused');
    return resultNotification(activity.unreadCompletion, last?.status ?? historyTurn?.status);
  }

  // Legacy/ACP tool confirmations and questions remain readable without a
  // native mailbox. Completed turns never resurrect their old pending flags.
  if (turn && TRANSIENT_TURN_STATUSES.has(turn.status)) {
    const confirmations = turn.modelRounds.flatMap(round => round.items).filter(item => {
      if (item.type !== 'tool' || item.status !== 'pending_confirmation') return false;
      return effectiveToolInvocation(item.toolName, item.toolCall?.input).toolName !== 'AskUserQuestion';
    });
    if (confirmations.length > 0) return status('approval', confirmations.length);
    if (findPendingAskUserQuestion(turn)) return status('input');
  } else if (!turn && session.needsUserAttention) {
    return status(session.needsUserAttention === 'tool_confirm' ? 'approval' : 'input',
      session.needsUserAttention === 'tool_confirm' ? 1 : 0);
  }

  if (reachability === 'unreachable' || dispatchState === 'submission_unknown') return status('syncing');
  if (dispatchState === 'submitting' || dispatchState === 'queued') return status('queued');
  if (executing || dispatchState === 'running') return status('running');
  if (isTurnAwaitingRecovery(latestTurn)) return status('paused');
  const outcome = dispatchState === 'failed' ? 'error'
    : dispatchState === 'cancelled' ? 'cancelled' : latestTurn?.status;
  return resultNotification(session.hasUnreadCompletion, outcome);
}
