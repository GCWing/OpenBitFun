import { createLogger } from '@/shared/utils/logger';
import { elapsedMs, nowMs, roundDurationMs } from '@/shared/utils/timing';

const log = createLogger('HistorySessionDiagnostics');

const RECENT_EVENT_LIMIT = 30;
const WARN_EVENT_LIMIT = 15;
const MAX_SESSION_DIAGNOSTICS = 50;

export type HistorySessionDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | HistorySessionDiagnosticValue[]
  | { [key: string]: HistorySessionDiagnosticValue };

export type HistorySessionDiagnosticData = Record<string, HistorySessionDiagnosticValue>;

interface HistorySessionDiagnosticEvent {
  event: string;
  ageMs: number;
  data?: HistorySessionDiagnosticData;
}

interface HistorySessionDiagnosticState {
  diagnosticId: string;
  sessionId: string;
  startedAtMs: number;
  events: HistorySessionDiagnosticEvent[];
  pendingHydrateStartedAtMs?: number;
  pendingHydrateData?: HistorySessionDiagnosticData;
  stalledWarned: boolean;
  pagingRefusalWarned: boolean;
  lastPagingFailureKey?: string;
}

export interface HistorySessionLoadingStallSnapshot extends HistorySessionDiagnosticData {
  durationMs: number;
  historyState?: string;
  isHistorical?: boolean;
  isRemote?: boolean;
  activeSessionIdMatches?: boolean;
  hasRenderableContent?: boolean;
  dialogTurnCount?: number;
}

/**
 * State captured when the transcript declines to page older Turns even though
 * the session still reports unloaded ones.
 *
 * Every way this can fail — a precondition miss, a cancelled viewport
 * preparation, a spurious `exhausted` that latches the direction off — looks
 * identical in the UI to "there is no more history": the boundary status
 * returns to idle and no indicator is shown. The trail is the only way to tell
 * them apart after the fact, which matters because the failure is intermittent.
 */
export interface HistoryPagingRefusalSnapshot extends HistorySessionDiagnosticData {
  direction: string;
  reason: string;
  isPartial?: boolean;
  latchedExhausted?: boolean;
  loadedTurnCount?: number;
  totalTurnCount?: number;
  targetOrdinal?: number;
}

const diagnosticsBySession = new Map<string, HistorySessionDiagnosticState>();
let diagnosticSequence = 0;

function trimOldDiagnostics(): void {
  while (diagnosticsBySession.size > MAX_SESSION_DIAGNOSTICS) {
    const oldestSessionId = diagnosticsBySession.keys().next().value;
    if (!oldestSessionId) {
      return;
    }
    diagnosticsBySession.delete(oldestSessionId);
  }
}

function createDiagnosticId(sessionId: string): string {
  diagnosticSequence += 1;
  const prefix = sessionId.slice(0, 8) || 'session';
  return `${prefix}-${Math.round(nowMs())}-${diagnosticSequence}`;
}

function getOrCreateDiagnostic(sessionId: string): HistorySessionDiagnosticState {
  const existing = diagnosticsBySession.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: HistorySessionDiagnosticState = {
    diagnosticId: createDiagnosticId(sessionId),
    sessionId,
    startedAtMs: nowMs(),
    events: [],
    stalledWarned: false,
    pagingRefusalWarned: false,
  };
  diagnosticsBySession.set(sessionId, created);
  trimOldDiagnostics();
  return created;
}

function pushEvent(
  state: HistorySessionDiagnosticState,
  event: string,
  data?: HistorySessionDiagnosticData,
  options?: { logEvent?: boolean },
): void {
  const record: HistorySessionDiagnosticEvent = {
    event,
    ageMs: elapsedMs(state.startedAtMs),
    ...(data ? { data } : {}),
  };

  state.events.push(record);
  if (state.events.length > RECENT_EVENT_LIMIT) {
    state.events.splice(0, state.events.length - RECENT_EVENT_LIMIT);
  }

  if (options?.logEvent !== false) {
    log.debug('Historical session diagnostic event', {
      diagnosticId: state.diagnosticId,
      sessionId: state.sessionId,
      event,
      ageMs: record.ageMs,
      ...(data ?? {}),
    });
  }
}

function summarizeEvents(state: HistorySessionDiagnosticState): HistorySessionDiagnosticEvent[] {
  return state.events.slice(-WARN_EVENT_LIMIT).map(event => ({
    event: event.event,
    ageMs: event.ageMs,
    ...(event.data ? { data: event.data } : {}),
  }));
}

function findLastEvent(
  state: HistorySessionDiagnosticState,
  predicate: (event: HistorySessionDiagnosticEvent) => boolean,
): HistorySessionDiagnosticEvent | undefined {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (predicate(event)) {
      return event;
    }
  }
  return undefined;
}

export function beginHistorySessionDiagnostics(
  sessionId: string,
  event: string,
  data?: HistorySessionDiagnosticData,
): string {
  const state: HistorySessionDiagnosticState = {
    diagnosticId: createDiagnosticId(sessionId),
    sessionId,
    startedAtMs: nowMs(),
    events: [],
    stalledWarned: false,
    pagingRefusalWarned: false,
  };
  diagnosticsBySession.set(sessionId, state);
  trimOldDiagnostics();
  pushEvent(state, event, data);
  return state.diagnosticId;
}

export function recordHistorySessionDiagnosticEvent(
  sessionId: string,
  event: string,
  data?: HistorySessionDiagnosticData,
  options?: { logEvent?: boolean },
): void {
  pushEvent(getOrCreateDiagnostic(sessionId), event, data, options);
}

export function markHistorySessionHydratePending(
  sessionId: string,
  data?: HistorySessionDiagnosticData,
): void {
  const state = getOrCreateDiagnostic(sessionId);
  state.pendingHydrateStartedAtMs = nowMs();
  state.pendingHydrateData = data;
  pushEvent(state, 'hydrate_pending_started', data);
}

export function clearHistorySessionHydratePending(
  sessionId: string,
  outcome: string,
  data?: HistorySessionDiagnosticData,
): void {
  const state = getOrCreateDiagnostic(sessionId);
  const pendingHydrateAgeMs = state.pendingHydrateStartedAtMs !== undefined
    ? elapsedMs(state.pendingHydrateStartedAtMs)
    : undefined;
  pushEvent(state, 'hydrate_pending_settled', {
    outcome,
    pendingHydrateAgeMs,
    ...(data ?? {}),
  });
  state.pendingHydrateStartedAtMs = undefined;
  state.pendingHydrateData = undefined;
}

export function warnHistorySessionLoadingLayerStalled(
  sessionId: string,
  snapshot: HistorySessionLoadingStallSnapshot,
): void {
  const state = getOrCreateDiagnostic(sessionId);
  if (state.stalledWarned) {
    return;
  }

  state.stalledWarned = true;
  pushEvent(state, 'loading_layer_stalled', snapshot, { logEvent: false });

  const lastHydrateEvent = findLastEvent(state, event => event.event.includes('hydrate'));
  const lastStoreEvent = findLastEvent(state, event => event.event.startsWith('store_'));
  const pendingHydrateAgeMs = state.pendingHydrateStartedAtMs !== undefined
    ? roundDurationMs(nowMs() - state.pendingHydrateStartedAtMs)
    : undefined;

  log.warn('Historical session loading layer stalled', {
    diagnosticId: state.diagnosticId,
    sessionId,
    ...snapshot,
  });
  log.warn('Historical session hydrate state at stall', {
    diagnosticId: state.diagnosticId,
    sessionId,
    hasPendingHydrate: state.pendingHydrateStartedAtMs !== undefined,
    pendingHydrateAgeMs,
    pendingHydrateData: state.pendingHydrateData,
    lastHydrateEvent: lastHydrateEvent?.event,
    lastStoreEvent: lastStoreEvent?.event,
    lastHydrateData: lastHydrateEvent?.data,
    lastStoreData: lastStoreEvent?.data,
  });
  log.warn('Historical session recent lifecycle events', {
    diagnosticId: state.diagnosticId,
    sessionId,
    events: summarizeEvents(state),
  });
}

export function resetHistorySessionDiagnosticsForTests(): void {
  diagnosticsBySession.clear();
  diagnosticSequence = 0;
}

/**
 * Record one step of the older-history paging handshake.
 *
 * Keep a bounded in-memory trail for the refusal warning without logging
 * every paging step.
 */
export function recordHistoryPagingEvent(
  sessionId: string,
  event: string,
  data?: HistorySessionDiagnosticData,
): void {
  const state = getOrCreateDiagnostic(sessionId);
  pushEvent(state, `history_paging_${event}`, data, { logEvent: false });
  if (event === 'outcome_not_ready') {
    const key = JSON.stringify([data?.direction, data?.reason, data?.targetOrdinal]);
    if (state.lastPagingFailureKey !== key) {
      state.lastPagingFailureKey = key;
      log.warn('FlowChat history paging did not become ready', { sessionId, diagnosticId: state.diagnosticId, ...(data ?? {}) });
    }
  } else if (event === 'outcome_applied' || event === 'outcome_exhausted') {
    state.lastPagingFailureKey = undefined;
  }
}

/**
 * Report that older Turns were not loaded although the session still has some,
 * together with the trail that led there. Warns once per session so a user
 * scrolling repeatedly against a dead boundary does not flood the log.
 */
export function warnHistoryPagingRefusedWithPendingTurns(
  sessionId: string,
  snapshot: HistoryPagingRefusalSnapshot,
): void {
  const state = getOrCreateDiagnostic(sessionId);
  if (state.pagingRefusalWarned) {
    return;
  }

  state.pagingRefusalWarned = true;
  pushEvent(state, 'history_paging_refused_with_pending_turns', snapshot, { logEvent: false });

  const lastOutcome = findLastEvent(state, event => event.event.startsWith('history_paging_outcome'));
  const lastRequest = findLastEvent(state, event => event.event.startsWith('history_paging_requested'));

  log.warn('FlowChat declined to page older Turns while the session reports more', {
    diagnosticId: state.diagnosticId,
    sessionId,
    ...snapshot,
    lastOutcome: lastOutcome?.event,
    lastOutcomeData: lastOutcome?.data,
    lastRequestData: lastRequest?.data,
  });
  log.warn('FlowChat history paging trail', {
    diagnosticId: state.diagnosticId,
    sessionId,
    events: summarizeEvents(state),
  });
}
