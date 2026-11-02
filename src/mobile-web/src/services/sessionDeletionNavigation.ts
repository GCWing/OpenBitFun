/**
 * Where to go after the open session is deleted.
 *
 * The chat page must not stay mounted on a deleted session: its host reads
 * (queue, stream, model) then fail with "session unavailable" errors. The
 * replacement is the nearest surviving row in the list the user deleted from:
 * the next row, or the previous one when the deleted row was last. Rows from
 * other workspaces are not candidates; with no neighbor the caller shows the
 * empty home panel instead.
 */
export interface SessionDeletionGroup<TSession extends { session_id: string }, TOwner> {
  sessions: readonly TSession[];
  owner?: TOwner;
}

export interface SessionDeletionTarget<TSession, TOwner> {
  session: TSession;
  owner?: TOwner;
}

export function nearestSurvivingSession<TSession extends { session_id: string }, TOwner>(
  groups: readonly SessionDeletionGroup<TSession, TOwner>[],
  deletedSessionId: string,
): SessionDeletionTarget<TSession, TOwner> | null {
  for (const group of groups) {
    const index = group.sessions.findIndex(session => session.session_id === deletedSessionId);
    if (index === -1) continue;
    const survivors = group.sessions.filter(session => session.session_id !== deletedSessionId);
    if (survivors.length === 0) return null;
    const session = survivors[Math.min(index, survivors.length - 1)];
    return { session, owner: group.owner };
  }
  return null;
}
