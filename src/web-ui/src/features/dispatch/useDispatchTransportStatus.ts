import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { dispatchJobStore, useDispatchJobStore } from './dispatchJobStore';
import { arePendingPermissionsConfirmed } from './dispatchTransport';
import type { DispatchTarget } from './types';
import { isDispatchJobTerminal, isNonLocalDispatchTarget } from './types';

/**
 * What the chat should say about a dispatch job's link to its target, most
 * urgent first. `null` means nothing to report: the target answered recently
 * and no request is waiting on it.
 */
export type DispatchTransportStatusKind =
  | 'stopUnconfirmed'
  | 'notDelivered'
  | 'missingOnTarget'
  | 'unreachable'
  | 'stopping'
  | 'awaitingConfirmation'
  | 'answerSent';

export interface DispatchTransportStatus {
  kind: DispatchTransportStatusKind;
  jobId: string;
  sessionId: string;
  /** Last successful status read in this controller run, if any. */
  lastReachableAt?: number;
  lastTransportError?: string;
  /** Prompts known from the last read that a reply cannot reach yet. */
  unconfirmedPermissionCount: number;
}

/** Pure projection of the observer store; exported for tests. */
export function resolveDispatchTransportStatus(
  jobId: string | undefined,
): DispatchTransportStatus | null {
  if (!jobId) return null;
  const state = dispatchJobStore.getState();
  const job = state.jobs[jobId];
  if (!job) return null;
  const transport = state.transportByJobId[jobId];
  const cancelState = state.cancelStateByJobId[jobId];
  const answered = state.answeredPermissionIdsByJobId[jobId] ?? [];
  const terminal = isDispatchJobTerminal(job.state);
  const unconfirmedPermissionCount = terminal || arePendingPermissionsConfirmed(jobId)
    ? 0
    : (job.pendingPermissions ?? []).length;
  const base = {
    jobId,
    sessionId: job.sessionId,
    lastReachableAt: state.lastReachableAtByJobId[jobId],
    lastTransportError: transport?.lastTransportError,
    unconfirmedPermissionCount,
  };
  if (cancelState === 'unconfirmed') return { ...base, kind: 'stopUnconfirmed' };
  if (transport?.reachability === 'notFound') {
    const unacknowledged = job.state === 'submitting' || job.state === 'submission_unknown';
    return { ...base, kind: unacknowledged ? 'notDelivered' : 'missingOnTarget' };
  }
  if (transport?.reachability === 'unreachable' && !(terminal && job.terminalDrained)) {
    return { ...base, kind: 'unreachable' };
  }
  if (cancelState === 'stopping') return { ...base, kind: 'stopping' };
  if (unconfirmedPermissionCount > 0) return { ...base, kind: 'awaitingConfirmation' };
  if (!terminal && answered.length > 0) return { ...base, kind: 'answerSent' };
  return null;
}

function sameStatus(
  left: DispatchTransportStatus | null,
  right: DispatchTransportStatus | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.jobId === right.jobId
    && left.sessionId === right.sessionId
    && left.lastReachableAt === right.lastReachableAt
    && left.lastTransportError === right.lastTransportError
    && left.unconfirmedPermissionCount === right.unconfirmedPermissionCount;
}

/** Subscribe to the transport status of one job. */
export function useDispatchTransportStatus(
  jobId: string | undefined,
): DispatchTransportStatus | null {
  const [status, setStatus] = useState(() => resolveDispatchTransportStatus(jobId));
  useEffect(() => {
    const update = () => {
      const next = resolveDispatchTransportStatus(jobId);
      setStatus(current => (sameStatus(current, next) ? current : next));
    };
    update();
    return dispatchJobStore.subscribe(update);
  }, [jobId]);
  return status;
}

function sameTarget(left: DispatchTarget | undefined, right: DispatchTarget): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'ssh' && right.kind === 'ssh') {
    return left.connectionId === right.connectionId && left.workspacePath === right.workspacePath;
  }
  if (left.kind === 'device' && right.kind === 'device') {
    return left.deviceId === right.deviceId && left.workspacePath === right.workspacePath;
  }
  return false;
}

/**
 * The job of the active chat session, when that session is a projection on
 * `target`. Used when the host surface does not pass the job id explicitly.
 */
export function useActiveDispatchJobId(target: DispatchTarget): string | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => flowChatStore.subscribe(() => onChange()),
    [],
  );
  const getSnapshot = useCallback(() => {
    if (!isNonLocalDispatchTarget(target)) return undefined;
    const state = flowChatStore.getState();
    const session = state.activeSessionId
      ? state.sessions.get(state.activeSessionId)
      : undefined;
    if (!session || !sameTarget(session.config.dispatchTarget, target)) return undefined;
    return session.config.dispatchJobId?.trim()
      || Object.values(useDispatchJobStore.getState().jobs)
        .find(job => job.sessionId === session.sessionId)?.jobId;
  }, [target]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
