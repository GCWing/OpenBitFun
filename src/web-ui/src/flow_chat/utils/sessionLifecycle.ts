import type { Session } from '../types/flow-chat';
import { isProjectedSessionEmpty } from './flowChatTurnIdentity';

type SessionStartFacts = Pick<Session,
  'sessionId' | 'dialogTurns' | 'isPartial' | 'totalTurnCount' | 'turnCatalog' | 'lastSubmittedMode'>;

/** Accepted submissions remain a lifecycle fact even after all turns are rolled back. */
export function hasSessionStarted(session: SessionStartFacts): boolean {
  return Boolean(session.lastSubmittedMode?.trim()) || !isProjectedSessionEmpty(session);
}

/** A metadata-only projection is never proof that a persisted session is empty. */
export function isSessionBindingLocked(
  session: SessionStartFacts & Pick<Session, 'isHistorical' | 'historyState'>,
  submitting = false,
): boolean {
  return submitting || hasSessionStarted(session) || session.isHistorical === true
    || session.historyState === 'metadata-only' || session.historyState === 'hydrating'
    || session.historyState === 'failed';
}
