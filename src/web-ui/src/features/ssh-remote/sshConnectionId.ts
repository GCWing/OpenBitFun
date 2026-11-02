import type { SavedConnection } from './types';
import { canonicalSshConnectionId, sshConnectionIdAliasPort } from '@/shared/utils/sshConnectionIdentity';

export const DEFAULT_SSH_PORT = 22;

/**
 * Separator between host and port in port-scoped SSH connection ids. Builds
 * before #710 generated `ssh-user@host:port` for every port and the backend
 * treats that spelling as an alias of `ssh-user@host`, so port-scoped ids use
 * a separator no released build produced or collapses.
 */
const PORT_SEPARATOR = '#';

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  /** Suffix appended to the id, e.g. `-container-web` for container profiles. */
  suffix?: string;
}

export interface SshConnectionIdContext {
  /**
   * Connection ids referenced by workspace records on the target host. A
   * legacy port-less id that no saved profile owns any more is reused for a
   * non-default port, so re-adding a deleted legacy profile finds its sessions.
   */
  referencedIds?: readonly string[];
  /**
   * False when the target host predates port-scoped ids (it does not advertise
   * `ssh_port_scoped_identity_v1`); new profiles then keep the legacy id.
   */
  portScopedIds?: boolean;
}

const sameEndpoint = (connection: SavedConnection, endpoint: SshEndpoint) =>
  connection.host === endpoint.host
  && connection.port === endpoint.port
  && connection.username === endpoint.username;

const legacyIdFor = (endpoint: SshEndpoint) => `ssh-${endpoint.username}@${endpoint.host}${endpoint.suffix ?? ''}`;

/**
 * Connection id for a new SSH profile.
 *
 * - Port 22 keeps the historical `ssh-user@host` id byte-for-byte.
 * - Other ports use `ssh-user@host#port`, so servers behind one address that
 *   differ only by port stay distinct connections and workspaces.
 * - A saved profile for the same endpoint keeps its existing id, so legacy
 *   port-less ids for non-default ports are reused instead of replaced.
 * - An id already owned by a profile for another endpoint, directly or through
 *   a pre-#710 `ssh-user@host:port` alias, is never reused; the port-scoped
 *   form (with a `~n` disambiguator when needed) is used.
 */
export function sshConnectionIdForEndpoint(
  endpoint: SshEndpoint,
  saved: readonly SavedConnection[] = [],
  isSameTarget: (connection: SavedConnection) => boolean = () => true,
  context: SshConnectionIdContext = {},
): string {
  const suffix = endpoint.suffix ?? '';
  const existing = saved.find(connection => sameEndpoint(connection, endpoint) && isSameTarget(connection));
  if (existing) return existing.id;

  const legacy = legacyIdFor(endpoint);
  if (context.portScopedIds === false) return legacy;

  const taken = (id: string) => saved.some(connection => canonicalSshConnectionId(connection.id) === id);
  if (endpoint.port !== DEFAULT_SSH_PORT && !taken(legacy)) {
    const orphan = context.referencedIds?.find(id => canonicalSshConnectionId(id) === legacy
      && (sshConnectionIdAliasPort(id) ?? endpoint.port) === endpoint.port);
    if (orphan) return orphan;
  }

  const scoped = `ssh-${endpoint.username}@${endpoint.host}${PORT_SEPARATOR}${endpoint.port}`;
  const preferred = endpoint.port === DEFAULT_SSH_PORT ? legacy : `${scoped}${suffix}`;
  if (!taken(preferred)) return preferred;
  let candidate = `${scoped}${suffix}`;
  for (let n = 2; taken(candidate); n += 1) candidate = `${scoped}~${n}${suffix}`;
  return candidate;
}

/**
 * Saved profile that a host without port-scoped ids would overwrite when it
 * saves `endpoint` under the legacy id: it replaces the same id, its `:port`
 * aliases, and any profile for the same host and user regardless of port.
 */
export function legacySshEndpointConflict(
  endpoint: SshEndpoint,
  saved: readonly SavedConnection[],
  isSameTarget: (connection: SavedConnection) => boolean = () => true,
): SavedConnection | undefined {
  if (saved.some(connection => sameEndpoint(connection, endpoint) && isSameTarget(connection))) return undefined;
  const legacy = legacyIdFor(endpoint);
  return saved.find(connection => canonicalSshConnectionId(connection.id) === legacy
    || (connection.host === endpoint.host && connection.username === endpoint.username && isSameTarget(connection)));
}
