interface ComposerSubmissionClearActions {
  clearValue: () => void;
  clearContexts: () => void;
  clearPendingLargePastes: () => void;
  clearQueuedInput: () => void;
}

/**
 * Clear every user-visible part of a submitted composer before transport work
 * begins. Keeping these mutations in one synchronous call prevents React from
 * painting a text-only or attachment-only intermediate draft.
 */
export function clearComposerForSubmission(
  actions: ComposerSubmissionClearActions,
): void {
  actions.clearValue();
  actions.clearContexts();
  actions.clearPendingLargePastes();
  actions.clearQueuedInput();
}

export function failedSubmissionRecoveryTarget(
  submissionSessionId: string | null,
  currentSessionId: string | null,
  submissionRevision: number,
  currentRevision: number,
): 'current' | 'stored' | 'none' {
  if (submissionSessionId === currentSessionId) {
    return submissionRevision === currentRevision ? 'current' : 'none';
  }
  return submissionSessionId && submissionRevision === currentRevision ? 'stored' : 'none';
}

export function shouldRecordContextMutation(
  contextsChanged: boolean,
  isRestoringSessionDraft: boolean,
): boolean {
  return contextsChanged && !isRestoringSessionDraft;
}

interface CommandTurnIdentity {
  id: string;
  kind?: string;
}

/**
 * Whether the host admitted a manual compaction for a command submission.
 *
 * A command that failed before admission never produced a turn, so its text is
 * still a retryable draft. Once the maintenance turn exists the outcome already
 * reached the transcript - and the compaction may even have been applied before
 * its terminal bookkeeping failed - so refilling the composer would resurrect
 * the submitted command long after the fact.
 */
export function manualCompactionTurnStarted(
  knownTurnIds: ReadonlySet<string>,
  turns: readonly CommandTurnIdentity[],
): boolean {
  return turns.some(turn => turn.kind === 'manual_compaction' && !knownTurnIds.has(turn.id));
}

export function successfulRetryCleanupTarget(
  submissionSessionId: string,
  currentSessionId: string | null,
  baselineRevision: number,
  currentRevision: number,
  currentMessage: string,
  currentContextIds: string[],
  submittedMessage: string,
  submittedContextIds: string[],
): 'current' | 'stored' | 'none' {
  const composerIsUnchanged =
    baselineRevision === currentRevision
    && currentMessage.trim() === submittedMessage.trim()
    && currentContextIds.length === submittedContextIds.length
    && currentContextIds.every((id, index) => id === submittedContextIds[index]);

  if (!composerIsUnchanged) return 'none';
  return currentSessionId === submissionSessionId ? 'current' : 'stored';
}
