export type SessionModelSelectionTarget = {
  draft?: import('./sessionDraft').SessionDraft;
  isTransient?: boolean;
  agentBackedTransient?: boolean;
  sessionKind?: string;
  isHistorical?: boolean;
  lastSubmittedMode?: string;
  dialogTurns?: readonly unknown[];
};

/** A side draft has no Runtime child until its first question forks the parent. */
export function isBtwSessionDraft(session: SessionModelSelectionTarget | undefined): boolean {
  return Boolean(session?.sessionKind === 'btw' && !session.isHistorical
    && !session.lastSubmittedMode && session.dialogTurns?.length === 0);
}

/** Whether the visible selector has a real runtime session to update. */
export function shouldSyncSessionModelSelection<T extends SessionModelSelectionTarget>(
  session: T | undefined,
): session is T {
  return Boolean(session && !session.draft && !isBtwSessionDraft(session) && (!session.isTransient || session.agentBackedTransient));
}

/** Whether restoring the target requires access to internal runtime sessions. */
export function shouldIncludeInternalModelSession(
  session: SessionModelSelectionTarget | undefined,
): boolean {
  return Boolean(session?.sessionKind === 'subagent' || session?.agentBackedTransient);
}
