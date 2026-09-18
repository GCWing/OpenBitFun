import { WorkspaceCatalog, projectWorkspaceCatalog } from './WorkspaceCatalog';
import { RuntimeFileLocation } from '../model/RemoteModels';
import { DurableSessionCallbacks, DurableSessionStream } from './DurableSessionStream';
import { SavedRuntimeConnection, SavedRuntimeConnectionsResponse } from '../model/RemoteModels';
import { AssistantEntry, AssistantListResponse, ChatMessageItemResponse, ChatMessageResponse, CommandStatusResponse, CreateSessionOptions, CreateSessionResponse, FileInfo, FileInfoResponse, InitialSyncResult, ModelCatalogResponse, PermissionModeResponse, PollSessionResponse, PollSessionResult, ReadFileChunkResponse, ReadFileChunkResult, ReadFileResult, RecentWorkspaceEntry, RecentWorkspaceListResponse, RemoteCommand, RemoteImageContext, RemoteModelCatalog, RemotePermissionMode, RemoteQuestionAnswerPayload, RemoteSession, RemoteWorkspaceIdentity, REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1, SendMessageResponse, SessionListResponse, SessionListResult, SessionMessagesResponse, SessionMessagesResult, SessionSummary, SetAssistantResponse, SetSessionModelResponse, SetWorkspaceResponse, SteerTurnResponse, SteerTurnResult, WorkspaceInfo, WorkspaceInfoResponse } from '../model/RemoteModels';
import { Encoding } from './Encoding';
import { CloudAccountClient, CloudAccountRequestError, CloudAccountSession } from './CloudAccountClient';
import { RemoteI18n } from '../i18n/RemoteI18n';
import {
  AccountDeviceCommandTransport,
  INTERACTIVE_DIRECTORY_TIMEOUT_MS,
  RemoteCommandTransport
} from './RemoteCommandTransport';
import { RemoteCommandFactory } from './RemoteCommandFactory';
import { RemoteChatCommandClient } from './RemoteChatCommandController';
import { RemoteFileDownloadClient } from './RemoteFileDownloadController';
import { RemoteLogger } from './RemoteLogger';
import { RemoteModelClient } from './RemoteModelController';
import { RemoteResponseMapper } from './RemoteResponseMapper';
import { stampRemoteSessionsWorkspace } from './RemoteSessionIdentity';
import { TranscriptIntegrityPolicy } from './TranscriptIntegrityPolicy';
import { RemoteSessionClient } from './RemoteSessionController';
import { RemoteToolActionClient } from './RemoteToolActionController';

/**
 * How long the first command of an account-device connect may take.
 *
 * A desktop that is actually running answers `get_workspace_info` from memory,
 * so anything past a few seconds means it is not there. The relay waits 130 s
 * before giving up on it, and the phone tears the previous connection down
 * before dialling — so without a deadline of our own, tapping a session on a
 * desktop that has gone away costs two minutes of a blank screen. Only the
 * handshake is bounded this tightly; once the desktop has answered once, the
 * longer transport default applies to everything after it.
 */
const ACCOUNT_HANDSHAKE_TIMEOUT_MS: number = 15000;

interface PermissionReplyArgs { request: PermissionReplyRequest; }
interface PermissionReplyRequest { requestId: string; reply: string; feedback?: string; updatedInput?: Object; }

export class RemoteSessionManager implements RemoteChatCommandClient, RemoteFileDownloadClient, RemoteModelClient, RemoteSessionClient, RemoteToolActionClient {
  private transport?: RemoteCommandTransport;
  private transportGeneration: number = 0;
  private workspace?: WorkspaceInfo;
  /** Capabilities the connected host advertised in its handshake response. */
  private hostCapabilities: string[] = [];

  subscribeSession(logicalId: string, callbacks: DurableSessionCallbacks): DurableSessionStream {
    const transport = this.transport;
    if (!transport?.subscribeSession) throw new Error('Remote session streaming is unavailable');
    return transport.subscribeSession(logicalId, callbacks);
  }

  async hostInvoke<T>(command: string, args: Object): Promise<T> {
    const response = await this.send<HostInvokeResponse<T>>({ cmd: 'host_invoke', command: command, args: args });
    if (!response.ok) throw new Error(response.error || 'Remote host operation failed');
    return response.value as T;
  }

  reset(): void {
    this.beginTransportReplacement();
  }

  private beginTransportReplacement(): number {
    this.transportGeneration += 1;
    this.transport?.reset();
    this.transport = undefined;
    this.workspace = undefined;
    this.hostCapabilities = [];
    return this.transportGeneration;
  }

  private requireCurrentGeneration(generation: number): void {
    if (generation !== this.transportGeneration) {
      throw new Error('Remote target changed while the connection was in flight.');
    }
  }

  async connectAccountDevice(
    accountClient: CloudAccountClient,
    relayUrl: string,
    session: CloudAccountSession,
    targetDeviceId: string
  ): Promise<InitialSyncResult> {
    const generation = this.beginTransportReplacement();
    const transport = new AccountDeviceCommandTransport(accountClient, relayUrl, session, targetDeviceId);
    let workspaceResponse: WorkspaceInfoResponse;
    try {
      workspaceResponse = await this.sendOnTransport<WorkspaceInfoResponse>(
        transport,
        generation,
        RemoteCommandFactory.getWorkspaceInfo(),
        ACCOUNT_HANDSHAKE_TIMEOUT_MS
      );
    } catch (err) {
      transport.reset();
      throw RemoteSessionManager.handshakeFailure(err);
    }
    try {
      const workspace = RemoteResponseMapper.workspaceFromResponse(workspaceResponse);
      const capabilities = workspaceResponse.capabilities || [];
      const scope = RemoteSessionManager.workspaceScope(workspace);
      RemoteSessionManager.requireWorkspaceIdReferences(scope, capabilities);
      const sessionResponse = await this.sendOnTransport<SessionListResponse>(
        transport,
        generation,
        RemoteCommandFactory.listSessions(scope, 50, 0, '')
      );
      const sessions = stampRemoteSessionsWorkspace(RemoteResponseMapper.sessions(sessionResponse.sessions || []), scope);
      this.requireCurrentGeneration(generation);
      this.transport = transport;
      this.workspace = workspace;
      this.hostCapabilities = capabilities.slice();
      return {
        workspace,
        sessions,
        hasMoreSessions: sessionResponse.has_more || false,
        authenticatedUserId: session.userId,
        capabilities
      };
    } catch (err) {
      transport.reset();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const response = await this.send<WorkspaceInfoResponse>(RemoteCommandFactory.getWorkspaceInfo());
    return RemoteResponseMapper.workspaceFromResponse(response);
  }

  async listWorkspaceCatalog(): Promise<WorkspaceCatalog> {
    const response = await this.send<RecentWorkspaceListResponse>(RemoteCommandFactory.listRecentWorkspaces());
    return projectWorkspaceCatalog(response, await this.listAssistants());
  }

  async listRecentWorkspaces(): Promise<RecentWorkspaceEntry[]> {
    const response = await this.send<RecentWorkspaceListResponse>(RemoteCommandFactory.listRecentWorkspaces());
    return RemoteResponseMapper.recentWorkspaces(response.workspaces || []);
  }

  async savedConnections(): Promise<SavedRuntimeConnection[]> {
    const command: RemoteCommand = { cmd: 'host_invoke', command: 'ssh_list_saved_connections' };
    const response = await this.send<SavedRuntimeConnectionsResponse>(command);
    if (!response.ok) throw new Error(response.error || 'Saved connections unavailable');
    return response.value || [];
  }

  /**
   * Whether the connected host resolves `workspace_id` in commands.
   *
   * Read from the `capabilities` array of the handshake response. Absent on
   * pre-ID hosts, where only references that never had an ID may be sent.
   */
  supportsWorkspaceIdReferences(): boolean {
    return (this.hostCapabilities || []).indexOf(REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1) >= 0;
  }

  /**
   * Guards every command that would carry a `workspace_id`.
   *
   * A reference with an ID must never be downgraded to its display path: an
   * ID-aware host could then open a different workspace under the same path,
   * and a pre-ID host would silently do so. Surfacing the unsupported state is
   * the only correct degradation.
   */
  private static requireWorkspaceIdReferences(scope: RemoteWorkspaceIdentity, capabilities: string[]): void {
    if (!scope.workspaceId) return;
    if (capabilities.indexOf(REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1) >= 0) return;
    throw new Error(RemoteI18n.t('errors.workspaceIdUnsupported'));
  }

  private requireWorkspaceIdReference(scope: RemoteWorkspaceIdentity): void {
    RemoteSessionManager.requireWorkspaceIdReferences(scope, this.hostCapabilities || []);
  }

  private static workspaceScope(workspace: WorkspaceInfo | undefined): RemoteWorkspaceIdentity {
    return {
      workspaceId: workspace?.workspaceId || undefined,
      path: workspace?.path || '',
      remoteConnectionId: workspace?.remoteConnectionId,
      remoteSshHost: workspace?.remoteSshHost
    };
  }

  async setWorkspace(path: string, connectionId?: string, sshHost?: string, workspaceId?: string): Promise<void> {
    const scope: RemoteWorkspaceIdentity = {
      workspaceId: workspaceId || undefined,
      path,
      remoteConnectionId: connectionId,
      remoteSshHost: sshHost
    };
    this.requireWorkspaceIdReference(scope);
    const command = RemoteCommandFactory.setWorkspace(path, scope.workspaceId, connectionId, sshHost);
    const response = await this.send<SetWorkspaceResponse>(command);
    if (response.success !== true) {
      throw new Error(response.error || 'Failed to set workspace.');
    }
    this.workspace = await this.getWorkspaceInfo();
  }

  async listAssistants(): Promise<AssistantEntry[]> {
    const response = await this.send<AssistantListResponse>(RemoteCommandFactory.listAssistants());
    return response.assistants || [];
  }

  async setAssistant(path: string, workspaceId?: string): Promise<void> {
    const scope: RemoteWorkspaceIdentity = { workspaceId: workspaceId || undefined, path };
    this.requireWorkspaceIdReference(scope);
    const response = await this.send<SetAssistantResponse>(RemoteCommandFactory.setAssistant(path, scope.workspaceId));
    if (response.success !== true) {
      throw new Error(response.error || 'Failed to set assistant workspace.');
    }
    this.workspace = await this.getWorkspaceInfo();
  }

  async listRecentSessions(): Promise<RemoteSession[]> {
    const result = await this.listSessions(8, 0, '', '');
    return result.sessions;
  }

  async listSessionsForWorkspace(workspace: RemoteWorkspaceIdentity, limit: number = 50): Promise<RemoteSession[]> {
    return (await this.listSessionPageForWorkspace(workspace, limit)).sessions;
  }

  async listSessionPageForWorkspace(workspace: RemoteWorkspaceIdentity, limit: number = 50): Promise<SessionListResult> {
    const scope: RemoteWorkspaceIdentity = {
      workspaceId: workspace.workspaceId || undefined,
      path: workspace.path.trim(),
      remoteConnectionId: workspace.remoteConnectionId,
      remoteSshHost: workspace.remoteSshHost
    };
    if (!scope.workspaceId && scope.path.length === 0) {
      return { sessions: [], hasMore: false };
    }
    this.requireWorkspaceIdReference(scope);
    const response = await this.send<SessionListResponse>(
      RemoteCommandFactory.listSessions(scope, limit, 0, ''),
      INTERACTIVE_DIRECTORY_TIMEOUT_MS
    );
    return {
      sessions: stampRemoteSessionsWorkspace(RemoteResponseMapper.sessions(response.sessions || []), scope),
      hasMore: response.has_more || false
    };
  }

  async listSessions(limit: number, offset: number, query: string, agentType: string): Promise<SessionListResult> {
    const scope = RemoteSessionManager.workspaceScope(this.workspace);
    this.requireWorkspaceIdReference(scope);
    const normalizedAgentType = RemoteSessionManager.normalizedSessionFilter(agentType);
    const trimmedQuery = query.trim();
    const pageSize = normalizedAgentType ? Math.max(100, limit) : Math.max(1, limit);
    const targetCount = offset + limit;
    const filteredSessions: RemoteSession[] = [];
    let pageOffset = 0;
    let hasMore = true;
    while (hasMore && filteredSessions.length < targetCount) {
      const command = RemoteCommandFactory.listSessions(scope, pageSize, pageOffset, trimmedQuery);
      const response = await this.send<SessionListResponse>(command);
      const sessions = stampRemoteSessionsWorkspace(RemoteResponseMapper.allSessions(response.sessions || []), scope);
      for (const session of sessions) {
        if (RemoteResponseMapper.isVisibleSession(session) &&
          (!normalizedAgentType || RemoteSessionManager.agentMatchesFilter(session.agentType, normalizedAgentType))) {
          filteredSessions.push(session);
        }
      }
      hasMore = response.has_more || false;
      pageOffset += sessions.length;
      if (sessions.length === 0) {
        break;
      }
    }
    return {
      sessions: filteredSessions.slice(offset, targetCount),
      hasMore: filteredSessions.length > targetCount || hasMore
    };
  }

  async createSession(
    options: CreateSessionOptions,
    onAllocated?: (session: SessionSummary) => Promise<void>
  ): Promise<SessionSummary> {
    const requestedPath = options.workspacePath?.trim() || '';
    const requestedWorkspaceId = options.workspaceId?.trim() || '';
    const workspacePath = requestedPath;
    this.requireWorkspaceIdReference({ workspaceId: requestedWorkspaceId || undefined, path: workspacePath });
    const command = RemoteCommandFactory.createSession(options, workspacePath);
    const response = await this.send<CreateSessionResponse>(command);
    const sessionId = response.session_id || response.id || '';
    if (!sessionId) throw new Error('Session creation returned no session identity');
    // The host answers with the record it actually created the session in; its
    // ID wins over whatever the caller asked for.
    const workspaceId = (response.workspace_id || '').trim() || (requestedWorkspaceId || undefined);
    const resolvedPath = response.workspace_path ?? workspacePath;
    const remoteConnectionId = response.workspace_path !== undefined ? response.remote_connection_id :
      (requestedPath ? options.remoteConnectionId : undefined);
    const remoteSshHost = response.workspace_path !== undefined ? response.remote_ssh_host :
      (requestedPath ? options.remoteSshHost : undefined);
    const normalizedAgentType = options.agentType.toLowerCase();
    const fallbackTitle = normalizedAgentType === 'claw' || normalizedAgentType === 'assistant' || normalizedAgentType === 'chat' ?
      'Assistant Session' : normalizedAgentType === 'cowork' ? 'Cowork Session' : 'Code Session';
    const title = response.title || fallbackTitle;
    if (onAllocated) {
      await onAllocated({
        sessionId,
        title,
        workspaceId,
        workspacePath: resolvedPath,
        remoteConnectionId,
        remoteSshHost,
        agentType: options.agentType
      });
    }
    const modelId = options.modelId?.trim() || '';
    if (modelId.length > 0) {
      await this.setSessionModel(sessionId, modelId);
    }
    let initialTurnId = '';
    if (options.instruction.trim().length > 0) {
      initialTurnId = await this.sendMessage(sessionId, options.instruction.trim(), options.agentType);
    }
    return {
      sessionId,
      title,
      workspaceId,
      workspacePath: resolvedPath,
      remoteConnectionId,
      remoteSshHost,
      agentType: options.agentType,
      initialTurnId
    };
  }

  async sendMessage(sessionId: string, text: string, agentType?: string, turnId?: string): Promise<string> {
    const startedAt = Date.now();
    RemoteLogger.info(`send_message start session=${RemoteSessionManager.shortId(sessionId)} len=${text.length}`);
    const response = await this.send<SendMessageResponse>(
      RemoteCommandFactory.sendMessage(sessionId, text, agentType, undefined, turnId)
    );
    RemoteLogger.info(`send_message done session=${RemoteSessionManager.shortId(sessionId)} turn=${response.turn_id || ''} ms=${Date.now() - startedAt}`);
    return response.turn_id || '';
  }

  async sendMessageWithImages(
    sessionId: string,
    text: string,
    agentType: string,
    imageContexts: RemoteImageContext[],
    turnId?: string
  ): Promise<string> {
    const startedAt = Date.now();
    RemoteLogger.info(`send_message_images start session=${RemoteSessionManager.shortId(sessionId)} len=${text.length} images=${imageContexts.length}`);
    const response =
      await this.send<SendMessageResponse>(
        RemoteCommandFactory.sendMessage(sessionId, text, agentType, imageContexts, turnId)
      );
    RemoteLogger.info(`send_message_images done session=${RemoteSessionManager.shortId(sessionId)} turn=${response.turn_id || ''} ms=${Date.now() - startedAt}`);
    return response.turn_id || '';
  }

  async steerTurn(
    sessionId: string,
    turnId: string,
    text: string,
    displayContent: string,
    imageContexts: RemoteImageContext[]
  ): Promise<SteerTurnResult> {
    const startedAt = Date.now();
    RemoteLogger.info(
      `steer_turn start session=${RemoteSessionManager.shortId(sessionId)} ` +
        `turn=${RemoteSessionManager.shortId(turnId)} len=${text.length} images=${imageContexts.length}`
    );
    const response = await this.send<SteerTurnResponse>(
      RemoteCommandFactory.steerTurn(sessionId, turnId, text, displayContent, imageContexts)
    );
    const result: SteerTurnResult = {
      sessionId: response.session_id || sessionId,
      turnId: response.turn_id || turnId,
      steeringId: response.steering_id || ''
    };
    if (result.steeringId.length === 0) {
      throw new Error('Remote host accepted steering without a steering id.');
    }
    RemoteLogger.info(
      `steer_turn done session=${RemoteSessionManager.shortId(result.sessionId)} ` +
        `turn=${RemoteSessionManager.shortId(result.turnId)} ms=${Date.now() - startedAt}`
    );
    return result;
  }

  async buildPlan(sessionId: string, planFilePath: string, planName: string, agentType: string): Promise<string> {
    const startedAt = Date.now();
    RemoteLogger.info(
      `build_plan start session=${RemoteSessionManager.shortId(sessionId)} path_len=${planFilePath.length}`
    );
    const response = await this.send<SendMessageResponse>(
      RemoteCommandFactory.buildPlan(sessionId, planFilePath, planName, agentType)
    );
    RemoteLogger.info(
      `build_plan done session=${RemoteSessionManager.shortId(sessionId)} ` +
        `turn=${response.turn_id || ''} ms=${Date.now() - startedAt}`
    );
    return response.turn_id || '';
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessagesResult> {
    const startedAt = Date.now();
    const response = await this.send<SessionMessagesResponse>(RemoteCommandFactory.getSessionMessages(sessionId));
    const rawMessages = response.messages || [];
    const messages = rawMessages.map((item: ChatMessageResponse) => RemoteResponseMapper.chatMessage(item));
    RemoteLogger.info(
      `get_session_messages done session=${RemoteSessionManager.shortId(sessionId)} ` +
        `raw=${rawMessages.length} ${TranscriptIntegrityPolicy.describeMessages(messages)} ` +
        `ms=${Date.now() - startedAt}`
    );
    const result: SessionMessagesResult = {
      messages,
      hasMore: false
    };
    return result;
  }

  async getModelCatalog(sessionId?: string): Promise<RemoteModelCatalog> {
    const response = await this.send<ModelCatalogResponse>(RemoteCommandFactory.getModelCatalog(sessionId));
    return response.catalog || {
      version: 0,
      models: [],
      default_models: {}
    };
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<string> {
    const response = await this.send<SetSessionModelResponse>(RemoteCommandFactory.setSessionModel(sessionId, modelId));
    return response.model_id || modelId;
  }

  async pollSession(
    sessionId: string,
    sinceVersion: number,
    knownMessageCount: number,
    knownModelCatalogVersion: number
  ): Promise<PollSessionResult> {
    const startedAt = Date.now();
    const command =
      RemoteCommandFactory.pollSession(sessionId, sinceVersion, knownMessageCount, knownModelCatalogVersion);
    const response = await this.send<PollSessionResponse>(command);
    const rawMessages = response.new_messages || [];
    const newMessages = rawMessages.map((item: ChatMessageResponse) => RemoteResponseMapper.chatMessage(item));
    const rawSnapshot = response.message_snapshot;
    const messageSnapshot = rawSnapshot ?
      rawSnapshot.map((item: ChatMessageResponse) => RemoteResponseMapper.chatMessage(item)) : undefined;
    const result: PollSessionResult = {
      version: response.version || sinceVersion,
      changed: response.changed,
      sessionState: response.session_state || '',
      title: response.title || '',
      newMessages,
      totalMessageCount: response.total_msg_count || knownMessageCount,
      messageSnapshot,
      activeTurn: response.active_turn
        ? RemoteResponseMapper.activeTurnToMessage(response.active_turn, response.version || sinceVersion)
        : undefined,
      modelCatalog: response.model_catalog
    };
    const rawActive = response.active_turn;
    RemoteLogger.info(`poll_session done session=${RemoteSessionManager.shortId(sessionId)} changed=${result.changed ? '1' : '0'} state=${result.sessionState} active=${rawActive ? rawActive.turn_id : ''} activeStatus=${rawActive ? rawActive.status : ''} rawText=${rawActive && rawActive.text ? rawActive.text.length : 0} rawThinking=${rawActive && rawActive.thinking ? rawActive.thinking.length : 0} rawItems=${rawActive && rawActive.items ? rawActive.items.length : 0} rawItemText=${RemoteSessionManager.itemsContentLength(rawActive ? rawActive.items : undefined)} projectedText=${result.activeTurn ? result.activeTurn.text.length : 0} new=${newMessages.length} snapshot=${messageSnapshot ? messageSnapshot.length : 0} ${newMessages.length > 0 ? TranscriptIntegrityPolicy.describeMessages(newMessages) + ' ' : ''}ms=${Date.now() - startedAt}`);
    return result;
  }

  async cancelTask(sessionId: string, turnId?: string): Promise<void> {
    await this.send<CommandStatusResponse>(RemoteCommandFactory.cancelTask(sessionId, turnId));
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.send<CommandStatusResponse>(RemoteCommandFactory.renameSession(sessionId, title));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.send<CommandStatusResponse>(RemoteCommandFactory.deleteSession(sessionId));
  }

  async startQuestionInteraction(sessionId: string, toolId: string): Promise<void> {
    const command: RemoteCommand = { cmd: 'start_question_interaction', session_id: sessionId, tool_id: toolId };
    await this.send<CommandStatusResponse>(command);
  }

  async confirmTool(toolId: string, updatedInput?: Object): Promise<void> {
    if (toolId.startsWith('permission:')) {
      const args: PermissionReplyArgs = { request: { requestId: toolId.slice('permission:'.length), reply: 'once', updatedInput: updatedInput } };
      await this.hostInvoke<Object>('respond_permission', args); return;
    }
    await this.send<CommandStatusResponse>(RemoteCommandFactory.confirmTool(toolId, updatedInput));
  }

  async rejectTool(toolId: string, reason: string): Promise<void> {
    if (toolId.startsWith('permission:')) {
      const args: PermissionReplyArgs = { request: { requestId: toolId.slice('permission:'.length), reply: 'reject', feedback: reason } };
      await this.hostInvoke<Object>('respond_permission', args); return;
    }
    await this.send<CommandStatusResponse>(RemoteCommandFactory.rejectTool(toolId, reason));
  }

  async cancelTool(toolId: string, reason: string): Promise<void> {
    await this.send<CommandStatusResponse>(RemoteCommandFactory.cancelTool(toolId, reason));
  }

  async getPermissionMode(): Promise<RemotePermissionMode> {
    const response = await this.send<PermissionModeResponse>(RemoteCommandFactory.getPermissionMode());
    if (response.mode !== 'ask' && response.mode !== 'auto' && response.mode !== 'full_access') {
      throw new Error('Permission mode unavailable');
    }
    return response.mode;
  }

  async setPermissionMode(mode: RemotePermissionMode): Promise<RemotePermissionMode> {
    const response = await this.send<PermissionModeResponse>(RemoteCommandFactory.setPermissionMode(mode));
    if (!response.mode) return this.getPermissionMode();
    if (response.mode !== 'ask' && response.mode !== 'auto' && response.mode !== 'full_access') {
      throw new Error('Permission mode unavailable');
    }
    return response.mode;
  }

  async answerQuestion(toolId: string, answers: RemoteQuestionAnswerPayload): Promise<void> {
    await this.send<CommandStatusResponse>(RemoteCommandFactory.answerQuestion(toolId, answers));
  }

  private currentFileLocation(): RuntimeFileLocation | undefined {
    return this.workspace ? {
      path: this.workspace.path, remoteConnectionId: this.workspace.remoteConnectionId
    } : undefined;
  }

  private applyFileWorkspace(command: RemoteCommand, sessionId: string | undefined, workspace: RuntimeFileLocation | undefined): void {
    if (sessionId) return;
    if (!workspace?.path) throw new Error('File workspace identity is unavailable.');
    command.workspace_path = workspace.path;
    command.remote_connection_id = workspace.remoteConnectionId;
  }

  async getFileInfo(path: string, sessionId?: string): Promise<FileInfo> {
    const command = RemoteCommandFactory.getFileInfo(path, sessionId);
    this.applyFileWorkspace(command, sessionId, this.currentFileLocation());

    const response = await this.send<FileInfoResponse>(command);
    return {
      name: response.name || RemoteResponseMapper.basename(path),
      size: response.size || 0,
      mimeType: response.mime_type || 'application/octet-stream'
    };
  }

  async readFileChunk(
    path: string,
    offset: number,
    limit: number,
    sessionId?: string,
    fileWorkspace?: RuntimeFileLocation
  ): Promise<ReadFileChunkResult> {
    const command = RemoteCommandFactory.readFileChunk(path, offset, limit, sessionId);
    this.applyFileWorkspace(command, sessionId, fileWorkspace || this.currentFileLocation());
    const response = await this.send<ReadFileChunkResponse>(command);
    return {
      name: response.name || RemoteResponseMapper.basename(path),
      contentBase64: response.chunk_base64 || '',
      revision: response.revision,
      offset: response.offset ?? offset,
      chunkSize: response.chunk_size || 0,
      totalSize: response.total_size || 0,
      mimeType: response.mime_type || 'application/octet-stream'
    };
  }

  async readFile(path: string, sessionId?: string, onProgress?: (downloaded: number, total: number) => void, maxBytes?: number): Promise<ReadFileResult> {
    const chunks: Uint8Array[] = [];
    const info = await this.streamFile(path, sessionId, async (bytes: Uint8Array, metadata: FileInfo): Promise<void> => {
      if (maxBytes !== undefined && metadata.size > maxBytes) throw new Error('File too large for preview.');
      chunks.push(bytes);
    }, onProgress);
    const bytes = new Uint8Array(info.size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { name: info.name, mimeType: info.mimeType, size: info.size, contentBase64: Encoding.bytesToBase64(bytes) };
  }

  async streamFile(path: string, sessionId: string | undefined, onChunk: (bytes: Uint8Array, info: FileInfo) => Promise<void>, onProgress?: (downloaded: number, total: number) => void, location?: RuntimeFileLocation): Promise<FileInfo> {
    const chunkSize = 3 * 1024 * 1024;
    let offset = 0;
    let fileName = RemoteResponseMapper.basename(path);
    let mimeType = 'application/octet-stream';
    let totalSize = 0;
    let revision: string | undefined;
    const generation = this.transportGeneration;
    const transport = this.transport;
    const source = location || this.workspace;
    const fileWorkspace: RuntimeFileLocation | undefined = source ? {
      path: source.path, remoteConnectionId: source.remoteConnectionId
    } : undefined;
    if (!sessionId && !fileWorkspace?.path) throw new Error('File workspace identity is unavailable.');
    let received = false;
    while (true) {
      if (generation !== this.transportGeneration || transport !== this.transport) {
        throw new Error('Remote target changed during file transfer.');
      }
      const response = await this.readFileChunk(path, offset, chunkSize, sessionId, fileWorkspace);
      if (generation !== this.transportGeneration || transport !== this.transport) {
        throw new Error('Remote target changed during file transfer.');
      }
      const readSize = response.chunkSize;
      const bytes = Encoding.base64ToBytes(response.contentBase64);
      if (!Number.isSafeInteger(response.totalSize) || response.totalSize < 0 ||
        response.offset !== offset || readSize !== bytes.length || readSize > chunkSize ||
        readSize > response.totalSize - offset || (readSize === 0 && offset < response.totalSize)) {
        throw new Error('Remote file transfer is incomplete or inconsistent.');
      }
      if (received && (response.totalSize !== totalSize || response.name !== fileName || response.mimeType !== mimeType || response.revision !== revision)) {
        throw new Error('Remote file changed during transfer.');
      }
      await onChunk(bytes, { name: response.name, size: response.totalSize, mimeType: response.mimeType });
      received = true;
      if (generation !== this.transportGeneration || transport !== this.transport) throw new Error('Remote target changed during file transfer.');
      fileName = response.name;
      mimeType = response.mimeType;
      totalSize = response.totalSize;
      revision = response.revision;
      offset += readSize;
      if (onProgress) {
        onProgress(offset, totalSize);
      }
      if (readSize === 0 || offset >= totalSize) {
        break;
      }
    }
    if (generation !== this.transportGeneration || transport !== this.transport) {
      throw new Error('Remote target changed during file transfer.');
    }
    return { name: fileName, mimeType: mimeType, size: totalSize };
  }

  async ping(): Promise<boolean> {
    // Bound key lookup and RPC together, like mobile-web's health probe.
    let timer: number = -1;
    try {
      await Promise.race<CommandStatusResponse>([
        this.send<CommandStatusResponse>(RemoteCommandFactory.ping(), 10000),
        new Promise<CommandStatusResponse>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Remote health probe timed out')), 10000);
        })
      ]);
      return true;
    } finally {
      if (timer !== -1) clearTimeout(timer);
    }
  }

  /**
   * [readTimeoutMs] is left undefined so each transport applies its own
   * default: a room command and an account command do not travel the same
   * number of hops and never shared a sensible number.
   */
  private async send<T extends CommandStatusResponse>(command: RemoteCommand, readTimeoutMs?: number): Promise<T> {
    if (!this.transport) {
      throw new Error('Remote transport is not connected.');
    }
    const generation = this.transportGeneration;
    const transport = this.transport;
    return this.sendOnTransport<T>(transport, generation, command, readTimeoutMs, true);
  }

  private async sendOnTransport<T extends CommandStatusResponse>(
    transport: RemoteCommandTransport,
    generation: number,
    command: RemoteCommand,
    readTimeoutMs?: number,
    requireCommittedTransport: boolean = false
  ): Promise<T> {
    command._request_id = `req_${Date.now()}_${Encoding.randomId('harmony').slice(0, 20)}`;
    const response = await transport.send<T>(command, readTimeoutMs);
    if (generation !== this.transportGeneration || (requireCommittedTransport && transport !== this.transport)) {
      throw new Error('Remote target changed while the request was in flight.');
    }
    return response;
  }

  /**
   * Keeps a handshake failure readable.
   *
   * Everything but a relay status here is the SDK's own errno text for "nobody
   * answered", which is both English and meaningless to the person holding the
   * phone. A status still carries something the caller acts on — 401 expires
   * the account session — so those pass through untouched.
   */
  private static handshakeFailure(err: Object): Error {
    if (err instanceof CloudAccountRequestError) {
      return err;
    }
    RemoteLogger.warn(`account device handshake failed: ${String(err)}`);
    return new Error(RemoteI18n.t('remote.settings.deviceUnavailable'));
  }

  private static normalizedSessionFilter(agentType: string): string {
    const normalized = (agentType || '').toLowerCase();
    if (normalized === 'code' || normalized === 'agentic') {
      return 'code';
    }
    if (normalized === 'cowork') {
      return 'cowork';
    }
    return '';
  }

  private static agentMatchesFilter(agentType: string, filter: string): boolean {
    const normalized = (agentType || '').toLowerCase();
    if (filter === 'code') {
      return normalized === 'code' || normalized === 'agentic';
    }
    if (filter === 'cowork') {
      return normalized === 'cowork';
    }
    return true;
  }

  private static shortId(value: string): string {
    if (value.length <= 8) {
      return value;
    }
    return value.slice(0, 4) + '...' + value.slice(value.length - 4);
  }

  private static itemsContentLength(items?: ChatMessageItemResponse[]): number {
    if (!items || items.length === 0) {
      return 0;
    }
    let total = 0;
    items.forEach((item: ChatMessageItemResponse) => {
      total += item.content ? item.content.length : 0;
      total += RemoteSessionManager.itemsContentLength(item.subItems);
    });
    return total;
  }

}

interface HostInvokeResponse<T> extends CommandStatusResponse { ok: boolean; value?: T; error?: string; }
