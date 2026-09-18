import { RecentWorkspaceEntry, RemoteSession, RemoteWorkspaceIdentity } from '../../model/RemoteModels';
import { remoteWorkspaceIdentityMatches } from '../../services/RemoteSessionIdentity';

export type DeviceDirectoryStatus = 'idle' | 'cached' | 'loading' | 'ready' | 'failed';
export type WorkspaceDirectoryStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** Disclosure and lazy-load state that must outlive a sidebar component. */
@ObservedV2
export class WorkspaceDirectoryState {
  @Trace deviceId: string = '';
  @Trace path: string = '';
  @Trace remoteConnectionId: string = '';
  @Trace remoteSshHost: string = '';
  /** Stable record ID of the disclosed row; empty for rows from pre-ID hosts. */
  @Trace workspaceId: string = '';
  @Trace expanded: boolean = false;
  @Trace status: WorkspaceDirectoryStatus = 'idle';
  @Trace hasLoadedSessions: boolean = false;

  /** The disclosed row as a workspace reference for listings and attribution. */
  workspaceIdentity(): RemoteWorkspaceIdentity {
    return {
      workspaceId: this.workspaceId.length > 0 ? this.workspaceId : undefined,
      path: this.path,
      remoteConnectionId: this.remoteConnectionId.length > 0 ? this.remoteConnectionId : undefined,
      remoteSshHost: this.remoteSshHost.length > 0 ? this.remoteSshHost : undefined
    };
  }
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

  find(deviceId: string): DeviceDirectoryEntry | undefined {
    return this.devices.find((item: DeviceDirectoryEntry): boolean => item.deviceId === deviceId);
  }

  workspaceExpanded(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): boolean {
    return this.findWorkspace(deviceId, path, remoteConnectionId, remoteSshHost, workspaceId)?.expanded || false;
  }

  workspaceStatus(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): WorkspaceDirectoryStatus {
    return this.findWorkspace(deviceId, path, remoteConnectionId, remoteSshHost, workspaceId)?.status || 'idle';
  }

  workspaceHasLoadedSessions(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): boolean {
    return this.findWorkspace(deviceId, path, remoteConnectionId, remoteSshHost, workspaceId)?.hasLoadedSessions || false;
  }

  /** A request retains this object so a reset cannot publish into its successor. */
  workspaceLoadState(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): WorkspaceDirectoryState {
    return this.ensureWorkspace(deviceId, path, remoteConnectionId, remoteSshHost, workspaceId);
  }

  isCurrentWorkspaceLoad(state: WorkspaceDirectoryState): boolean {
    return this.findWorkspace(state.deviceId, state.path, state.remoteConnectionId, state.remoteSshHost, state.workspaceId) === state;
  }

  setWorkspaceExpanded(deviceId: string, path: string, expanded: boolean, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): void {
    this.ensureWorkspace(deviceId, path, remoteConnectionId, remoteSshHost, workspaceId).expanded = expanded;
  }

  setWorkspaceStatus(deviceId: string, path: string, status: WorkspaceDirectoryStatus, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string): void {
    this.ensureWorkspace(deviceId, path, remoteConnectionId, remoteSshHost, workspaceId).status = status;
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

  /**
   * Rows are matched like every other workspace reference: by ID when both
   * sides carry one, by the legacy triple otherwise. Disclosure rows are
   * device-local, so no catalog is needed to attribute an ID-less side.
   */
  private findWorkspace(
    deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string
  ): WorkspaceDirectoryState | undefined {
    const targetDeviceId = deviceId.trim();
    const target: RemoteWorkspaceIdentity = DeviceDirectoryState.identityOf(path, remoteConnectionId, remoteSshHost, workspaceId);
    return this.workspaceDirectory.find((item: WorkspaceDirectoryState): boolean =>
      item.deviceId === targetDeviceId && remoteWorkspaceIdentityMatches(item.workspaceIdentity(), target, [])
    );
  }

  private ensureWorkspace(
    deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string
  ): WorkspaceDirectoryState {
    const targetDeviceId = deviceId.trim();
    const target: RemoteWorkspaceIdentity = DeviceDirectoryState.identityOf(path, remoteConnectionId, remoteSshHost, workspaceId);
    const existing = this.findWorkspace(targetDeviceId, target.path, target.remoteConnectionId, target.remoteSshHost, target.workspaceId);
    if (existing) {
      if (existing.workspaceId.length === 0 && target.workspaceId !== undefined) {
        existing.workspaceId = target.workspaceId;
      }
      return existing;
    }
    const created = new WorkspaceDirectoryState();
    created.deviceId = targetDeviceId;
    created.path = target.path;
    created.remoteConnectionId = target.remoteConnectionId || '';
    created.remoteSshHost = target.remoteSshHost || '';
    created.workspaceId = target.workspaceId || '';
    this.workspaceDirectory = this.workspaceDirectory.concat([created]);
    return created;
  }

  private static identityOf(
    path: string, remoteConnectionId?: string, remoteSshHost?: string, workspaceId?: string
  ): RemoteWorkspaceIdentity {
    const id = workspaceId?.trim() || '';
    const connectionId = remoteConnectionId?.trim() || '';
    const sshHost = remoteSshHost?.trim() || '';
    return {
      workspaceId: id.length > 0 ? id : undefined,
      path: DeviceDirectoryState.normalizeWorkspacePath(path),
      remoteConnectionId: connectionId.length > 0 ? connectionId : undefined,
      remoteSshHost: sshHost.length > 0 ? sshHost : undefined
    };
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
