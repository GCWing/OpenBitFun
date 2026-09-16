import { WorkspaceCatalog } from './WorkspaceCatalog';
import { SavedRuntimeConnection, AssistantEntry, RecentWorkspaceEntry, RemoteSession, WorkspaceInfo } from '../model/RemoteModels';
import {
  CONCURRENT_WORKSPACE_LISTINGS,
  mapInConcurrentBatches,
  mergeUniqueSessions
} from './ConcurrentWorkspaceListing';
import { RemoteWorkspaceDataSource } from './RemoteWorkspaceRepository';
import { RemoteLogger } from './RemoteLogger';

/** Coordinates workspace/assistant selection and cross-workspace session discovery. */
export class RemoteWorkspaceCoordinator {
  private readonly repository: RemoteWorkspaceDataSource;

  constructor(repository: RemoteWorkspaceDataSource) {
    this.repository = repository;
  }

  async workspaceCatalog(): Promise<WorkspaceCatalog> {
    return await this.repository.listWorkspaceCatalog();
  }

  async recentWorkspaces(): Promise<RecentWorkspaceEntry[]> {
    return await this.repository.listRecentWorkspaces();
  }

  async assistants(): Promise<AssistantEntry[]> {
    return await this.repository.listAssistants();
  }

  async savedConnections(): Promise<SavedRuntimeConnection[]> { return await this.repository.savedConnections(); }

  async switchWorkspace(path: string, connectionId?: string, sshHost?: string): Promise<WorkspaceInfo> {
    return await this.repository.setWorkspace(path, connectionId, sshHost);
  }

  async switchAssistant(path: string): Promise<WorkspaceInfo> {
    return await this.repository.setAssistant(path);
  }

  /**
   * Every session the given workspaces know about, first occurrence winning.
   *
   * Listings run a batch at a time rather than all at once or one at a time,
   * and results are merged in the order the paths were given, so widening the
   * batch changes how long this takes and nothing about what it returns.
   */
  async sessionsForWorkspaces(paths: string[]): Promise<RemoteSession[]> {
    const listings = await mapInConcurrentBatches(
      paths,
      (path: string): Promise<RemoteSession[]> => this.sessionsForWorkspace(path),
      CONCURRENT_WORKSPACE_LISTINGS
    );
    return mergeUniqueSessions(listings);
  }

  /** One workspace's sessions, or none when that workspace cannot be read. */
  private async sessionsForWorkspace(path: string): Promise<RemoteSession[]> {
    try {
      return await this.repository.listSessionsForWorkspace(path, 50);
    } catch (err) {
      // One unreadable workspace is not a reason to lose the other twenty.
      RemoteLogger.warn(`load workspace sessions failed path=${path}: ${String(err)}`);
      return [];
    }
  }
}
