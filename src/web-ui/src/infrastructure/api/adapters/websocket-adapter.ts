 

import { ITransportAdapter } from './base';
import { createLogger } from '@/shared/utils/logger';
import {
  JsonRpcPeer,
  JsonRpcProtocolError,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
  JsonRpcTransportError,
  WebSocketMessageTransport,
  type JsonRpcNotification,
} from '../../../../../crates/adapters/transport/typescript/src/index.js';
import type {
  AgentSessionArchiveStateRequest,
  AgentSessionForkAtTurnRequest,
  ConfigUpdate,
  ForkSessionResponse,
  GitBranch,
  GitRepositoryPathRequest,
  GitTrustReport,
  ListSessionsResponse,
  PermissionGrant,
  PermissionReply,
  RemoveProjectPermissionGrantResponse,
  ResetAgentProfileConfigMessage,
  ResetAgentProfileConfigResponse,
  RunResponse,
  SearchSessionContentMessage,
  SearchSessionContentResponse,
  SetAgentProfileConfigMessage,
  SetAgentProfileConfigResponse,
  SubmitDialogTurnBody,
  SubmitDialogTurnResponse,
} from '@/generated/api';

const log = createLogger('WebSocketAdapter');

/**
 * Typed mapping from the frontend's snake_case agent commands to the app-server
 * JSON-RPC method names, carrying the request/response types from the generated
 * schema (`@/generated/api`, source: `openbitfun-app-server-protocol`).
 *
 * The service layer (`AgentAPI` and friends) speaks Tauri command names
 * (`create_session`, `start_dialog_turn`, ...) because that is the desktop
 * contract. In web mode the request rides the websocket to the Server Host,
 * whose dispatch (`src/apps/server/src/routes/websocket.rs`) only recognizes the
 * app-server surface methods (`agent/createSession`, ...). This table is the one
 * place that bridges the two naming conventions, so the typed service API stays
 * transport-agnostic and desktop/web share identical call sites.
 *
 * `AGENT_COMMAND_TO_WS_METHOD` (below) is derived from this table so the
 * exhaustive-and-stable test stays green and the snake->method mapping remains a
 * single source. The `request`/`response` slots are type-only (no runtime
 * value); they back the `request<K>()` overload so callers that use a known
 * command key get schema-typed bodies and responses.
 *
 * NOTE(Step 1): the typed `request`/`response` slots reflect the **schema wire
 * shape**. For `start_dialog_turn` the frontend currently sends the desktop host
 * shape (`userInput`/`dialogTurnId`/`imageContexts`) and `websocket.rs`
 * normalizes it to the schema shape (`message`/`turnId`/`attachments`) -- that
 * normalizer is removed in Step 2 once call sites migrate to the schema shape.
 * Until then the slot is annotated with the schema type so the drift is
 * type-visible.
 */
interface AgentCommandEntry {
  method: string;
  request?: unknown;
  response?: unknown;
}

export const AGENT_COMMAND_SCHEMA = {
  create_session: { method: 'agent/createSession' },
  list_sessions: {
    method: 'agent/listSessions',
    response: null as unknown as ListSessionsResponse,
  },
  delete_session: { method: 'agent/deleteSession' },
  fork_session: {
    method: 'session/forkAtTurn',
    request: null as unknown as AgentSessionForkAtTurnRequest,
    response: null as unknown as ForkSessionResponse,
  },
  archive_session: {
    method: 'session/setArchived',
    request: null as unknown as AgentSessionArchiveStateRequest,
  },
  unarchive_session: {
    method: 'session/setArchived',
    request: null as unknown as AgentSessionArchiveStateRequest,
  },
  // `start_dialog_turn` maps to `agent/submitDialogTurn`, not `agent/submitTurn`:
  // the dialog-turn body carries `agentType`/`workspacePath`/`policy`, which
  // the bare submission request does not. This mirrors the desktop host, which
  // drives `AgentRuntime::submit_dialog_turn` from the `start_dialog_turn`
  // Tauri command (`agentic_api.rs`).
  start_dialog_turn: {
    method: 'agent/submitDialogTurn',
    request: null as unknown as SubmitDialogTurnBody,
    response: null as unknown as SubmitDialogTurnResponse,
  },
  cancel_dialog_turn: {
    method: 'agent/cancelTurn',
    response: null as unknown as RunResponse,
  },
  search_session_content: {
    method: 'search/sessionContent',
    request: null as unknown as SearchSessionContentMessage,
    response: null as unknown as SearchSessionContentResponse,
  },
  // Permission surface: the reply/list/grants operations map to the app-server
  // permission methods. `subscribe_permission_requests` has no direct
  // counterpart -- in web mode the app-server pushes `permission://event`
  // notifications over the same connection, so subscribing is satisfied by
  // fetching the current pending set once.
  respond_permission: {
    method: 'agent/respondPermission',
    request: null as unknown as { request_id: string; reply: PermissionReply },
  },
  respond_permission_batch: {
    method: 'agent/respondPermissionBatch',
    request: null as unknown as { request_id: string; reply: PermissionReply },
  },
  list_pending_permission_requests: {
    method: 'agent/listPendingPermissionRequests',
  },
  subscribe_permission_requests: {
    method: 'agent/listPendingPermissionRequests',
  },
  list_project_permission_grants: {
    method: 'agent/listProjectPermissionGrants',
    request: null as unknown as { project_id: string },
    response: null as unknown as { grants: PermissionGrant[] },
  },
  remove_project_permission_grant: {
    method: 'agent/removeProjectPermissionGrant',
    request: null as unknown as PermissionGrant,
    response: null as unknown as RemoveProjectPermissionGrantResponse,
  },
  clear_project_permission_grants: {
    method: 'agent/clearProjectPermissionGrants',
    request: null as unknown as { project_id: string },
  },
  // Git service surface (read-only in this batch). The app-server schema uses
  // the `group/verb` camelCase convention (`git/getStatus`) matching
  // `agent/createSession`; the frontend `GitAPI` call sites speak the
  // snake_case Tauri command names (`git_get_status`), so this map is the one
  // place that bridges the two. Write operations and the remote (SSH) path
  // arrive in later batches; the Server Host has no SSH manager, so remote git
  // paths surface as `host_capability_unavailable` (the `external_sources`
  // precedent).
  git_is_repository: {
    method: 'git/isRepository',
    request: null as unknown as GitRepositoryPathRequest,
  },
  git_get_status: {
    method: 'git/getStatus',
    request: null as unknown as GitRepositoryPathRequest,
  },
  git_get_branches: {
    method: 'git/getBranches',
    request: null as unknown as GitRepositoryPathRequest,
    response: null as unknown as { branches: GitBranch[] },
  },
  // Read-only. `git_trust_repository` is deliberately absent: granting writes
  // the Server Host user's global Git configuration, which is not a decision a
  // browser client gets to make. The probe is what lets this transport still
  // name the repository and hand over the manual command.
  git_get_repository_trust: {
    method: 'git/getRepositoryTrust',
    request: null as unknown as GitRepositoryPathRequest,
    response: null as unknown as GitTrustReport,
  },
  // Config service surface. The agent-profile and
  // model-config reads reach the global config singletons the Desktop host
  // also uses -- no service injection, mirroring the static `GitService`
  // pattern. `get_config`/`get_configs` carry the not-found -> undefined
  // contract the frontend `ConfigAPI` depends on: the app-server
  // `config_get_error` helper puts the `OpenBitFunError::NotFound` Display text
  // into the JSON-RPC `message`, so `ConfigAPI.getConfig`'s substring match
  // (`not found:` + `config path` + `'<path>'`) hits and swallows the error
  // the same way it does on desktop. `get_skill_configs` (workspace
  // dependency) still lands in a later batch.
  get_agent_profile_configs: { method: 'config/getAgentProfileConfigs' },
  get_agent_profile_config: { method: 'config/getAgentProfileConfig' },
  get_model_configs: { method: 'config/getModelConfigs' },
  project_ai_model_reasoning_catalog: { method: 'model/projectReasoningCatalog' },
  get_config: { method: 'config/getConfig' },
  get_configs: { method: 'config/getConfigs' },
  set_agent_profile_config: {
    method: 'config/setAgentProfileConfig',
    request: null as unknown as SetAgentProfileConfigMessage,
    response: null as unknown as SetAgentProfileConfigResponse,
  },
  reset_agent_profile_config: {
    method: 'config/resetAgentProfileConfig',
    request: null as unknown as ResetAgentProfileConfigMessage,
    response: null as unknown as ResetAgentProfileConfigResponse,
  },
  set_config: { method: 'config/setConfig' },
  save_cloud_speech_config: { method: 'config/saveCloudSpeechConfig' },
  get_web_search_credential_status: { method: 'config/getWebSearchCredentialStatus' },
  save_web_search_credential: { method: 'config/saveWebSearchCredential' },
  clear_web_search_credential: { method: 'config/clearWebSearchCredential' },
  validate_config: { method: 'config/validateConfig' },
  i18n_get_current_language: { method: 'i18n/getCurrentLanguage' },
  i18n_set_language: { method: 'i18n/setLanguage' },
  i18n_get_config: { method: 'i18n/getConfig' },
  i18n_set_config: { method: 'i18n/setConfig' },
  i18n_get_supported_languages: { method: 'i18n/getSupportedLanguages' },
} as const satisfies Record<string, AgentCommandEntry>;

export type AgentCommandKey = keyof typeof AGENT_COMMAND_SCHEMA;

/**
 * Resolve the app-server JSON-RPC method name for a frontend command. The
 * snake_case Tauri command names the service-API call sites use (e.g.
 * `create_session`) map to the schema `group/verb` method names via the typed
 * `AGENT_COMMAND_SCHEMA` table; any command not in the table passes through
 * unchanged (desktop-only commands, `ping`, ...) and surfaces as
 * `method_not_found` on the browser-direct ACP path.
 *
 * Step 2b: the snake->method resolution is **web-transport-only** -- the desktop
 * and CLI hosts still call Tauri commands by their snake_case names directly,
 * so this indirection is confined to the WS adapter and does not affect them.
 */
export function resolveWsMethod(action: string): string {
  const entry = (AGENT_COMMAND_SCHEMA as Record<string, AgentCommandEntry>)[action];
  return entry?.method ?? action;
}

// ---------------------------------------------------------------------------
// Protocol conversion layer (Review2-Item2)
// ---------------------------------------------------------------------------
// The frontend service-API call sites speak the desktop Tauri command shapes
// (camelCase field names, bare-string permission replies, success/message
// responses, bare-array returns). The app-server JSON-RPC schema uses a
// different wire shape per method (schema snake_case fields, tagged-enum
// PermissionReply, status/sessionId/turnId responses, wrapper structs for
// collection results). The adapter is the single place that bridges the two so
// call sites stay transport-agnostic. Each encoder/decoder is pure and
// side-effect free; an unknown action falls through unchanged.

/**
 * Encodes the frontend request body into the app-server JSON-RPC wire shape for
 * the given command. Handles field-name and structural mismatches the desktop
 * host does in Rust (`agentic_api.rs`).
 */
export function encodeRequestBody(action: string, body: any): any {
  if (!body || typeof body !== 'object') return body ?? {};
  switch (action) {
    case 'start_dialog_turn': {
      const { userInput, originalUserInput, imageContexts, userMessageMetadata, ...rest } = body;
      return {
        ...rest,
        message: userInput,
        ...(originalUserInput !== undefined ? { originalMessage: originalUserInput } : {}),
        ...(Array.isArray(imageContexts) && imageContexts.length > 0
          ? { attachments: imageContexts.map(encodeImageAttachment) }
          : {}),
        ...(userMessageMetadata !== undefined ? { metadata: encodeUserMetadata(userMessageMetadata) } : {}),
      };
    }
    case 'respond_permission':
    case 'respond_permission_batch':
      return encodePermissionResponseBody(body);
    case 'fork_session':
      return {
        // The workspace ID selects the session's owner; the path and SSH
        // fields are the upgrade-only projection for pre-ID hosts.
        ...(body.workspace_id !== undefined ? { workspaceId: body.workspace_id } : {}),
        ...(body.workspace_path !== undefined ? { workspacePath: body.workspace_path } : {}),
        sourceSessionId: body.source_session_id,
        sourceTurnId: body.source_turn_id,
        ...(body.remote_connection_id !== undefined
          ? { remoteConnectionId: body.remote_connection_id }
          : {}),
        ...(body.remote_ssh_host !== undefined
          ? { remoteSshHost: body.remote_ssh_host }
          : {}),
      };
    case 'archive_session':
    case 'unarchive_session':
      return {
        ...(body.workspace_id !== undefined ? { workspaceId: body.workspace_id } : {}),
        ...(body.workspace_path !== undefined ? { workspacePath: body.workspace_path } : {}),
        sessionId: body.session_id,
        archived: action === 'archive_session',
        ...(body.remote_connection_id !== undefined
          ? { remoteConnectionId: body.remote_connection_id }
          : {}),
        ...(body.remote_ssh_host !== undefined
          ? { remoteSshHost: body.remote_ssh_host }
          : {}),
      };
    default:
      return body;
  }
}

/**
 * Decodes the app-server JSON-RPC result into the frontend-expected shape.
 * Handles response wrapper structs (bare-array unwrapping) and the
 * start_dialog_turn status-enum -> success/message projection.
 */
export function decodeResponseBody(action: string, result: any): any {
  switch (action) {
    case 'start_dialog_turn': {
      if (result && typeof result === 'object' && 'status' in result) {
        return { success: true, message: result.status === 'queued' ? 'Dialog turn queued' : 'Dialog turn started' };
      }
      return result;
    }
    case 'list_sessions':
      return unwrapArray(result, 'sessions');
    case 'list_pending_permission_requests':
    case 'subscribe_permission_requests':
      return unwrapArray(result, 'requests');
    case 'respond_permission_batch':
      return unwrapArray(result, 'request_ids');
    case 'list_project_permission_grants':
      return unwrapArray(result, 'grants');
    case 'list_project_permission_audit':
      return unwrapArray(result, 'records');
    case 'git_get_branches':
      return unwrapArray(result, 'branches');
    case 'project_ai_model_reasoning_catalog':
      return result?.projection ?? result;
    case 'set_agent_profile_config':
      return 'Agent profile configuration updated successfully';
    case 'reset_agent_profile_config':
      return 'Agent profile configuration reset successfully';
    default:
      return result;
  }
}

/** Maps a frontend `ImageContextData` to the schema `AgentInputAttachment`. */
function encodeImageAttachment(image: any): any {
  const metadata: Record<string, unknown> = {};
  if (image.imagePath) metadata.imagePath = image.imagePath;
  if (image.dataUrl) metadata.dataUrl = image.dataUrl;
  if (image.mimeType) metadata.mimeType = image.mimeType;
  if (image.metadata) metadata.metadata = image.metadata;
  return { kind: 'remote_image', id: image.id, metadata };
}

/** Mirrors `desktop_user_message_metadata`: object-as-is, else wrapped, else empty. */
function encodeUserMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (metadata === undefined || metadata === null) return {};
  return { raw_metadata: metadata };
}

/**
 * Converts the frontend `{requestId, reply: 'once'|'always'|'reject', feedback?}`
 * shape to the schema `RespondPermissionMessage` /
 * `RespondPermissionBatchMessage` wire shape: `{request_id, reply: {reply:
 * 'once'}}` (tagged-enum form).
 */
function encodePermissionResponseBody(body: any): any {
  const { requestId, reply, feedback, ...rest } = body;
  const tagged: Record<string, unknown> = { reply };
  if (reply === 'reject' && feedback) tagged.feedback = feedback;
  return { ...rest, request_id: requestId, reply: tagged };
}

/** Unwraps a `{key: [...]}` response wrapper into the bare array the frontend expects. */
function unwrapArray(result: any, key: string): any {
  if (result && typeof result === 'object' && Array.isArray(result[key])) {
    return result[key];
  }
  return result;
}

export function webSocketResponseError(value: unknown): Error {
  const record = value && typeof value === 'object'
    ? value as { code?: unknown; message?: unknown; data?: unknown }
    : undefined;
  const message = typeof record?.message === 'string'
    ? record.message
    : String(value);
  const error = new Error(message) as Error & { code?: unknown; data?: unknown };
  error.code = record?.code;
  error.data = record?.data;
  return error;
}

export interface DecodedWsNotification {
  event: string;
  payload: unknown;
}

/** Project one app-server JSON-RPC notification into the frontend event bus. */
export function decodeWsNotification(message: any): DecodedWsNotification | null {
  if (message?.method === 'agent/frontendEvent' && message.params?.event) {
    return {
      event: message.params.event,
      payload: message.params.payload,
    };
  }
  if (message?.method === 'config/event' && message.params) {
    return {
      event: 'config://updated',
      payload: message.params as ConfigUpdate,
    };
  }
  return null;
}

const WEB_JSON_RPC_LIMITS = {
  maxMessageBytes: 1024 * 1024,
  maxPendingRequests: 128,
  maxPendingBytes: 8 * 1024 * 1024,
  maxOutboundBytes: 2 * 1024 * 1024,
};

const WEB_SOCKET_SEND_BUFFER_BYTES = 2 * 1024 * 1024;
const WEB_SOCKET_DRAIN_TIMEOUT_MS = 5_000;

interface WebSocketRpcGeneration {
  socket: WebSocket;
  transport: WebSocketMessageTransport;
  peer: JsonRpcPeer;
  allowReconnect: boolean;
}

export class WebSocketTransportAdapter implements ITransportAdapter {
  private ws: WebSocket | null = null;
  private url: string;
  private eventListeners: Map<string, Set<(data: any) => void>> = new Map();
  private messageIdCounter = 0;
  private rpcGeneration: WebSocketRpcGeneration | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  // Held so `disconnect()` can cancel a reconnect that is already scheduled; without it a
  // pending timer reopens the socket after an explicit teardown.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  
  constructor(url?: string) {
    
    this.url = url || import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';
  }
  
   
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        log.info('Connecting', { url: this.url });
        const ws = new WebSocket(this.url);
        this.ws = ws;
        let settled = false;

        ws.onopen = () => {
          if (this.ws !== ws) {
            ws.close();
            return;
          }
          log.info('Connected successfully');
          this.reconnectAttempts = 0;
          const generation = this.createRpcGeneration(ws);
          this.rpcGeneration = generation;
          this.setupMessageHandler(generation);
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        
        ws.onerror = (error) => {
          log.error('Connection error', error);
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket connection failed'));
          }
        };
        
        ws.onclose = () => {
          log.info('Connection closed');
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket connection closed before open'));
          }
          const generation = this.rpcGeneration?.socket === ws
            ? this.rpcGeneration
            : null;
          if (generation !== null) {
            generation.transport.carrierClosed(
              new Error('WebSocket connection closed'),
            );
            if (this.rpcGeneration === generation) {
              this.rpcGeneration = null;
            }
          }
          if (this.ws === ws) {
            this.ws = null;
          }
          if (generation?.allowReconnect !== false) {
            this.handleDisconnect();
          }
        };
      } catch (error) {
        log.error('Failed to create WebSocket', error);
        reject(error);
      }
    });
  }
  
   
  private connectPromise: Promise<void> | null = null;

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = null;
      });
    }

    return this.connectPromise;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleDisconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * this.reconnectAttempts;
      
      log.info('Reconnecting', { delay, attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts });

      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureConnected().catch(error => {
          log.error('Reconnection failed', error);
        });
      }, delay);
    } else {
      log.error('Max reconnection attempts reached');
    }
  }
  
   
  private setupMessageHandler(generation: WebSocketRpcGeneration): void {
    const ws = generation.socket;

    ws.onmessage = (event) => {
      if (this.rpcGeneration !== generation) {
        return;
      }
      if (typeof event.data !== 'string') {
        void generation.peer.abort(
          new JsonRpcProtocolError('WebSocket JSON-RPC message must be text'),
        );
        return;
      }
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.jsonrpc !== '2.0') {
          const mappedEventName = this.mapLegacyTypeToEventName(message.type);
          if (mappedEventName !== null) {
            this.dispatchEvent(mappedEventName, message, message.type);
            return;
          }
        }
      } catch {
        // The shared peer owns parse and strict-envelope failure semantics.
      }
      generation.transport.receive(event.data);
    };
  }

  private createRpcGeneration(socket: WebSocket): WebSocketRpcGeneration {
    const transport = new WebSocketMessageTransport(socket, {
      maxBufferedBytes: WEB_SOCKET_SEND_BUFFER_BYTES,
      drainTimeoutMs: WEB_SOCKET_DRAIN_TIMEOUT_MS,
    });
    const generation = {
      socket,
      transport,
      allowReconnect: true,
    } as WebSocketRpcGeneration;
    const peer = new JsonRpcPeer(transport, {
      createRequestId: () => `msg_${Date.now()}_${++this.messageIdCounter}`,
      requestTimeoutMs: 30_000,
      limits: WEB_JSON_RPC_LIMITS,
      onNotificationError: (error, notification) => {
        log.error('Error in WebSocket notification consumer', {
          method: notification.method,
          error,
        });
      },
    });
    generation.peer = peer;
    peer.onNotification((notification) => {
      this.dispatchNotification(notification);
    });
    peer.onFailure((error) => {
      if (error instanceof JsonRpcProtocolError) {
        generation.allowReconnect = false;
      }
      log.error('WebSocket JSON-RPC peer stopped', error);
    });
    return generation;
  }

  private dispatchNotification(notification: JsonRpcNotification): void {
    const decoded = decodeWsNotification({
      jsonrpc: '2.0',
      method: notification.method,
      params: notification.params,
    });
    if (decoded !== null) {
      this.dispatchEvent(decoded.event, decoded.payload);
    }
  }

  private dispatchEvent(event: string, payload: unknown, rawType?: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (listeners === undefined || listeners.size === 0) {
      return;
    }
    listeners.forEach(callback => {
      try {
        callback(payload);
      } catch (error) {
        log.error('Error in WebSocket event listener', {
          event,
          rawType,
          error,
        });
      }
    });
  }

  private mapLegacyTypeToEventName(type: unknown): string | null {
    if (typeof type !== 'string' || !type.trim()) {
      return null;
    }

    return `agentic://${type.trim()}`;
  }
  

  async request<T>(action: string, params?: any): Promise<T>;
  async request<K extends AgentCommandKey>(
    action: K,
    params: (typeof AGENT_COMMAND_SCHEMA)[K] extends { request: infer R } ? R : undefined,
  ): Promise<
    (typeof AGENT_COMMAND_SCHEMA)[K] extends { response: infer S } ? S : unknown
  >;
  async request<T>(action: string, params?: any): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.ensureConnected();
    }

    // Translate the frontend snake_case command to the app-server JSON-RPC
    // method so agent-kernel requests reach the app-server surface in web mode.
    const method = resolveWsMethod(action);
    // The service layer calls `api.invoke('cmd', { request: {...} })` (Tauri
    // convention). ACP `on_receive_request` deserializes the bare body, so
    // unwrap the `{request}` envelope here.
    const envelope = (params && typeof params === 'object'
      && 'request' in params
      && Object.keys(params).length === 1)
      ? params.request ?? {}
      : params ?? {};
    // Encode the frontend body into the app-server schema wire shape (field
    // names, tagged enums, attachment projection). Mirrors the conversions the
    // desktop host does in Rust (`agentic_api.rs`).
    const body = encodeRequestBody(action, envelope);

    try {
      const generation = this.rpcGeneration;
      if (generation === null) {
        throw new JsonRpcTransportError('WebSocket JSON-RPC peer is unavailable');
      }
      const result = await generation.peer.request(method, body);
      return decodeResponseBody(action, result) as T;
    } catch (error) {
      if (error instanceof JsonRpcRemoteError) {
        throw webSocketResponseError({
          code: error.code,
          message: error.message,
          data: error.data,
        });
      }
      if (error instanceof JsonRpcTimeoutError) {
        const timeout = new Error(`Request timeout: ${action}`) as Error & {
          cause?: unknown;
        };
        timeout.cause = error;
        throw timeout;
      }
      throw error;
    }
  }
  
   
  listen<T>(event: string, callback: (data: T) => void): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    
    const listeners = this.eventListeners.get(event)!;
    listeners.add(callback);
    
    
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this.eventListeners.delete(event);
        }
      }
    };
  }
  
   
  async disconnect(): Promise<void> {

    // Before anything else, so a reconnect that is already queued cannot fire after teardown
    // and reopen the socket we are about to close.
    this.clearReconnectTimer();

    this.eventListeners.clear();

    const generation = this.rpcGeneration;
    this.rpcGeneration = null;
    if (this.ws) {
      this.ws.onclose = null;
      await generation?.peer.close();
      if (this.ws.readyState < WebSocket.CLOSING) {
        this.ws.close();
      }
      this.ws = null;
    } else {
      await generation?.peer.close();
    }
    
    
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.connectPromise = null;
  }
  
   
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
