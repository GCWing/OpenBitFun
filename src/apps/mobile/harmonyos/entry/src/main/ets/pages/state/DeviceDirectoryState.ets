import { RecentWorkspaceEntry, RemoteSession } from '../../model/RemoteModels';

export type DeviceDirectoryStatus = 'idle' | 'cached' | 'loading' | 'ready' | 'failed';
export type WorkspaceDirectoryStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** Disclosure and lazy-load state that must outlive a sidebar component. */
@ObservedV2
export class WorkspaceDirectoryState {
  @Trace deviceId: string = '';
  @Trace path: string = '';
  @Trace remoteConnectionId: string = '';
  @Trace remoteSshHost: string = '';
  @Trace expanded: boolean = false;
  @Trace status: WorkspaceDirectoryStatus = 'idle';
  @Trace hasLoadedSessions: boolean = false;
}

/**
 * One account desktop in the sidebar. Nested @Trace fields are what
 * SidebarDeviceGroup actually watches — replacing a plain object on
 * the parent array does not update a reused ForEach child.
 */
@ObservedV2
export class DeviceDirectoryEntry {
  @Trace deviceId: string = '';
  @Trace deviceName: string = '';
  @Trace online: boolean = false;
  @Trace expanded: boolean = false;
  @Trace status: DeviceDirectoryStatus = 'idle';
  @Trace errorText: string = '';
  @Trace workspaces: RecentWorkspaceEntry[] = [];
  @Trace catalogSource: string = '';
  @Trace recentWorkspaces: RecentWorkspaceEntry[] = [];
  @Trace sessions: RemoteSession[] = [];
}

/** Snapshot of every account desktop the sidebar can observe. */
@ObservedV2
export class DeviceDirectoryState {
  @Trace refreshing: boolean = false;
  @Trace refreshError: string = '';
  refreshGeneration: number = 0;
  @Trace devices: DeviceDirectoryEntry[] = [];
  /** Disclosure state is independent of device catalog projection instances. */
  @Trace workspaceDirectory: WorkspaceDirectoryState[] = [];
  /** Device whose workspaces are projected below the flat device list. */
  @Trace selectedDeviceId: string = '';

  replace(devices: DeviceDirectoryEntry[]): void {
    this.devices = devices;
  }

  clear(): void {
    this.refreshGeneration++; this.refreshing = false; this.refreshError = '';
    this.devices = [];
    this.workspaceDirectory = [];
    this.selectedDeviceId = '';
  }

  select(deviceId: string): void {
    this.selectedDeviceId = deviceId.trim();
  }

  /** Collapses the disclosed device without changing the live control target. */
  collapseIfSelected(deviceId: string): boolean {
    if (this.selectedDeviceId !== deviceId.trim()) {
      return false;
    }
    this.selectedDeviceId = '';
    return true;
  }

  find(deviceId: string): DeviceDirectoryEntry | undefined {
    return this.devices.find((item: DeviceDirectoryEntry): boolean => item.deviceId === deviceId);
  }

  workspaceExpanded(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): boolean {
    return this.findWorkspace(deviceId, path, remoteConnectionId, remoteSshHost)?.expanded || false;
  }

  workspaceStatus(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): WorkspaceDirectoryStatus {
    return this.findWorkspace(deviceId, path, remoteConnectionId, remoteSshHost)?.status || 'idle';
  }

  workspaceHasLoadedSessions(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): boolean {
    return this.findWorkspace(deviceId, path, remoteConnectionId, remoteSshHost)?.hasLoadedSessions || false;
  }

  /** A request retains this object so a reset cannot publish into its successor. */
  workspaceLoadState(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): WorkspaceDirectoryState {
    return this.ensureWorkspace(deviceId, path, remoteConnectionId, remoteSshHost);
  }

  isCurrentWorkspaceLoad(state: WorkspaceDirectoryState): boolean {
    return this.findWorkspace(state.deviceId, state.path, state.remoteConnectionId, state.remoteSshHost) === state;
  }

  setWorkspaceExpanded(deviceId: string, path: string, expanded: boolean, remoteConnectionId?: string, remoteSshHost?: string): void {
    this.ensureWorkspace(deviceId, path, remoteConnectionId, remoteSshHost).expanded = expanded;
  }

  setWorkspaceStatus(deviceId: string, path: string, status: WorkspaceDirectoryStatus, remoteConnectionId?: string, remoteSshHost?: string): void {
    this.ensureWorkspace(deviceId, path, remoteConnectionId, remoteSshHost).status = status;
  }

  /**
   * Drops disclosure and load facts produced by an older connection to one device.
   *
   * A fresh control-target handshake only contains the current workspace's
   * sessions. Keeping a sibling workspace marked `ready` after that partial
   * snapshot replaces the directory makes its next disclosure skip the RPC and
   * render a false empty result. Other devices keep their independent state.
   */
  resetWorkspaceDirectory(deviceId: string): void {
    const targetDeviceId = deviceId.trim();
    if (targetDeviceId.length === 0) {
      return;
    }
    this.workspaceDirectory = this.workspaceDirectory.filter((item: WorkspaceDirectoryState): boolean =>
      item.deviceId !== targetDeviceId
    );
  }

  private findWorkspace(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): WorkspaceDirectoryState | undefined {
    const targetDeviceId = deviceId.trim();
    const normalizedPath = DeviceDirectoryState.normalizeWorkspacePath(path);
    return this.workspaceDirectory.find((item: WorkspaceDirectoryState): boolean =>
      item.deviceId === targetDeviceId && item.path === normalizedPath &&
      item.remoteConnectionId === (remoteConnectionId?.trim() || '') && item.remoteSshHost === (remoteSshHost?.trim() || '')
    );
  }

  private ensureWorkspace(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): WorkspaceDirectoryState {
    const targetDeviceId = deviceId.trim();
    const normalizedPath = DeviceDirectoryState.normalizeWorkspacePath(path);
    const existing = this.findWorkspace(targetDeviceId, normalizedPath, remoteConnectionId, remoteSshHost);
    if (existing) {
      return existing;
    }
    const created = new WorkspaceDirectoryState();
    created.deviceId = targetDeviceId;
    created.path = normalizedPath;
    created.remoteConnectionId = remoteConnectionId?.trim() || '';
    created.remoteSshHost = remoteSshHost?.trim() || '';
    this.workspaceDirectory = this.workspaceDirectory.concat([created]);
    return created;
  }

  private static normalizeWorkspacePath(path: string): string {
    const normalized = path.trim().replace(/\/+$/, '');
    return normalized.length > 0 ? normalized : path.trim();
  }
}

export function emptyDeviceDirectoryEntry(
  deviceId: string,
  deviceName: string,
  online: boolean
): DeviceDirectoryEntry {
  const entry = new DeviceDirectoryEntry();
  entry.deviceId = deviceId;
  entry.deviceName = deviceName;
  entry.online = online;
  return entry;
}
