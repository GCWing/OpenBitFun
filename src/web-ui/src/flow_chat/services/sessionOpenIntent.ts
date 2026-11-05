import type { Session } from '../types/flow-chat';
import {
  beginHistorySessionDiagnostics,
  recordHistorySessionDiagnosticEvent,
} from './historySessionDiagnostics';

export const HISTORY_SESSION_OPEN_INTENT_EVENT = 'flowchat:history-session-open-intent';
export const SESSION_LOADING_DELAY_MS = 200;
const RECENT_HISTORY_OPEN_INTENT_MS = 750;
const HISTORY_SESSION_OPEN_TRANSITION_MAX_MS = 4_000;

let recentHistoryOpenIntent: { sessionId: string; atMs: number } | null = null;
let activeHistorySessionOpenTransition: HistorySessionOpenTransitionSnapshot | null = null;
let activeHistorySessionOpenTransitionTimer: ReturnType<typeof setTimeout> | null = null;
const transitionListeners = new Set<() => void>();

export interface HistorySessionOpenIntentDetail {
  sessionId: string;
  sessionTitle?: string;
  /** How long the overlay may wait; a cross-device open first renders another device. */
  maxMs?: number;
}

export interface HistorySessionOpenTransitionSnapshot {
  sessionId: string;
  atMs: number;
  sessionTitle?: string;
  maxMs: number;
}

const nowMs = (): number => (
  typeof performance !== 'undefined' ? performance.now() : Date.now()
);

export function hasRenderableSessionContent(session: Session): boolean {
  return session.dialogTurns.some(turn =>
    Boolean(turn.userMessage) ||
    (turn.status === 'image_analyzing' && turn.modelRounds.length === 0) ||
    turn.modelRounds.some(round => round.items.length > 0)
  );
}

function notifyHistorySessionOpenTransitionListeners(): void {
  for (const listener of transitionListeners) {
    listener();
  }
}

function clearHistorySessionOpenTransitionTimer(): void {
  if (activeHistorySessionOpenTransitionTimer !== null) {
    clearTimeout(activeHistorySessionOpenTransitionTimer);
    activeHistorySessionOpenTransitionTimer = null;
  }
}

export function shouldShowHistorySessionOpenIntent(
  session: Session | null | undefined,
  options?: { isRunning?: boolean }
): boolean {
  if (!session) {
    return false;
  }

  if (options?.isRunning === true || hasRenderableSessionContent(session)) {
    return false;
  }

  if (
    session.isHistorical ||
    session.historyState === 'metadata-only' ||
    session.historyState === 'hydrating' ||
    session.historyState === 'failed'
  ) {
    return true;
  }

  return session.historyState === 'ready' && session.contextRestoreState === 'pending';
}

export function dispatchHistorySessionOpenIntent(
  sessionId: string,
  sessionTitle?: string,
  maxMs = HISTORY_SESSION_OPEN_TRANSITION_MAX_MS,
): void {
  const atMs = nowMs();
  beginHistorySessionDiagnostics(sessionId, 'history_open_intent_dispatched');
  recentHistoryOpenIntent = {
    sessionId,
    atMs,
  };
  activeHistorySessionOpenTransition = { sessionId, atMs, sessionTitle, maxMs };
  clearHistorySessionOpenTransitionTimer();
  activeHistorySessionOpenTransitionTimer = setTimeout(() => {
    if (
      activeHistorySessionOpenTransition?.sessionId === sessionId &&
      activeHistorySessionOpenTransition.atMs === atMs
    ) {
      recordHistorySessionDiagnosticEvent(sessionId, 'history_open_transition_expired', {
        durationMs: maxMs,
      });
      activeHistorySessionOpenTransition = null;
      activeHistorySessionOpenTransitionTimer = null;
      notifyHistorySessionOpenTransitionListeners();
    }
  }, maxMs);
  notifyHistorySessionOpenTransitionListeners();

  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent<HistorySessionOpenIntentDetail>(
    HISTORY_SESSION_OPEN_INTENT_EVENT,
    { detail: { sessionId, sessionTitle, maxMs } },
  ));
}

export function consumeRecentHistorySessionOpenIntent(sessionId: string): boolean {
  const recent = recentHistoryOpenIntent;
  if (!recent || recent.sessionId !== sessionId) {
    return false;
  }

  const now = nowMs();
  recentHistoryOpenIntent = null;
  const ageMs = Math.round(now - recent.atMs);
  const consumed = ageMs <= RECENT_HISTORY_OPEN_INTENT_MS;
  recordHistorySessionDiagnosticEvent(sessionId, consumed
    ? 'history_open_intent_consumed'
    : 'history_open_intent_expired', {
    ageMs,
    maxAgeMs: RECENT_HISTORY_OPEN_INTENT_MS,
  });
  return consumed;
}

export function clearRecentHistorySessionOpenIntent(sessionId?: string): void {
  if (!sessionId || recentHistoryOpenIntent?.sessionId === sessionId) {
    recentHistoryOpenIntent = null;
  }
}

export function getHistorySessionOpenTransitionSnapshot(): HistorySessionOpenTransitionSnapshot | null {
  const transition = activeHistorySessionOpenTransition;
  if (!transition) {
    return null;
  }

  if (nowMs() - transition.atMs > transition.maxMs) {
    return null;
  }

  return transition;
}

export function clearHistorySessionOpenTransition(sessionId?: string): void {
  if (!sessionId || activeHistorySessionOpenTransition?.sessionId === sessionId) {
    if (activeHistorySessionOpenTransition) {
      recordHistorySessionDiagnosticEvent(
        activeHistorySessionOpenTransition.sessionId,
        'history_open_transition_cleared',
      );
    }
    activeHistorySessionOpenTransition = null;
    clearHistorySessionOpenTransitionTimer();
    notifyHistorySessionOpenTransitionListeners();
  }
}

export function subscribeHistorySessionOpenTransition(listener: () => void): () => void {
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}
