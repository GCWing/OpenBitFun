/**
 * SSH connection id grammar shared with the Rust owner
 * (`openbitfun_services_core::workspace_identity`).
 *
 * - `ssh-user@host`: default-port and legacy profiles.
 * - `ssh-user@host:port`: pre-#710 alias of `ssh-user@host`.
 * - `ssh-user@host#port[~n]`: port-scoped profile (a distinct connection).
 * - `workspace-host-<encoded id>-container-<name>`: container on a synthetic
 *   host wrapper; the wrapped id keeps its port scope.
 */
const PORT_SCOPE = /^ssh-[^@]*@[^#]*#(\d+(?:~\d+)?)(?:-.*)?$/;
const WORKSPACE_HOST_PREFIX = 'workspace-host-';

function unwrapWorkspaceHost(id: string): string {
  if (!id.startsWith(WORKSPACE_HOST_PREFIX)) return id;
  try {
    return decodeURIComponent(id.slice(WORKSPACE_HOST_PREFIX.length));
  } catch {
    return id;
  }
}

/** Port scope of a port-scoped SSH connection id, or undefined for every legacy id. */
export function sshConnectionIdPortScope(connectionId: string | null | undefined): string | undefined {
  const match = PORT_SCOPE.exec(unwrapWorkspaceHost((connectionId ?? '').trim()));
  if (!match) return undefined;
  return Number(match[1].split('~')[0]) <= 65535 ? match[1] : undefined;
}

/** Port named by a pre-#710 `ssh-user@host:port` alias; undefined for every other id. */
export function sshConnectionIdAliasPort(connectionId: string): number | undefined {
  if (!connectionId.startsWith('ssh-')) return undefined;
  const rest = connectionId.slice(4);
  const at = rest.indexOf('@');
  const colon = rest.lastIndexOf(':');
  const port = rest.slice(colon + 1);
  if (at < 0 || colon <= at || !/^\d+$/.test(port) || Number(port) > 65535) return undefined;
  return Number(port);
}

/** Pre-#710 `ssh-user@host:port` ids collapse to `ssh-user@host`; other ids are unchanged. */
export function canonicalSshConnectionId(connectionId: string): string {
  if (sshConnectionIdAliasPort(connectionId) === undefined) return connectionId;
  return connectionId.slice(0, connectionId.lastIndexOf(':'));
}
