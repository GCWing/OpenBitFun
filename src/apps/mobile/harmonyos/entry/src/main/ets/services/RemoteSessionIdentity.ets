import { RemoteSession, RemoteWorkspaceIdentity } from '../model/RemoteModels';
import { LegacyWorkspaceCompatibility } from './LegacyWorkspaceCompatibility';

/**
 * Stable grouping key for a workspace reference.
 *
 * A reference that carries `workspaceId` is keyed by that ID alone; path and
 * SSH facts are display strings that must not split or merge groups. Only
 * references without an ID (pre-ID hosts, old caches) use the legacy triple.
 */
export function remoteWorkspaceKey(scope: RemoteWorkspaceIdentity): string {
  const workspaceId = scope.workspaceId;
  if (workspaceId !== undefined && workspaceId.length > 0) {
    return `workspace:${workspaceId.length}:${workspaceId}`;
  }
  return legacyRemoteWorkspaceKey(scope);
}

/** Upgrade-only key for caches and peers predating workspace IDs. */
export function legacyRemoteWorkspaceKey(scope: RemoteWorkspaceIdentity): string {
  const trimmedPath = scope.path.trim();
  const path = trimmedPath.length > 0 ? trimmedPath.replace(/\/+$/, '') || '/' : '';
  return [scope.remoteConnectionId?.trim() || '', scope.remoteSshHost?.trim() || '', path]
    .map((part: string): string => `${part.length}:${part}`).join('');
}

/**
 * Whether two references name the same workspace.
 *
 * With IDs on both sides only the IDs are compared. A side without an ID is
 * first attributed through the legacy compatibility resolver against the
 * catalog; an unresolvable or ambiguous legacy side never matches an
 * identified one.
 */
export function remoteWorkspaceIdentityMatches(
  left: RemoteWorkspaceIdentity,
  right: RemoteWorkspaceIdentity,
  catalog: RemoteWorkspaceIdentity[]
): boolean {
  if (left.workspaceId && right.workspaceId) {
    return left.workspaceId === right.workspaceId;
  }
  const resolvedLeft = LegacyWorkspaceCompatibility.resolve(left, catalog) || left;
  const resolvedRight = LegacyWorkspaceCompatibility.resolve(right, catalog) || right;
  return remoteWorkspaceKey(resolvedLeft) === remoteWorkspaceKey(resolvedRight);
}

/** Unknown legacy sessions are eligible only for an unambiguous local catalog row. */
export function remoteSessionBelongsToWorkspace(
  session: RemoteSession, scope: RemoteWorkspaceIdentity, catalog: RemoteWorkspaceIdentity[]
): boolean {
  if (session.workspaceIdentity) {
    return remoteWorkspaceIdentityMatches(session.workspaceIdentity, scope, catalog);
  }
  if (scope.remoteConnectionId?.trim() || scope.remoteSshHost?.trim() || !session.workspacePath?.trim()) return false;
  const local: RemoteWorkspaceIdentity = { path: session.workspacePath };
  const resolved = LegacyWorkspaceCompatibility.resolve(local, catalog);
  return resolved !== undefined && remoteWorkspaceKey(resolved) === remoteWorkspaceKey(scope);
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

/**
 * Fills the scope omitted by older list_sessions payloads without mutating it.
 *
 * A session the host already pinned to a workspace ID keeps that ID; the
 * listing scope may only complete its display path and SSH projection, and
 * only when the scope names the same workspace or has no ID of its own. A
 * session already scoped by a legacy triple is left untouched.
 */
export function stampRemoteSessionWorkspace(session: RemoteSession, scope: RemoteWorkspaceIdentity): RemoteSession {
  const scopeId = scope.workspaceId || '';
  if (scope.path.length === 0 && scopeId.length === 0) {
    return session;
  }
  const existing = session.workspaceIdentity;
  let identity: RemoteWorkspaceIdentity;
  if (existing === undefined) {
    identity = {
      workspaceId: scopeId.length > 0 ? scopeId : undefined,
      path: session.workspacePath || scope.path,
      remoteConnectionId: scope.remoteConnectionId,
      remoteSshHost: scope.remoteSshHost
    };
  } else {
    const existingId = existing.workspaceId || '';
    if (existingId.length === 0 || (scopeId.length > 0 && scopeId !== existingId)) {
      return session;
    }
    const path = existing.path.length > 0 ? existing.path : (session.workspacePath || scope.path);
    const remoteConnectionId = existing.remoteConnectionId !== undefined ? existing.remoteConnectionId : scope.remoteConnectionId;
    const remoteSshHost = existing.remoteSshHost !== undefined ? existing.remoteSshHost : scope.remoteSshHost;
    if (path === existing.path && remoteConnectionId === existing.remoteConnectionId &&
      remoteSshHost === existing.remoteSshHost && (session.workspacePath || '').length > 0) {
      return session;
    }
    identity = {
      workspaceId: existingId,
      path: path,
      remoteConnectionId: remoteConnectionId,
      remoteSshHost: remoteSshHost
    };
  }
  return {
    id: session.id,
    title: session.title,
    agentType: session.agentType,
    status: session.status,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messageCount: session.messageCount,
    workspacePath: session.workspacePath || identity.path,
    workspaceIdentity: identity,
    workspaceName: session.workspaceName,
    pinned: session.pinned,
    titleGenerated: session.titleGenerated,
    deviceId: session.deviceId
  };
}

export function stampRemoteSessionsWorkspace(
  sessions: RemoteSession[],
  scope: RemoteWorkspaceIdentity
): RemoteSession[] {
  return sessions.map((item: RemoteSession): RemoteSession => stampRemoteSessionWorkspace(item, scope));
}
