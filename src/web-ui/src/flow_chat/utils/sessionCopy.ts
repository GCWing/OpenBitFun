import type { Session } from '../types/flow-chat';

/** Unloaded history is not evidence that a persisted session is empty. */
export function isSessionEmptyForCopy(session: Pick<Session,
  'dialogTurns' | 'draft' | 'historyState' | 'isPartial' | 'persistedTurnCount' | 'totalTurnCount'
>): boolean {
  if (session.draft) return true;
  if (session.dialogTurns.length > 0) return false;
  if (session.totalTurnCount !== undefined) return session.totalTurnCount === 0;
  if (session.historyState === 'ready' && !session.isPartial) return true;
  return session.persistedTurnCount === 0
    || session.historyState === 'new';
}
