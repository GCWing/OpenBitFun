import type { Session } from '@/flow_chat/types/flow-chat';
import { sessionOwningWorkspaceId } from '@/flow_chat/utils/sessionOrdering';
import { sessionProjectWorkspacePath } from '@/flow_chat/utils/sessionWorkspace';
import { findWorkspaceForSession } from '@/flow_chat/utils/workspaceScope';
import type { WorkspaceInfo } from '@/shared/types';
import type { SessionSceneTarget } from '../components/SceneBar/types';

/**
 * Workspace a session is listed under, and therefore the one navigation must
 * activate. It is the owning row, not the execution directory: a session running
 * in a linked worktree is listed under its project, so activating the worktree
 * would move the surface into a workspace that never shows the session, where
 * the workspace bootstrap then replaces the selection. Legacy path resolution
 * only serves pre-ID records that carry no workspace identity at all.
 */
export function resolveSessionSceneWorkspace(session: Session, workspaces: Iterable<WorkspaceInfo>) {
  return findWorkspaceForSession({
    ...session,
    workspaceId: sessionOwningWorkspaceId(session),
    workspacePath: sessionProjectWorkspacePath(session),
    remoteConnectionId: session.remoteConnectionId || session.config?.remoteConnectionId,
    remoteSshHost: session.remoteSshHost || session.config?.remoteSshHost,
  }, workspaces);
}

/** Scene-bar workspace key for a session that is owned by a known workspace ID. */
export function sessionSceneWorkspaceKey(workspaceId: string): string {
  return JSON.stringify(['workspace', workspaceId]);
}

export function resolveSessionSceneTarget(
  session: Session,
  workspaces: Iterable<WorkspaceInfo>,
  surfaceId: string,
): SessionSceneTarget {
  const workspace = resolveSessionSceneWorkspace(session, workspaces);
  // The owning identity keys the tab even before that workspace is open, so a
  // tab never migrates from the execution worktree to the project it belongs to.
  const workspaceId = workspace?.id ?? sessionOwningWorkspaceId(session);
  // An unresolved legacy session remains individually addressable. Never group
  // it with another workspace through a guessed folder key.
  const workspaceKey = workspaceId
    ? sessionSceneWorkspaceKey(workspaceId)
    : JSON.stringify(['unresolved-workspace', session.sessionId]);
  return { surfaceId, workspaceKey, sessionId: session.sessionId };
}
