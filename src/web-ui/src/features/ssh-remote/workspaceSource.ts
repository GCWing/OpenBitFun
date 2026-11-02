import type { SavedConnection, WorkspaceConnectionTarget } from './types';

/** UI coordinates only. Existing connection IDs and persisted profiles stay unchanged. */
export type WorkspaceSource = 'host' | WorkspaceConnectionTarget;
export type WorkspaceLocation = 'current' | 'other';
export type WorkspaceEnvironment = 'system' | 'container' | 'wsl';

export function workspaceSourceCoordinates(source: WorkspaceSource): {
  location: WorkspaceLocation;
  environment: WorkspaceEnvironment;
} {
  return {
    location: source === 'host' || source === 'localDocker' || source === 'wsl' ? 'current' : 'other',
    environment: source === 'wsl' ? 'wsl'
      : source === 'host' || source === 'ssh' ? 'system' : 'container',
  };
}

export function workspaceSourceFor(
  location: WorkspaceLocation,
  environment: WorkspaceEnvironment,
): WorkspaceSource {
  if (environment === 'container') return location === 'current' ? 'localDocker' : 'remoteDocker';
  // Native WSL belongs to the executing OpenBitFun host, never an SSH host.
  if (environment === 'wsl') {
    if (location !== 'current') throw new Error('Native WSL requires the current work host');
    return 'wsl';
  }
  return location === 'current' ? 'host' : 'ssh';
}

export function savedConnectionTarget(connection: SavedConnection): WorkspaceConnectionTarget {
  if (connection.wsl) return 'wsl';
  if (connection.container?.local) return 'localDocker';
  if (connection.container?.access === 'sshd') return 'containerSshd';
  if (connection.container) return 'remoteDocker';
  return 'ssh';
}

export function sameWorkspaceSource(left: WorkspaceSource, right: WorkspaceSource): boolean {
  const a = workspaceSourceCoordinates(left);
  const b = workspaceSourceCoordinates(right);
  return a.location === b.location && a.environment === b.environment;
}
