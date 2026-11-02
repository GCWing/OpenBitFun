import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { sshConnectionIdPortScope } from '@/shared/utils/sshConnectionIdentity';

type RemoteWorkspaceFacts = Pick<WorkspaceInfo, 'id' | 'workspaceKind' | 'connectionId' | 'connectionName' | 'sshHost'>;

export interface RemoteWorkspaceBadge {
  /** Compact label shown next to the folder name. */
  label: string;
  /** Full connection name for the tooltip and accessible name. */
  connection: string;
  /** Full `user@host:port` style endpoint for the tooltip. */
  host: string;
}

interface RemoteEndpointParts {
  connectionKey: string;
  alias?: string;
  user?: string;
  host: string;
  portScope?: string;
}

const SSH_ID = /^ssh-([^@]*)@([^#:]+)/;

/**
 * Whether a saved name is the dialog default for this connection: exactly
 * `user@host` (optionally `:port`) with the connection's own user, host and
 * port, or the bare host. Any other name was chosen by the user, `@` included.
 */
function isGeneratedName(
  name: string,
  user: string | undefined,
  hosts: readonly (string | undefined)[],
  portScope: string | undefined,
): boolean {
  if (!name) return true;
  const port = portScope?.split('~')[0];
  return hosts.some(host => {
    if (!host) return false;
    if (name === host) return true;
    if (!user) return false;
    const base = `${user}@${host}`;
    return name === base || (port !== undefined && name === `${base}:${port}`);
  });
}

function endpointParts(workspace: RemoteWorkspaceFacts): RemoteEndpointParts {
  const connectionId = workspace.connectionId?.trim() ?? '';
  const name = workspace.connectionName?.trim() ?? '';
  const rawHost = workspace.sshHost?.trim() ?? '';
  // Port-scoped workspace identities spell the host as `host#port` (#3670).
  const hashIndex = rawHost.indexOf('#');
  const hostScope = hashIndex >= 0 ? rawHost.slice(hashIndex + 1) : undefined;
  const sshHost = hashIndex >= 0 ? rawHost.slice(0, hashIndex) : rawHost;
  const idMatch = SSH_ID.exec(connectionId);
  const user = idMatch?.[1] || undefined;
  const idHost = idMatch?.[2];
  const host = sshHost || idHost || name || connectionId;
  const portScope = sshConnectionIdPortScope(connectionId) ?? (hostScope || undefined);
  return {
    connectionKey: connectionId || `${user ?? ''}@${host}`,
    alias: isGeneratedName(name, user, [host, idHost], portScope) ? undefined : name,
    user,
    host,
    portScope,
  };
}

function withPort(host: string, portScope?: string): string {
  return portScope ? `${host}:${portScope}` : host;
}

function fullEndpoint(parts: RemoteEndpointParts): string {
  return withPort(parts.user ? `${parts.user}@${parts.host}` : parts.host, parts.portScope);
}

function compactLabel(parts: RemoteEndpointParts): string {
  return parts.alias ?? withPort(parts.host, parts.portScope);
}

/**
 * Compact remote badges for the opened workspaces. The badge shows the saved
 * connection alias, or the host without the login user; a non-default port
 * stays visible so port-mapped nodes on one address remain distinct. When two
 * different connections would still read the same, both fall back to the full
 * `user@host:port` endpoint. Full details always stay in the tooltip.
 */
export function remoteWorkspaceBadges(
  workspaces: readonly RemoteWorkspaceFacts[],
): Map<string, RemoteWorkspaceBadge> {
  const parts = workspaces
    .filter(workspace => workspace.workspaceKind === WorkspaceKind.Remote)
    .map(workspace => ({ workspace, parts: endpointParts(workspace) }));
  const connectionsByLabel = new Map<string, Set<string>>();
  for (const entry of parts) {
    const label = compactLabel(entry.parts);
    const keys = connectionsByLabel.get(label) ?? new Set<string>();
    keys.add(entry.parts.connectionKey);
    connectionsByLabel.set(label, keys);
  }
  const badges = new Map<string, RemoteWorkspaceBadge>();
  for (const { workspace, parts: entry } of parts) {
    const compact = compactLabel(entry);
    const ambiguous = (connectionsByLabel.get(compact)?.size ?? 0) > 1;
    const endpoint = fullEndpoint(entry);
    badges.set(workspace.id, {
      label: ambiguous ? (entry.alias ? `${entry.alias} · ${endpoint}` : endpoint) : compact,
      connection: workspace.connectionName?.trim() || endpoint,
      host: endpoint,
    });
  }
  return badges;
}

export function remoteWorkspaceBadge(workspace: RemoteWorkspaceFacts): RemoteWorkspaceBadge | undefined {
  return remoteWorkspaceBadges([workspace]).get(workspace.id);
}
