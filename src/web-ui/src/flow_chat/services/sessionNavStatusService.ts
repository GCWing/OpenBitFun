import { installTrayUnreadService } from './trayUnreadService';
import { agentAPI, type AgenticEvent, type PermissionRequest } from '@/infrastructure/api/service-api/AgentAPI';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceId, getActiveSurfaceScope, onSurfaceActivated, surfaceIdForDevice, type DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { observeSurfaceEvents } from '@/infrastructure/peer-device/deviceSurfaceRouting';
import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '../store/FlowChatStore';
import { sessionActivityStore } from '../store/sessionActivityStore';
import { stateMachineManager } from '../state-machine';
import { SessionExecutionState } from '../state-machine/types';
import { driverForSession, sessionDriverNavigationStatusSources } from '../session-drivers/registry';
import { deriveSessionNavStatus, type SessionNavStatus } from '../utils/sessionNavStatus';
import { SessionNavOrdering } from '../utils/sessionNavOrdering';
import type { Session } from '../types/flow-chat';
import { ensureActivePermissionMailbox, liveSessionInteractionStore } from './liveSessionInteractionStore';
import { SessionActivitySync, type ActivityTarget } from './sessionActivitySync';

const log = createLogger('SessionNavStatus');
const RECONCILE_INTERVAL_MS = 15_000;
const SETTLED_RECONCILE_INTERVAL_MS = 60_000;
const IDLE: SessionNavStatus = { kind: 'idle', pendingCount: 0 };
const rows = new Map<string, { listeners: Set<() => void>; status: SessionNavStatus }>();
const ordering = new SessionNavOrdering();
const orderingListeners = new Set<() => void>();
let orderingRevision = 0;
const failed = new Set<string>();
const unsupported = new Set<string>();
let permissionSource: readonly PermissionRequest[] | undefined;
let permissionsBySession = new Map<string, PermissionRequest[]>();
let cleanup: (() => void) | undefined;
let requestRefresh: ((sessionId: string, force?: boolean) => void) | undefined;

function publishOrdering(): void {
  orderingRevision++;
  for (const notify of orderingListeners) notify();
}

function indexPermissions(): void {
  const mailbox = liveSessionInteractionStore.getActiveSnapshot().requests;
  if (permissionSource !== mailbox) {
    permissionSource = mailbox;
    permissionsBySession = new Map();
    for (const request of mailbox) {
      for (const owner of new Set([request.sessionId, request.delegation?.parentSessionId])) {
        if (!owner) continue;
        const group = permissionsBySession.get(owner) ?? [];
        group.push(request);
        permissionsBySession.set(owner, group);
      }
    }
  }
}

function publish(sessionId: string): void {
  const row = rows.get(sessionId);
  const surfaceId = getActiveSurfaceId();
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session && ordering.delete(surfaceId, sessionId)) publishOrdering();
  if (!session && !row) return;
  const driver = driverForSession(sessionId, session);
  const source = driver.permissionRequestSource(sessionId);
  const navigationStatus = driver.navigationStatusSource?.getSnapshot(sessionId);
  indexPermissions();
  const jobId = session?.config.dispatchJobId;
  const activity = jobId ? undefined : sessionActivityStore.get(sessionId);
  const next = deriveSessionNavStatus({
    session, machine: stateMachineManager.getSnapshot(sessionId), activity: activity?.summary,
    unavailable: !jobId && (failed.has(sessionId) || (unsupported.has(sessionId) && !activity?.summary
      && session?.historyState === 'metadata-only' && !session.hasUnreadCompletion && !session.needsUserAttention)),
    permissions: source === 'live' ? permissionsBySession.get(sessionId) ?? []
      : source.getSnapshot() as readonly PermissionRequest[],
    reachability: navigationStatus?.reachability,
  });
  if (session && ordering.observe(surfaceId, session, next)) publishOrdering();
  if (!row) return;
  if (row.status.kind === next.kind && row.status.pendingCount === next.pendingCount) return;
  row.status = next;
  for (const notify of row.listeners) notify();
}

function targetFor(sessionId: string): ActivityTarget | undefined {
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session || session.isTransient || session.config.dispatchJobId) return;
  const workspaceId = session.projectWorkspaceId || session.workspaceId || session.config.workspaceId;
  if (!workspaceId) return;
  return { sessionId, workspaceId };
}

/** Installed for the FlowChat lifetime, with one subscription per source. */
export function installSessionNavStatusService(): () => void {
  if (cleanup) return () => {};
  let disposed = false;
  const unavailable = unsupported;
  const retry = new Map<string, { attempts: number; at: number }>();
  const sync = new SessionActivitySync(async targets => {
    targets = targets.filter(target => rows.has(target.sessionId)
      && JSON.stringify(targetFor(target.sessionId)) === JSON.stringify(target));
    if (!targets.length) return;
    const scope = getActiveSurfaceScope();
    const read = sessionActivityStore.beginRead(scope.surfaceId);
    try {
      const page = await sessionAPI.listSessionsPage({
        ...targets[0], limit: 1, sessionIds: targets.map(target => target.sessionId),
      });
      if (disposed || !scope.isCurrent()) return;
      if (page.activities) {
        const returned = new Set(page.activities.map(summary => summary.sessionId));
        for (const target of targets) {
          if (returned.has(target.sessionId)) failed.delete(target.sessionId);
          else failed.add(target.sessionId);
        }
        sessionActivityStore.applyRead(read, page.activities);
        for (const target of targets) {
          unavailable.delete(target.sessionId);
          if (!returned.has(target.sessionId)) {
            retry.set(target.sessionId, { attempts: 1, at: Date.now() + SETTLED_RECONCILE_INTERVAL_MS });
            publish(target.sessionId);
            continue;
          }
          retry.delete(target.sessionId);
          // Requeue only a genuine event/read race, not missing/unsupported data.
          const entry = sessionActivityStore.get(target.sessionId);
          if (entry?.stale && entry.eventVersion > read.eventVersion) sync.request(target);
          publish(target.sessionId);
        }
      } else {
        // Older hosts retain their existing event/metadata projection. An
        // absent extension is never permission to read the controller's data.
        for (const target of targets) { unavailable.add(target.sessionId); publish(target.sessionId); }
        log.debug('Host does not provide session activity summaries', { surfaceId: scope.surfaceId });
      }
    } catch (error) {
      if (!disposed && scope.isCurrent()) {
        for (const target of targets) {
          const attempts = (retry.get(target.sessionId)?.attempts ?? 0) + 1;
          retry.set(target.sessionId, { attempts, at: Date.now() + Math.min(60_000, 15_000 * 2 ** Math.min(attempts - 1, 2)) });
          failed.add(target.sessionId);
          publish(target.sessionId);
        }
        log.warn('Failed to reconcile navigation activity', { count: targets.length, error });
      }
    }
  });
  const refresh = (sessionId: string, force = false) => {
    if (!rows.has(sessionId) || unavailable.has(sessionId)) return;
    if (!force && (retry.get(sessionId)?.at ?? 0) > Date.now()) return;
    const target = targetFor(sessionId);
    if (!target) return;
    const entry = sessionActivityStore.get(sessionId);
    const busy = entry?.summary?.execution === 'running' || entry?.summary?.execution === 'queued'
      || (entry?.summary?.pendingApprovals ?? 0) > 0 || (entry?.summary?.pendingQuestions ?? 0) > 0;
    const interval = busy ? RECONCILE_INTERVAL_MS : SETTLED_RECONCILE_INTERVAL_MS;
    if (force || !entry || entry.stale || Date.now() - entry.checkedAt >= interval) sync.request(target);
  };
  requestRefresh = refresh;

  // Events arrive even when no Session scene is open. The routed observer also
  // retains background peer facts; the API listeners cover WebSocket hosts.
  const observed = new WeakSet<object>();
  const events: Array<[string, (callback: (event: AgenticEvent) => void) => () => void]> = [
    ['agentic://session-state-changed', callback => agentAPI.onSessionStateChanged(callback)],
    ['agentic://session-history-changed', callback => agentAPI.onSessionHistoryChanged(callback)],
    ['agentic://session-deleted', callback => agentAPI.onSessionDeleted(callback)],
    ['agentic://dialog-turn-started', callback => agentAPI.onDialogTurnStarted(callback)],
    ['agentic://dialog-turn-completed', callback => agentAPI.onDialogTurnCompleted(callback)],
    ['agentic://dialog-turn-failed', callback => agentAPI.onDialogTurnFailed(callback)],
    ['agentic://dialog-turn-cancelled', callback => agentAPI.onDialogTurnCancelled(callback)],
    ['agentic://dialog-turn-interrupted', callback => agentAPI.onDialogTurnInterrupted(callback)],
    ['agentic://dialog-turn-recovered', callback => agentAPI.onDialogTurnRecovered(callback)],
    ['agentic://tool-event', callback => agentAPI.onToolEvent(callback)],
  ];
  const eventNames = new Set(events.map(([name]) => name));
  const disposeTrayUnread = installTrayUnreadService();
  const disposers = events.map(([name, listen]) => listen(event => {
    if (observed.delete(event)) return;
    sessionActivityStore.observe(getActiveSurfaceId(), name, event);
  }));
  disposers.push(observeSurfaceEvents((name, deviceId, payload) => {
    if (!eventNames.has(name)) return;
    if (payload && typeof payload === 'object') observed.add(payload);
    sessionActivityStore.observe(surfaceIdForDevice(deviceId), name, payload);
  }));
  disposers.push(sessionActivityStore.subscribe((surfaceId, sessionId) => {
    const summary = sessionActivityStore.get(sessionId, surfaceId)?.summary;
    if (surfaceId !== getActiveSurfaceId()) {
      const session = ordering.get(surfaceId, sessionId)?.session;
      if (session && summary && !session.config.dispatchJobId) {
        ordering.observe(surfaceId, session, deriveSessionNavStatus({ session, activity: summary }));
      }
      return;
    }
    if (summary) flowChatStore.applySessionActivityReceipt(summary);
    publish(sessionId);
    refresh(sessionId);
  }));
  disposers.push(flowChatStore.subscribe(state => {
    const surfaceId = getActiveSurfaceId();
    for (const sessionId of ordering.sessionIds(surfaceId)) {
      if (!state.sessions.has(sessionId)) publish(sessionId);
    }
    for (const [sessionId, session] of state.sessions) {
      const prior = ordering.get(surfaceId, sessionId)?.session;
      if (prior === session) continue;
      publish(sessionId);
      if (prior?.needsUserAttention !== session?.needsUserAttention) {
        sessionActivityStore.invalidate(sessionId);
      }
      if (!prior && session) refresh(sessionId);
    }
  }));
  const machineTurns = new Map<string, string>();
  disposers.push(stateMachineManager.subscribeGlobal((sessionId, machine) => {
    const identity = `${getActiveSurfaceId()}:${machine.currentState}:${machine.context.currentDialogTurnId}`;
    if (machineTurns.get(sessionId) === identity) return;
    machineTurns.set(sessionId, identity);
    if (machine.currentState === SessionExecutionState.PROCESSING) {
      // A local start is not a host acknowledgement. Refresh the host facts;
      // navigation projects the pending local Turn until those facts catch up.
      sessionActivityStore.invalidate(sessionId);
    }
    publish(sessionId);
  }));
  let priorPermissions = permissionsBySession;
  disposers.push(liveSessionInteractionStore.subscribe(() => {
    indexPermissions();
    const previous = priorPermissions;
    priorPermissions = permissionsBySession;
    if (previous === permissionsBySession) return;
    for (const sessionId of new Set([...previous.keys(), ...permissionsBySession.keys()])) {
      const before = previous.get(sessionId) ?? [];
      const after = permissionsBySession.get(sessionId) ?? [];
      if (before.length === after.length && before.every((request, i) => request === after[i])) continue;
      publish(sessionId);
      refresh(sessionId, true);
    }
  }));
  for (const source of sessionDriverNavigationStatusSources()) {
    disposers.push(source.subscribe(() => {
      for (const [sessionId, session] of flowChatStore.getState().sessions) {
        if (driverForSession(sessionId, session).navigationStatusSource === source) publish(sessionId);
      }
    }));
  }
  const refreshAll = (force = true) => {
    if (!rows.size) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    for (const sessionId of rows.keys()) refresh(sessionId, force);
    void ensureActivePermissionMailbox(true);
  };
  disposers.push(onSurfaceActivated(() => {
    sync.clear();
    unavailable.clear();
    failed.clear();
    retry.clear();
    machineTurns.clear();
    for (const sessionId of new Set([...rows.keys(), ...flowChatStore.getState().sessions.keys()])) publish(sessionId);
    publishOrdering();
    refreshAll();
  }));
  const interval = setInterval(() => refreshAll(false), RECONCILE_INTERVAL_MS);
  const wake = () => {
    // A host may have restarted/upgraded while this surface was disconnected.
    unavailable.clear();
    refreshAll();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('peer-mode:changed', wake);
    document.addEventListener('visibilitychange', wake);
  }
  void ensureActivePermissionMailbox();
  for (const sessionId of flowChatStore.getState().sessions.keys()) publish(sessionId);
  for (const sessionId of rows.keys()) { publish(sessionId); refresh(sessionId); }
  cleanup = () => {
    disposed = true;
    disposeTrayUnread();
    sync.dispose();
    clearInterval(interval);
    disposers.forEach(dispose => dispose());
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('peer-mode:changed', wake);
      document.removeEventListener('visibilitychange', wake);
    }
    requestRefresh = undefined;
    failed.clear();
    unsupported.clear();
    permissionSource = undefined;
    permissionsBySession.clear();
    ordering.clear();
    cleanup = undefined;
  };
  return cleanup;
}

export const sessionNavStatusService = {
  clearSurface(surfaceId: DeviceSurfaceId): void {
    ordering.clearSurface(surfaceId);
    if (surfaceId === getActiveSurfaceId()) publishOrdering();
  },
  getOrderingSnapshot: (): number => orderingRevision,
  subscribeOrdering(notify: () => void): () => void {
    orderingListeners.add(notify);
    return () => { orderingListeners.delete(notify); };
  },
  getSortTimestamp: (session: Session): number => ordering.get(getActiveSurfaceId(), session.sessionId)?.sortTimestamp
    ?? session.lastFinishedAt ?? session.createdAt,
  isRunning: (sessionId: string): boolean => ordering.get(getActiveSurfaceId(), sessionId)?.status.kind === 'running',
  getSnapshot: (sessionId: string): SessionNavStatus => rows.get(sessionId)?.status ?? IDLE,
  subscribe(sessionId: string, notify: () => void): () => void {
    let row = rows.get(sessionId);
    if (!row) {
      row = { listeners: new Set(), status: IDLE };
      rows.set(sessionId, row);
    }
    row.listeners.add(notify);
    publish(sessionId);
    requestRefresh?.(sessionId);
    return () => {
      row.listeners.delete(notify);
      if (!row.listeners.size) rows.delete(sessionId);
    };
  },
};
