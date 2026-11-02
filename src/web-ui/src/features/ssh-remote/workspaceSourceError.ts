import type { WorkspaceSource } from './workspaceSource';

/** Keep process/transport diagnostics out of the source picker. */
export function workspaceSourceErrorKey(source: WorkspaceSource, error: unknown) {
  const detail = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/unsupported|not support/.test(detail)) return source === 'wsl' ? 'ssh.remote.wslUnsupported' : 'workspaceSource.sourceUnsupported';
  if (source === 'localDocker' || source === 'remoteDocker') {
    if (/failed to start.*docker|docker.*not found|docker.*no such file|command not found|enoent/.test(detail)) {
      return 'workspaceSource.dockerUnavailable';
    }
    if (/permission denied|access denied/.test(detail)) return 'workspaceSource.dockerPermissionDenied';
    if (/cannot connect.*docker|docker daemon|docker.*not running/.test(detail)) return 'workspaceSource.dockerNotRunning';
    return 'workspaceSource.containerDiscoveryFailed';
  }
  return source === 'wsl' ? 'ssh.remote.wslDiscoveryFailed' : 'workspaceSource.hostDiscoveryFailed';
}

export function isSshAuthenticationError(error: unknown) {
  return /credentials required|authenticat|password|passphrase|private key|publickey|keyboard.interactive|challenge response|ssh agent/i.test(String(error));
}
