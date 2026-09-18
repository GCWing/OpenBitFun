import type { Session } from '../types/flow-chat';
import { isProjectedSessionEmpty } from './flowChatTurnIdentity';
import { sessionProjectWorkspaceId, sessionProjectWorkspacePath } from './sessionWorkspace';

type SessionWorktreeFacts = Pick<
  Session,
  | 'sessionId'
  | 'dialogTurns'
  | 'isPartial'
  | 'totalTurnCount'
  | 'turnCatalog'
  | 'workspaceId'
  | 'workspacePath'
  | 'projectWorkspaceId'
  | 'projectWorkspacePath'
  | 'config'
>;

export function isSessionWorktreeBindingLocked(
  session: Pick<
    SessionWorktreeFacts,
    'sessionId' | 'dialogTurns' | 'isPartial' | 'totalTurnCount' | 'turnCatalog'
  >,
  isProcessing: boolean,
): boolean {
  return !isProjectedSessionEmpty(session) || isProcessing;
}

export function isSessionWorktreeMaterialized(
  session: Pick<SessionWorktreeFacts, 'config'>,
): boolean {
  return !!session.config.executionTarget?.worktreeId;
}

/** Checkbox state, including an unmaterialized choice made before first send. */
export function isSessionWorktreeIsolationEnabled(
  session: Pick<SessionWorktreeFacts, 'config'>,
): boolean {
  return session.config.worktreeIsolationRequested
    ?? isSessionWorktreeMaterialized(session);
}

export interface SessionWorktreeMaterializationPlan {
  enabled: boolean;
  /** Owning project workspace ID; the path below is only the Git IO operand. */
  projectWorkspaceId?: string;
  projectWorkspacePath: string;
}

/**
 * Resolve the one transition that must run after a prompt is submitted and
 * before its backend turn starts. `undefined` means the checkbox has not
 * requested a change, the session is already materialized as requested, or
 * persisted work means it is too late to change the execution root.
 */
export function sessionWorktreeMaterializationPlan(
  session: SessionWorktreeFacts,
): SessionWorktreeMaterializationPlan | undefined {
  const requested = session.config.worktreeIsolationRequested;
  if (
    requested === undefined
    || isSessionWorktreeBindingLocked(session, false)
    || requested === isSessionWorktreeMaterialized(session)
  ) {
    return undefined;
  }

  const projectWorkspacePath = sessionProjectWorkspacePath(session)?.trim();
  if (!projectWorkspacePath) {
    throw new Error('Project workspace path is required to prepare worktree isolation');
  }
  const projectWorkspaceId = sessionProjectWorkspaceId(session);
  return {
    enabled: requested,
    ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
    projectWorkspacePath,
  };
}

/**
 * Fields read by the composer that can change after a historical-session
 * hydrate or a worktree transition. Including them in the store selector keeps
 * the toggle state and project locator from using a stale session snapshot.
 */
export function sessionWorktreeBindingSubscriptionKey(session: SessionWorktreeFacts): string {
  return [
    session.dialogTurns.length,
    session.totalTurnCount ?? '',
    session.turnCatalog?.revision ?? '',
    session.turnCatalog?.totalTurnCount ?? '',
    session.workspaceId ?? '',
    session.workspacePath ?? '',
    session.projectWorkspaceId ?? '',
    session.projectWorkspacePath ?? '',
    session.config.projectWorkspacePath ?? '',
    session.config.executionTarget?.kind ?? '',
    session.config.executionTarget?.worktreeId ?? '',
    session.config.executionTarget?.rootPath ?? '',
    session.config.worktreeIsolationRequested ?? '',
  ].join('|');
}
