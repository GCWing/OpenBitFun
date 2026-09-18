import { WorkspaceCatalog } from './WorkspaceCatalog';
import {
  SavedRuntimeConnection,
  AssistantEntry,
  RecentWorkspaceEntry,
  RemoteSession,
  RemoteWorkspaceIdentity,
  WorkspaceInfo
} from '../model/RemoteModels';
import { RemoteSessionManager } from './RemoteSessionManager';

export interface RemoteWorkspaceDataSource {
  listWorkspaceCatalog(): Promise<WorkspaceCatalog>;
  savedConnections(): Promise<SavedRuntimeConnection[]>;
  listRecentWorkspaces(): Promise<RecentWorkspaceEntry[]>;
  setWorkspace(path: string, connectionId?: string, sshHost?: string, workspaceId?: string): Promise<WorkspaceInfo>;
  listAssistants(): Promise<AssistantEntry[]>;
  setAssistant(path: string, workspaceId?: string): Promise<WorkspaceInfo>;
  listSessionsForWorkspace(workspace: RemoteWorkspaceIdentity, limit: number): Promise<RemoteSession[]>;
  ping(): Promise<void>;
  reset(): void;
}

/** Repository boundary for workspace, assistant and connection health data. */
export class RemoteWorkspaceRepository implements RemoteWorkspaceDataSource {
  private readonly sessionManager: RemoteSessionManager;

  constructor(sessionManager: RemoteSessionManager) {
    this.sessionManager = sessionManager;
  }

  async savedConnections(): Promise<SavedRuntimeConnection[]> { return await this.sessionManager.savedConnections(); }

  async listWorkspaceCatalog(): Promise<WorkspaceCatalog> {
    return await this.sessionManager.listWorkspaceCatalog();
  }

  async listRecentWorkspaces(): Promise<RecentWorkspaceEntry[]> {
    return await this.sessionManager.listRecentWorkspaces();
  }

  async setWorkspace(path: string, connectionId?: string, sshHost?: string, workspaceId?: string): Promise<WorkspaceInfo> {
    await this.sessionManager.setWorkspace(path, connectionId, sshHost, workspaceId);
    return await this.sessionManager.getWorkspaceInfo();
  }

  async listAssistants(): Promise<AssistantEntry[]> {
    return await this.sessionManager.listAssistants();
  }

  async setAssistant(path: string, workspaceId?: string): Promise<WorkspaceInfo> {
    await this.sessionManager.setAssistant(path, workspaceId);
    return await this.sessionManager.getWorkspaceInfo();
  }

  async listSessionsForWorkspace(workspace: RemoteWorkspaceIdentity, limit: number): Promise<RemoteSession[]> {
    return await this.sessionManager.listSessionsForWorkspace(workspace, limit);
  }

  async ping(): Promise<void> {
    await this.sessionManager.ping();
  }

  reset(): void {
    this.sessionManager.reset();
  }
}
