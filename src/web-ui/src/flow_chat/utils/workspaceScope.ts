/** Workspace ownership uses the host's persisted ID, never a folder key. */
import type { WorkspaceInfo } from '@/shared/types';
import type { Session } from '../types/flow-chat';
import { resolveLegacySessionWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';

type SessionScope = Pick<Session,
  'workspaceId' | 'workspacePath' | 'projectWorkspacePath' | 'remoteConnectionId' | 'remoteSshHost'>;
type WorkspaceScope = Pick<WorkspaceInfo, 'id'>;

export function sessionMatchesWorkspace(session: SessionScope, workspace: WorkspaceScope): boolean {
  return !!session.workspaceId && session.workspaceId === workspace.id;
}

export function findWorkspaceForSession(session: SessionScope, workspaces: Iterable<WorkspaceInfo>): WorkspaceInfo | undefined {
  const records = [...workspaces];
  if (session.workspaceId) return records.find(workspace => workspace.id === session.workspaceId);
  return resolveLegacySessionWorkspace(session, records);
}
