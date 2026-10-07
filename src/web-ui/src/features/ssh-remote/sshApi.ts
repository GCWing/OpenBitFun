/**
 * SSH Remote Feature - API Service
 */

import type {
  SSHConnectionConfig,
  WslDistributions,
  SSHConnectionResult,
  SavedConnection,
  RemoteFileEntry,
  RemoteTreeNode,
  RemoteWorkspace,
  SSHConfigLookupResult,
  SSHConfigEntry,
  ServerInfo,
  DockerContainerInfo,
  ConnectionTestReport,
  PortForward,
  PortForwardRequest,
  RemoteListeningPort,
} from './types';

// API adapter for Tauri/Server Mode compatibility
import { api } from '@/infrastructure/api/service-api/ApiClient';

/**
 * Deadline override for the remote file transfers that expose a stop action.
 *
 * These commands are already bounded where the work happens: every SFTP request
 * has its own response timeout, the SSH transport drops a stalled connection,
 * and the transfer itself can be stopped from its card. A wall-clock deadline
 * here only guaranteed failure for slow-but-healthy links, which is how a
 * completed transfer used to surface as "Request timeout".
 *
 * Commands without a progress or stop surface keep the default deadline: it is
 * what keeps an unresponsive host from freezing the UI with no way out.
 */
const NO_REQUEST_DEADLINE = { timeout: 0 } as const;

export const sshApi = {
  // === Connection Management ===

  async listWslDistributions(): Promise<WslDistributions> {
    return api.invoke<WslDistributions>('ssh_list_wsl_distributions', {});
  },

  /**
   * List all saved SSH connections
   */
  async listSavedConnections(): Promise<SavedConnection[]> {
    return api.invoke<SavedConnection[]>('ssh_list_saved_connections', {});
  },

  /**
   * Save SSH connection configuration
   */
  async saveConnection(config: SSHConnectionConfig): Promise<void> {
    return api.invoke('ssh_save_connection', { config });
  },

  /**
   * Delete saved SSH connection
   */
  async deleteConnection(connectionId: string): Promise<void> {
    return api.invoke('ssh_delete_connection', { connectionId });
  },

  /**
   * Whether a password is stored in the local vault for this saved connection (password auth auto-reconnect).
   */
  async hasStoredPassword(connectionId: string): Promise<boolean> {
    return api.invoke<boolean>('ssh_has_stored_password', { connectionId });
  },

  /**
   * Connect to remote SSH server
   */
  async connect(config: SSHConnectionConfig): Promise<SSHConnectionResult> {
    return api.invoke<SSHConnectionResult>('ssh_connect', { config });
  },

  /**
   * Test every configured hop and resolve the effective container transport
   * without persisting or activating the connection.
   */
  async testConnection(config: SSHConnectionConfig): Promise<ConnectionTestReport> {
    return api.invoke<ConnectionTestReport>('ssh_test_connection', { config });
  },

  /**
   * List Docker containers on either the local machine or the configured SSH host.
   */
  async listDockerContainers(config: SSHConnectionConfig): Promise<DockerContainerInfo[]> {
    return api.invoke<DockerContainerInfo[]>('ssh_list_docker_containers', { config });
  },

  /**
   * Disconnect from SSH server
   */
  async disconnect(connectionId: string): Promise<void> {
    return api.invoke('ssh_disconnect', { connectionId });
  },

  /**
   * Disconnect all SSH connections
   */
  async disconnectAll(): Promise<void> {
    return api.invoke('ssh_disconnect_all', {});
  },

  /**
   * Check if connected to SSH server
   */
  async isConnected(connectionId: string): Promise<boolean> {
    return api.invoke<boolean>('ssh_is_connected', { connectionId });
  },

  /**
   * Server info for an active connection; may probe `echo ~` / `$HOME` if `homeDir` was missing.
   */
  async getServerInfo(connectionId: string): Promise<ServerInfo | null> {
    return api.invoke<ServerInfo | null>('ssh_get_server_info', { connectionId });
  },

  /**
   * Get SSH config for a host from ~/.ssh/config
   */
  async getSSHConfig(host: string): Promise<SSHConfigLookupResult> {
    return api.invoke<SSHConfigLookupResult>('ssh_get_config', { host });
  },

  /**
   * List all hosts from ~/.ssh/config
   */
  async listSSHConfigHosts(): Promise<SSHConfigEntry[]> {
    return api.invoke<SSHConfigEntry[]>('ssh_list_config_hosts', {});
  },

  // === Remote File Operations ===

  /**
   * Read file content from remote server
   */
  async readFile(connectionId: string, path: string): Promise<string> {
    return api.invoke<string>('remote_read_file', { connectionId, path });
  },

  /**
   * Write content to remote file
   */
  async writeFile(connectionId: string, path: string, content: string): Promise<void> {
    return api.invoke('remote_write_file', { connectionId, path, content });
  },

  /**
   * Check if remote path exists
   */
  async exists(connectionId: string, path: string): Promise<boolean> {
    return api.invoke<boolean>('remote_exists', { connectionId, path });
  },

  /**
   * List directory contents
   */
  async readDir(connectionId: string, path: string): Promise<RemoteFileEntry[]> {
    return api.invoke<RemoteFileEntry[]>('remote_read_dir', { connectionId, path });
  },

  /**
   * Get remote file tree
   */
  async getTree(
    connectionId: string,
    path: string,
    depth?: number
  ): Promise<RemoteTreeNode> {
    return api.invoke<RemoteTreeNode>('remote_get_tree', { connectionId, path, depth });
  },

  /**
   * Create remote directory
   */
  async createDir(
    connectionId: string,
    path: string,
    recursive: boolean
  ): Promise<void> {
    return api.invoke('remote_create_dir', { connectionId, path, recursive });
  },

  /**
   * Remove remote file or directory
   */
  async remove(
    connectionId: string,
    path: string,
    recursive: boolean
  ): Promise<void> {
    return api.invoke('remote_remove', { connectionId, path, recursive });
  },

  /**
   * Rename/move remote file or directory
   */
  async rename(
    connectionId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    return api.invoke('remote_rename', { connectionId, oldPath, newPath });
  },

  /**
   * Download a remote file to a local filesystem path (desktop; binary-safe).
   *
   * When `onProgress` is provided, listens for `download_progress` Tauri events
   * emitted by the backend and invokes the callback with `(downloaded, total)`
   * byte counts. A unique `transferId` is generated per call (or uses the one
   * provided) so that concurrent downloads do not receive each other's progress
   * events. The `transferId` can be passed to `cancelTransfer` to abort the
   * download. The listener is cleaned up automatically on completion.
   */
  async downloadToLocalPath(
    connectionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (downloaded: number, total: number) => void,
    transferId?: string,
    isCancelled?: () => boolean,
  ): Promise<void> {
    const tid = transferId ?? crypto.randomUUID();
    let unlisten: (() => void) | null = null;

    if (onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ transferId: string; downloaded: number; total: number }>(
        'download_progress',
        (event) => {
          if (event.payload.transferId === tid) {
            onProgress(event.payload.downloaded, event.payload.total);
          }
        },
      );
    }

    try {
      // The stop action can run while the progress listener is being installed,
      // before the backend has registered this transfer id.
      if (isCancelled?.()) {
        throw new Error('Transfer cancelled');
      }
      await api.invoke('remote_download_to_local_path', {
        connectionId,
        remotePath,
        localPath,
        transferId: tid,
      }, transferId ? NO_REQUEST_DEADLINE : undefined);
    } finally {
      unlisten?.();
    }
  },

  /**
   * Upload a local file or directory to a remote path (desktop; binary-safe).
   * Returns `{ wasDirectory: boolean }` indicating whether the uploaded path
   * was a directory.
   *
   * When `onProgress` is provided, listens for `upload_progress` Tauri events
   * emitted by the backend and invokes the callback with `(uploaded, total)`
   * byte counts. A unique `transferId` is generated per call (or uses the one
   * provided) so that concurrent uploads do not receive each other's progress
   * events. The `transferId` can be passed to `cancelTransfer` to abort the
   * upload. The listener is cleaned up automatically on completion.
   */
  async uploadFromLocalPath(
    connectionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (uploaded: number, total: number) => void,
    transferId?: string,
    isCancelled?: () => boolean,
  ): Promise<{ wasDirectory: boolean }> {
    const tid = transferId ?? crypto.randomUUID();
    let unlisten: (() => void) | null = null;

    if (onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ transferId: string; uploaded: number; total: number }>(
        'upload_progress',
        (event) => {
          if (event.payload.transferId === tid) {
            onProgress(event.payload.uploaded, event.payload.total);
          }
        },
      );
    }

    try {
      if (isCancelled?.()) {
        throw new Error('Transfer cancelled');
      }
      return await api.invoke('remote_upload_from_local_path', {
        connectionId,
        localPath,
        remotePath,
        transferId: tid,
      }, transferId ? NO_REQUEST_DEADLINE : undefined);
    } finally {
      unlisten?.();
    }
  },

  /**
   * Cancel an in-progress file transfer (download or upload) by its transferId.
   * The backend will abort the transfer at the next chunk boundary.
   */
  async cancelTransfer(transferId: string): Promise<void> {
    return api.invoke('cancel_transfer', { transferId });
  },

  /**
   * Execute command on remote server
   */
  async execute(
    connectionId: string,
    command: string
  ): Promise<[string, string, number]> {
    return api.invoke<[string, string, number]>('remote_execute', { connectionId, command });
  },

  // === Remote Workspace ===

  /**
   * Open remote workspace
   */
  async openWorkspace(connectionId: string, remotePath: string): Promise<void> {
    return api.invoke('remote_open_workspace', { connectionId, remotePath });
  },

  /**
   * Close remote workspace
   */
  async closeWorkspace(): Promise<void> {
    return api.invoke('remote_close_workspace', {});
  },

  /**
   * Remove one persisted remote workspace restore entry without requiring it to be active.
   */
  async removeWorkspace(connectionId: string, remotePath: string): Promise<void> {
    return api.invoke('remote_remove_workspace', { connectionId, remotePath });
  },

  /**
   * Get current remote workspace info
   */
  async getWorkspaceInfo(): Promise<RemoteWorkspace | null> {
    return api.invoke<RemoteWorkspace | null>('remote_get_workspace_info', {});
  },

  // === Port Forwarding ===

  /**
   * Start a local (`-L`) forward.
   *
   * The resolved mapping comes back rather than the request: an unavailable
   * local port is replaced instead of refused, so `localPort` is authoritative
   * and `requestedLocalPort` records the move.
   */
  async startPortForward(request: PortForwardRequest): Promise<PortForward> {
    return api.invoke<PortForward>('ssh_start_port_forward', { request });
  },

  /** Stop one forward. Stopping an already-gone forward is not an error. */
  async stopPortForward(forwardId: string): Promise<void> {
    return api.invoke('ssh_stop_port_forward', { forwardId });
  },

  /** List forwards, optionally narrowed to one connection. */
  async listPortForwards(connectionId?: string): Promise<PortForward[]> {
    return api.invoke<PortForward[]>('ssh_list_port_forwards', {
      connectionId: connectionId ?? null,
    });
  },

  /**
   * List TCP ports currently listening on the remote host.
   *
   * Discovery only — nothing is forwarded as a result.
   */
  async listRemoteListeningPorts(connectionId: string): Promise<RemoteListeningPort[]> {
    return api.invoke<RemoteListeningPort[]>('ssh_list_remote_listening_ports', { connectionId });
  },
};
