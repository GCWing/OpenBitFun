import type { SavedConnection } from './types';

export const DEFAULT_SSH_PORT = 22;

/**
 * Separator between host and port in port-scoped SSH connection ids. Builds
 * before #710 generated `ssh-user@host:port` for every port and the backend
 * treats that spelling as an alias of `ssh-user@host`, so port-scoped ids use
 * a separator no released build produced or collapses.
 */
const PORT_SEPARATOR = '#';

interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  /** Suffix appended to the id, e.g. `-container-web` for container profiles. */
  suffix?: string;
}

const sameEndpoint = (connection: SavedConnection, endpoint: SshEndpoint) =>
  connection.host === endpoint.host
  && connection.port === endpoint.port
  && connection.username === endpoint.username;

/**
 * Connection id for a new SSH profile.
 *
 * - Port 22 keeps the historical `ssh-user@host` id byte-for-byte.
 * - Other ports use `ssh-user@host#port`, so servers behind one address that
 *   differ only by port stay distinct connections and workspaces.
 * - A saved profile for the same endpoint keeps its existing id, so legacy
 *   port-less ids for non-default ports are reused instead of replaced.
 * - An id already owned by a profile for another endpoint is never reused;
 *   the port-scoped form (with a `~n` disambiguator when needed) is used.
 */
export function sshConnectionIdForEndpoint(
  endpoint: SshEndpoint,
  saved: readonly SavedConnection[] = [],
  isSameTarget: (connection: SavedConnection) => boolean = () => true,
): string {
  const suffix = endpoint.suffix ?? '';
  const existing = saved.find(connection => sameEndpoint(connection, endpoint) && isSameTarget(connection));
  if (existing) return existing.id;

  const taken = (id: string) => saved.some(connection => connection.id === id);
  const portLess = `ssh-${endpoint.username}@${endpoint.host}`;
  const scoped = `${portLess}${PORT_SEPARATOR}${endpoint.port}`;
  const preferred = endpoint.port === DEFAULT_SSH_PORT ? `${portLess}${suffix}` : `${scoped}${suffix}`;
  if (!taken(preferred)) return preferred;
  let candidate = `${scoped}${suffix}`;
  for (let n = 2; taken(candidate); n += 1) candidate = `${scoped}~${n}${suffix}`;
  return candidate;
}
