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

/** `None` profiles have no credentials to repair; never turn a rejection into a password prompt. */
export function canRepairSshCredentials(authType: { type: string }, error: unknown) {
  return authType.type !== 'None' && isSshAuthenticationError(error);
}

/** Generic connection failure, except an older host that must be updated to use the profile. */
export function sshConnectionErrorKey(error: unknown) {
  return String(error).includes('ssh_none_auth_v1_unsupported')
    ? 'ssh.remote.noAuthUnsupported'
    : 'workspaceSource.connectionFailed';
}
