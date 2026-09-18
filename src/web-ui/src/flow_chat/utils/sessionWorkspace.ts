import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import type { Session } from '../types/flow-chat';

type SessionWorkspaceBinding = Pick<
  Session,
  'workspacePath' | 'projectWorkspacePath' | 'config'
>;

function sessionWorkspaceRecord(
  session: Partial<Pick<Session, 'workspaceId' | 'config'>> | undefined,
  workspace: WorkspaceInfo | null | undefined,
): WorkspaceInfo | undefined {
  const workspaceId = session?.workspaceId || session?.config?.workspaceId;
  if (!workspaceId) return session ? undefined : workspace ?? undefined;
  const state = workspaceManager.getState();
  return workspace?.id === workspaceId ? workspace
    : state.openedWorkspaces.get(workspaceId) || state.recentWorkspaces.find(item => item.id === workspaceId);
}

export function isRemoteWorkspaceSession(
  session: Partial<Pick<Session, 'workspaceId' | 'config'>> | undefined,
  workspace: WorkspaceInfo | null | undefined,
): boolean {
  return isRemoteWorkspace(sessionWorkspaceRecord(session, workspace));
}

/** Local-only actions require an available object with an explicit local kind. */
export function isLocalWorkspaceSession(
  session: Partial<Pick<Session, 'workspaceId' | 'config'>> | undefined,
  workspace: WorkspaceInfo | null | undefined,
): boolean {
  const record = sessionWorkspaceRecord(session, workspace);
  return record?.workspaceKind === 'normal' || record?.workspaceKind === 'assistant';
}

/** Concrete root in which terminal, Git, and file tools execute. */
export function sessionExecutionWorkspacePath(
  session: SessionWorkspaceBinding,
): string | undefined {
  return session.workspacePath || session.config?.workspacePath;
}

/** Main-project root that owns session persistence and orchestration state. */
export function sessionProjectWorkspacePath(
  session: SessionWorkspaceBinding,
): string | undefined {
  return (
    session.projectWorkspacePath
    || session.config?.projectWorkspacePath
    || sessionExecutionWorkspacePath(session)
  );
}

/**
 * Workspace ID of the main project that owns session persistence. Falls back
 * to the execution workspace ID for sessions that are not in a linked worktree.
 */
export function sessionProjectWorkspaceId(
  session: Partial<Pick<Session, 'workspaceId' | 'projectWorkspaceId' | 'config'>>,
): string | undefined {
  return (
    session.projectWorkspaceId
    || session.config?.projectWorkspaceId
    || session.workspaceId
    || session.config?.workspaceId
    || undefined
  );
}

export function requireSessionProjectWorkspacePath(
  session: SessionWorkspaceBinding,
  sessionId: string,
): string {
  const path = sessionProjectWorkspacePath(session);
  if (!path) {
    throw new Error(`Workspace path not found for session ${sessionId}`);
  }
  return path;
}

/** Workspace identity for persistence and routing; `undefined` only for pre-ID sessions. */
export function sessionWorkspaceId(
  session: Partial<Pick<Session, 'workspaceId' | 'config'>> | undefined,
): string | undefined {
  return session?.workspaceId || session?.config?.workspaceId || undefined;
}

/** Workspace identity for persistence and routing. Paths are IO projections only. */
export function requireSessionWorkspaceId(
  session: Partial<Pick<Session, 'workspaceId' | 'config'>>,
): string {
  const id = session.workspaceId || session.config?.workspaceId;
  if (!id) throw new Error('Session workspace ID is unavailable');
  return id;
}
