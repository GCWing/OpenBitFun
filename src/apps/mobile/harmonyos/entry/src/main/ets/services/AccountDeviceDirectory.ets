import { WorkspaceCatalog, projectWorkspaceCatalog } from './WorkspaceCatalog';
import {
  AssistantEntry,
  AssistantListResponse,
  RecentWorkspaceEntry,
  RecentWorkspaceListResponse,
  REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1,
  RemoteSession,
  RemoteWorkspaceIdentity,
  SessionListResponse,
  WorkspaceInfoResponse
} from '../model/RemoteModels';
import { CloudAccountBinding } from './CloudAccountClient';
import { RemoteI18n } from '../i18n/RemoteI18n';
import {
  AccountDeviceCommandTransport,
  INTERACTIVE_DIRECTORY_TIMEOUT_MS
} from './RemoteCommandTransport';
import { RemoteCommandFactory } from './RemoteCommandFactory';
import { RemoteResponseMapper } from './RemoteResponseMapper';
import { stampRemoteSessionsDevice, stampRemoteSessionsWorkspace } from './RemoteSessionIdentity';

export interface AccountDeviceDirectorySource {
  listWorkspaceCatalog(deviceId: string): Promise<WorkspaceCatalog>;
  listRecentWorkspaces(deviceId: string): Promise<RecentWorkspaceEntry[]>;
  listAssistants(deviceId: string): Promise<AssistantEntry[]>;
  listSessions(deviceId: string, workspace: RemoteWorkspaceIdentity): Promise<RemoteSession[]>;
}

/** Read-only per-device RPCs that never touch the active conversation transport. */
export class AccountDeviceDirectory implements AccountDeviceDirectorySource {
  private readonly context: CloudAccountBinding;
  /**
   * Capabilities each directory device advertised, probed once per device.
   *
   * Directory listings do not go through the handshake of the active
   * connection, so a device's capability set is learned here before the first
   * command that would carry a `workspace_id` to it.
   */
  private readonly deviceCapabilities: Map<string, string[]> = new Map<string, string[]>();

  constructor(context: CloudAccountBinding) {
    this.context = context;
  }

  async listWorkspaceCatalog(deviceId: string): Promise<WorkspaceCatalog> {
    const response = await this.transport(deviceId).send<RecentWorkspaceListResponse>(RemoteCommandFactory.listRecentWorkspaces());
    return projectWorkspaceCatalog(response, await this.listAssistants(deviceId));
  }

  async listRecentWorkspaces(deviceId: string): Promise<RecentWorkspaceEntry[]> {
    const response = await this.transport(deviceId).send<RecentWorkspaceListResponse>(
      RemoteCommandFactory.listRecentWorkspaces()
    );
    return RemoteResponseMapper.recentWorkspaces(response.workspaces || []);
  }

  async listAssistants(deviceId: string): Promise<AssistantEntry[]> {
    const response = await this.transport(deviceId).send<AssistantListResponse>(
      RemoteCommandFactory.listAssistants()
    );
    return response.assistants || [];
  }

  async listSessions(deviceId: string, workspace: RemoteWorkspaceIdentity): Promise<RemoteSession[]> {
    const scope: RemoteWorkspaceIdentity = {
      workspaceId: workspace.workspaceId || undefined,
      path: workspace.path.trim(),
      remoteConnectionId: workspace.remoteConnectionId,
      remoteSshHost: workspace.remoteSshHost
    };
    if (!scope.workspaceId && scope.path.length === 0) {
      return [];
    }
    if (scope.workspaceId) {
      await this.requireWorkspaceIdReferences(deviceId);
    }
    const response = await this.transport(deviceId).send<SessionListResponse>(
      RemoteCommandFactory.listSessions(scope, 50, 0, ''),
      INTERACTIVE_DIRECTORY_TIMEOUT_MS
    );
    const sessions = stampRemoteSessionsWorkspace(RemoteResponseMapper.sessions(response.sessions || []), scope);
    return stampRemoteSessionsDevice(sessions, deviceId);
  }

  /** Rejects an ID-carrying listing to a device that never advertised ID references. */
  private async requireWorkspaceIdReferences(deviceId: string): Promise<void> {
    let capabilities = this.deviceCapabilities.get(deviceId);
    if (capabilities === undefined) {
      const response = await this.transport(deviceId).send<WorkspaceInfoResponse>(
        RemoteCommandFactory.getWorkspaceInfo(),
        INTERACTIVE_DIRECTORY_TIMEOUT_MS
      );
      capabilities = (response.capabilities || []).slice();
      this.deviceCapabilities.set(deviceId, capabilities);
    }
    if (capabilities.indexOf(REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1) < 0) {
      throw new Error(RemoteI18n.t('errors.workspaceIdUnsupported'));
    }
  }

  private transport(deviceId: string): AccountDeviceCommandTransport {
    return new AccountDeviceCommandTransport(
      this.context.client,
      this.context.relayUrl,
      this.context.session,
      deviceId
    );
  }
}
