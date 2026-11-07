export type SessionModelSelectionTarget = {
  draft?: import('./sessionDraft').SessionDraft;
  isTransient?: boolean;
  agentBackedTransient?: boolean;
  sessionKind?: string;
  parentSessionId?: string;
  isHistorical?: boolean;
  lastSubmittedMode?: string;
  dialogTurns?: readonly unknown[];
};

/** A side draft has no Runtime child until its first question forks the parent. */
export function isBtwSessionDraft(session: SessionModelSelectionTarget | undefined): boolean {
  return Boolean(session?.sessionKind === 'btw' && !session.isHistorical
    && !session.lastSubmittedMode && session.dialogTurns?.length === 0);
}

/** Temporary BTW children execute through their parent until they are saved as a fork. */
export function isBtwParentBackedSession(session: SessionModelSelectionTarget | undefined): boolean {
  return Boolean(session?.sessionKind === 'btw'
    && session.isTransient === true
    && !session.isHistorical
    && session.parentSessionId);
}

/** Whether the visible selector has a real runtime session to update. */
export function shouldSyncSessionModelSelection<T extends SessionModelSelectionTarget>(
  session: T | undefined,
): session is T {
  return Boolean(session && !session.draft && !isBtwSessionDraft(session) && (!session.isTransient || session.agentBackedTransient));
}

export { shouldIncludeInternalSession as shouldIncludeInternalModelSession } from './internalSession';
