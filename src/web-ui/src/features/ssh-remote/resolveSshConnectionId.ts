import { getActiveSurfaceScope, isLocalSurface } from '@/infrastructure/peer-device/deviceSurface';
import { globalAPI } from '@/infrastructure/api/service-api/GlobalAPI';
import { createLogger } from '@/shared/utils/logger';
import { sshApi } from './sshApi';
import {
  DEFAULT_SSH_PORT,
  legacySshEndpointConflict,
  sshConnectionIdForEndpoint,
  type SshEndpoint,
} from './sshConnectionId';
import type { SavedConnection } from './types';

const log = createLogger('ResolveSshConnectionId');

/**
 * Failures carry `transientId`, an id the host accepts for requests that do
 * not persist a profile (connection tests, container discovery).
 */
export type NewSshConnectionId =
  | { id: string }
  /** The saved profiles are unknown, so any id could overwrite one of them. */
  | { error: 'savedConnectionsUnavailable'; transientId: string }
  /** The host predates port-scoped ids and would replace another port's profile. */
  | { error: 'portScopedIdentityUnsupported'; conflict: SavedConnection; transientId: string };

/**
 * Whether the active host understands port-scoped SSH ids
 * (`ssh-user@host#port`). Peer hosts must advertise `ssh_port_scoped_identity_v1`;
 * older hosts would treat such an id as a different, unscoped connection.
 */
export async function activeHostSupportsPortScopedSshIds(): Promise<boolean> {
  const scope = getActiveSurfaceScope();
  if (isLocalSurface(scope.surfaceId)) return true;
  const { peerConnectionManager } = await import('@/infrastructure/peer-device/PeerConnectionManager');
  scope.assertCurrent('negotiate SSH connection identity');
  return peerConnectionManager.get(scope.surfaceId)?.getState().capabilities.sshPortScopedIdentityV1 === true;
}

async function referencedRemoteConnectionIds(): Promise<string[]> {
  try {
    const [opened, recent] = await Promise.all([globalAPI.getOpenedWorkspaces(), globalAPI.getRecentWorkspaces()]);
    return [...opened, ...recent].flatMap(workspace =>
      workspace.workspaceKind === 'remote' && workspace.connectionId ? [workspace.connectionId] : []);
  } catch (error) {
    // Only the reuse of an orphaned legacy id depends on this list.
    log.warn('Failed to list workspace records for SSH connection id reuse', { error });
    return [];
  }
}

/**
 * Id for a new SSH profile on the active host, resolved against the profiles
 * it already saved. Pass `saved` when the caller already listed them.
 */
export async function resolveNewSshConnectionId(
  endpoint: SshEndpoint,
  isSameTarget: (connection: SavedConnection) => boolean,
  saved?: readonly SavedConnection[],
): Promise<NewSshConnectionId> {
  const portScopedIds = await activeHostSupportsPortScopedSshIds();
  let connections = saved;
  if (!connections) {
    try {
      connections = await sshApi.listSavedConnections();
    } catch (error) {
      log.warn('Failed to list saved SSH connections for a new profile id', { error });
      return {
        error: 'savedConnectionsUnavailable',
        transientId: sshConnectionIdForEndpoint(endpoint, [], isSameTarget, { portScopedIds }),
      };
    }
  }
  if (!portScopedIds) {
    const id = sshConnectionIdForEndpoint(endpoint, connections, isSameTarget, { portScopedIds });
    const conflict = legacySshEndpointConflict(endpoint, connections, isSameTarget);
    return conflict ? { error: 'portScopedIdentityUnsupported', conflict, transientId: id } : { id };
  }
  const referencedIds = endpoint.port === DEFAULT_SSH_PORT ? [] : await referencedRemoteConnectionIds();
  return { id: sshConnectionIdForEndpoint(endpoint, connections, isSameTarget, { referencedIds }) };
}
