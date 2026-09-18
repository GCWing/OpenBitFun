import { WorkspaceCatalog, mergeLegacyWorkspaces } from './WorkspaceCatalog';
import { AssistantEntry, RecentWorkspaceEntry, RemoteSession, RemoteWorkspaceIdentity } from '../model/RemoteModels';
import { AccountDeviceDirectorySource } from './AccountDeviceDirectory';
import {
  CONCURRENT_WORKSPACE_LISTINGS,
  mapInConcurrentBatches,
  mergeUniqueSessions
} from './ConcurrentWorkspaceListing';
import { RemoteLogger } from './RemoteLogger';
import { stampRemoteSessionsWorkspace } from './RemoteSessionIdentity';

export interface DeviceDirectoryCatalog {
  workspaces: RecentWorkspaceEntry[];
  sessions: RemoteSession[];
}

/**
 * Fans a device's recent workspaces out into session lists.
 *
 * The active conversation transport is not used here: each listing goes through
 * the injected directory, which builds a one-shot transport for that device.
 */
export class DeviceDirectoryCoordinator {
  private readonly directory: AccountDeviceDirectorySource;
  private readonly concurrency: number;

  constructor(
    directory: AccountDeviceDirectorySource,
    concurrency: number = CONCURRENT_WORKSPACE_LISTINGS
  ) {
    this.directory = directory;
    this.concurrency = concurrency;
  }

  async loadDeviceCatalog(deviceId: string): Promise<DeviceDirectoryCatalog> {
    const workspaces = await this.loadWorkspaces(deviceId);
    return {
      workspaces,
      sessions: await this.loadSessions(deviceId, workspaces)
    };
  }

  async loadWorkspaces(deviceId: string): Promise<RecentWorkspaceEntry[]> {
    return (await this.loadWorkspaceCatalog(deviceId)).workspaces;
  }

  async loadWorkspaceCatalog(deviceId: string): Promise<WorkspaceCatalog> {
    return await this.directory.listWorkspaceCatalog(deviceId);
  }

  async loadSessions(
    deviceId: string,
    workspaces: RecentWorkspaceEntry[]
  ): Promise<RemoteSession[]> {
    const groups = await mapInConcurrentBatches(
      workspaces,
      (entry: RecentWorkspaceEntry): Promise<RemoteSession[]> => {
        return this.safeSessionsForWorkspace(deviceId, entry);
      },
      this.concurrency
    );
    return mergeUniqueSessions(groups);
  }

  /** One explicit workspace listing; used by the lazy sidebar disclosure. */
  async loadWorkspaceSessions(deviceId: string, workspace: RemoteWorkspaceIdentity): Promise<RemoteSession[]> {
    return stampRemoteSessionsWorkspace(await this.directory.listSessions(deviceId, workspace), workspace);
  }

  private async safeSessionsForWorkspace(deviceId: string, workspace: RemoteWorkspaceIdentity): Promise<RemoteSession[]> {
    try {
      return await this.loadWorkspaceSessions(deviceId, workspace);
    } catch (err) {
      // One unreadable workspace is not a reason to lose the other twenty.
      RemoteLogger.warn(`load workspace sessions failed device=${deviceId} workspace=${workspace.workspaceId || ''} path=${workspace.path}: ${String(err)}`);
      return [];
    }
  }

  static mergeWorkspaces(
    recent: RecentWorkspaceEntry[],
    assistants: AssistantEntry[]
  ): RecentWorkspaceEntry[] {
    return mergeLegacyWorkspaces(recent, assistants);
  }
}
