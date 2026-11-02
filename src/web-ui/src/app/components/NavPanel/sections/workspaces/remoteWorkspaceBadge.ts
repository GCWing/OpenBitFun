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

function splitUser(value: string): { user?: string; host: string } {
  const at = value.lastIndexOf('@');
  if (at <= 0) return { host: value };
  return { user: value.slice(0, at), host: value.slice(at + 1) };
}

function endpointParts(workspace: RemoteWorkspaceFacts): RemoteEndpointParts {
  const connectionId = workspace.connectionId?.trim() ?? '';
  const name = workspace.connectionName?.trim() ?? '';
  const rawHost = workspace.sshHost?.trim() ?? '';
  // Port-scoped workspace identities spell the host as `host#port` (#3670).
  const hashIndex = rawHost.indexOf('#');
  const hostScope = hashIndex >= 0 ? rawHost.slice(hashIndex + 1) : undefined;
  const sshHost = splitUser(hashIndex >= 0 ? rawHost.slice(0, hashIndex) : rawHost).host;
  const idMatch = SSH_ID.exec(connectionId);
  const fromName = splitUser(name);
  const host = sshHost || idMatch?.[2] || (fromName.user ? fromName.host : '') || name || connectionId;
  const user = fromName.user || idMatch?.[1] || undefined;
  // Generated names are `user@host`; anything else is a saved alias or name chosen by the user.
  const alias = name && !fromName.user && name !== host ? name : undefined;
  return {
    connectionKey: connectionId || `${user ?? ''}@${host}`,
    alias,
    user,
    host,
    portScope: sshConnectionIdPortScope(connectionId) ?? (hostScope || undefined),
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
