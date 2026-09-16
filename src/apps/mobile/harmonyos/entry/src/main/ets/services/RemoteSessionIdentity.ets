import { RemoteSession, RemoteWorkspaceIdentity } from '../model/RemoteModels';

export function remoteWorkspaceKey(scope: RemoteWorkspaceIdentity): string {
  const trimmedPath = scope.path.trim();
  const path = trimmedPath.length > 0 ? trimmedPath.replace(/\/+$/, '') || '/' : '';
  return [scope.remoteConnectionId?.trim() || '', scope.remoteSshHost?.trim() || '', path]
    .map((part: string): string => `${part.length}:${part}`).join('');
}

/** Unknown legacy sessions are eligible only for an unambiguous local catalog row. */
export function remoteSessionBelongsToWorkspace(
  session: RemoteSession, scope: RemoteWorkspaceIdentity, catalog: RemoteWorkspaceIdentity[]
): boolean {
  if (session.workspaceIdentity) return remoteWorkspaceKey(session.workspaceIdentity) === remoteWorkspaceKey(scope);
  if (scope.remoteConnectionId?.trim() || scope.remoteSshHost?.trim() || !session.workspacePath?.trim()) return false;
  const local: RemoteWorkspaceIdentity = { path: session.workspacePath };
  if (remoteWorkspaceKey(local) !== remoteWorkspaceKey(scope)) return false;
  return catalog.filter((item: RemoteWorkspaceIdentity): boolean =>
    remoteWorkspaceKey({ path: item.path }) === remoteWorkspaceKey(local)).length === 1;
}

/** Stable key for a session that may exist on more than one desktop. */
export function remoteSessionIdentity(session: RemoteSession): string {
  return `${session.deviceId || ''}\u0001${session.id}`;
}

export function stampRemoteSessionDevice(session: RemoteSession, deviceId: string): RemoteSession {
  if (deviceId.length === 0 || session.deviceId === deviceId) {
    return session;
  }
  return {
    id: session.id,
    title: session.title,
    agentType: session.agentType,
    status: session.status,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messageCount: session.messageCount,
    workspacePath: session.workspacePath,
    workspaceName: session.workspaceName,
    workspaceIdentity: session.workspaceIdentity,
    pinned: session.pinned,
    titleGenerated: session.titleGenerated,
    deviceId
  };
}

export function stampRemoteSessionsDevice(sessions: RemoteSession[], deviceId: string): RemoteSession[] {
  if (deviceId.length === 0) {
    return sessions;
  }
  return sessions.map((item: RemoteSession): RemoteSession => stampRemoteSessionDevice(item, deviceId));
}

/** Fills the scope omitted by older list_sessions payloads without mutating it. */
export function stampRemoteSessionWorkspace(session: RemoteSession, workspacePath: string,
  remoteConnectionId?: string, remoteSshHost?: string): RemoteSession {
  if (workspacePath.length === 0 || session.workspaceIdentity) {
    return session;
  }
  return {
    id: session.id,
    title: session.title,
    agentType: session.agentType,
    status: session.status,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messageCount: session.messageCount,
    workspacePath: session.workspacePath || workspacePath,
    workspaceIdentity: { path: session.workspacePath || workspacePath, remoteConnectionId, remoteSshHost },
    workspaceName: session.workspaceName,
    pinned: session.pinned,
    titleGenerated: session.titleGenerated,
    deviceId: session.deviceId
  };
}

export function stampRemoteSessionsWorkspace(
  sessions: RemoteSession[],
  workspacePath: string,
  remoteConnectionId?: string,
  remoteSshHost?: string
): RemoteSession[] {
  return sessions.map((item: RemoteSession): RemoteSession =>
    stampRemoteSessionWorkspace(item, workspacePath, remoteConnectionId, remoteSshHost));
}
