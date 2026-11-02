import type { Session } from '../types/flow-chat';
import type { SessionMetadata } from '@/shared/types/session-history';
/**
 * Session facts that decide which navigation group owns a session. `config` is
 * optional so metadata-only and legacy call sites keep working.
 */
type SessionNavigationOwner = Pick<Session, 'workspaceId' | 'projectWorkspaceId'> & {
  config?: Pick<Session['config'], 'executionTarget' | 'workspaceId' | 'projectWorkspaceId'>;
};

/**
 * The session executes in a managed worktree of its owning project.
 *
 * A worktree is an execution directory, not a project of its own, so this fact
 * is what keeps such a session in its project's navigation group.
 */
export function isWorktreeIsolatedSession(session: SessionNavigationOwner): boolean {
  const target = session.config?.executionTarget;
  return !!target && target.kind !== 'local';
}

/**
 * Workspace ID of the navigation row that owns the session.
 *
 * This is the one session-to-workspace identity the whole shell shares: the left
 * navigation list, the workspace bootstrap that selects a session, the scene tab
 * key, and session activation. They must never disagree, or a session is listed
 * under one workspace while activation moves the surface to another.
 *
 * A worktree-isolated session is stamped with the worktree's own workspace record
 * but is owned by the project it was started from, so the project ID wins. Every
 * other session is owned by the workspace it was created in — including one
 * created while browsing a linked worktree as its own workspace, which stays in
 * that worktree row even though the worktree's `project_workspace_id` points at
 * the main checkout.
 *
 * Top-level IDs are authoritative; `config` copies serve legacy records that were
 * persisted without them.
 */
export function sessionOwningWorkspaceId(session: SessionNavigationOwner): string | undefined {
  const projectId = session.projectWorkspaceId ?? session.config?.projectWorkspaceId;
  const executionId = session.workspaceId ?? session.config?.workspaceId;
  return isWorktreeIsolatedSession(session) ? projectId ?? executionId : executionId ?? projectId;
}

/**
 * Session list membership is the owning project workspace ID, never a path.
 *
 * The backend stamps a worktree-isolated session with the worktree's own
 * workspace record, but that record is created on demand and is normally not an
 * open workspace. Following it would drop the session out of every navigation
 * group the user can see, so an isolated session stays under the project that
 * owns it — the project identity is the one the worktree cannot outlive.
 *
 * Legacy records without any workspace identity stay unresolved instead of being
 * grouped by a guessed folder.
 */
export function sessionBelongsToWorkspaceNavRow(
  session: SessionNavigationOwner,
  workspaceId?: string,
): boolean {
  if (!workspaceId) return false;
  return sessionOwningWorkspaceId(session) === workspaceId;
}

/**
 * Owning workspace ID every session-scoped host request is addressed with.
 *
 * Persistence, session state, and the session's own configuration catalogs all
 * belong to the workspace that owns the session, never to its execution
 * directory. An isolated session's worktree record is created on demand for
 * execution and is normally not an open workspace, so a request addressed with
 * that record is rejected outright while the same request addressed with the
 * owning project resolves to the identical session directory.
 */
export function requireSessionOwningWorkspaceId(session: SessionNavigationOwner): string {
  const workspaceId = sessionOwningWorkspaceId(session);
  if (!workspaceId) throw new Error('Session workspace ID is unavailable');
  return workspaceId;
}

export function getSessionSortTimestamp(session: Pick<Session, 'createdAt' | 'lastFinishedAt'>): number {
  return session.lastFinishedAt ?? session.createdAt;
}

export function compareSessionsForDisplay(
  a: Pick<Session, 'sessionId' | 'createdAt' | 'lastFinishedAt'>,
  b: Pick<Session, 'sessionId' | 'createdAt' | 'lastFinishedAt'>
): number {
  const timestampDiff = getSessionSortTimestamp(b) - getSessionSortTimestamp(a);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const createdAtDiff = b.createdAt - a.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return a.sessionId.localeCompare(b.sessionId);
}

export function getSessionMetadataSortTimestamp(
  session: Pick<SessionMetadata, 'createdAt' | 'lastFinishedAt' | 'customMetadata'>
): number {
  const lastFinishedAt = session.lastFinishedAt ?? session.customMetadata?.lastFinishedAt;
  return typeof lastFinishedAt === 'number' ? lastFinishedAt : session.createdAt;
}

export function compareSessionMetadataForDisplay(
  a: Pick<SessionMetadata, 'sessionId' | 'createdAt' | 'lastFinishedAt' | 'customMetadata'>,
  b: Pick<SessionMetadata, 'sessionId' | 'createdAt' | 'lastFinishedAt' | 'customMetadata'>
): number {
  const timestampDiff = getSessionMetadataSortTimestamp(b) - getSessionMetadataSortTimestamp(a);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const createdAtDiff = b.createdAt - a.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return a.sessionId.localeCompare(b.sessionId);
}

/**
 * Left-nav session list order: newest-created first, stable while switching sessions
 * (does not use `lastActiveAt`, so rows do not jump to the top on click).
 */
export function compareSessionsForNavStable(
  a: Pick<Session, 'sessionId' | 'createdAt'>,
  b: Pick<Session, 'sessionId' | 'createdAt'>
): number {
  const createdAtDiff = b.createdAt - a.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return a.sessionId.localeCompare(b.sessionId);
}
