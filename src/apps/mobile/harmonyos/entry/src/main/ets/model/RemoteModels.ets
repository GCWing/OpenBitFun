export interface RuntimeFileLocation { path: string; remoteConnectionId?: string; }


export class EncryptedPayload {
  encrypted_data: string = '';
  nonce: string = '';
}

export interface WorkspaceInfo extends RemoteWorkspaceIdentity {
  remoteConnectionId?: string;
  remoteSshHost?: string;
  path: string;
  name: string;
  hasWorkspace: boolean;
  gitBranch: string;
  workspaceKind: string;
  assistantId?: string;
}

export interface InitialSyncResult {
  workspace: WorkspaceInfo;
  sessions: RemoteSession[];
  hasMoreSessions: boolean;
  authenticatedUserId: string;
  capabilities?: string[];
}

export interface RecentWorkspaceEntry extends RemoteWorkspaceIdentity {
  remoteConnectionId?: string;
  remoteSshHost?: string;
  path: string;
  name: string;
  lastOpened: string;
  workspaceKind: string;
}

/**
 * A workspace reference. When `workspaceId` is present it is the whole
 * identity; `path`, `remoteConnectionId` and `remoteSshHost` are then display
 * strings and IO operands only. Only references from pre-ID hosts or old caches
 * are identified by the legacy (connection, ssh host, path) triple.
 */
export interface RemoteWorkspaceIdentity {
  workspaceId?: string;
  path: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface RemoteSession {
  id: string;
  title: string;
  agentType: string;
  status: string;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
  workspacePath?: string;
  workspaceName?: string;
  /** Optional for legacy caches; assigned from the actual scoped listing request. */
  workspaceIdentity?: RemoteWorkspaceIdentity;
  pinned?: boolean;
  titleGenerated?: boolean;
  /** Set when the session hangs off another one (btw/review/miniapp/subagent). */
  parentSessionId?: string;
  relationshipKind?: string;
  /** Stamped by the phone after mapping; the wire payload has no device id. */
  deviceId?: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  text: string;
  status: string;
  renderVersion?: number;
  turnId?: string;
  detail?: string;
  error?: string;
  timestamp?: string;
  thinking?: string;
  tools?: RemoteToolStatusResponse[];
  items?: ChatMessageItemResponse[];
  images?: ImageAttachment[];
}

export interface SessionSummary {
  /** Owning workspace record ID; absent only for sessions from pre-ID hosts. */
  workspaceId?: string;
  remoteSshHost?: string;
  remoteConnectionId?: string;
  sessionId: string;
  title: string;
  workspacePath: string;
  agentType: string;
  initialTurnId?: string;
}

export interface CreateSessionOptions {
  workspaceId?: string;
  remoteSshHost?: string;
  remoteConnectionId?: string;
  agentType: string;
  title: string;
  instruction: string;
  modelId?: string;
  workspacePath?: string;
}

export type RemotePermissionMode = 'ask' | 'auto' | 'full_access';

export interface PairRequest {
  public_key: string;
  device_id: string;
  device_name: string;
}

export interface ChallengeCommand {
  challenge_echo: string;
  device_id: string;
  device_name: string;
  mobile_install_id: string;
  user_id: string;
  password?: string;
}

export interface SavedRuntimeConnection { id: string; name: string; host: string; }
export interface SavedRuntimeConnectionsResponse extends CommandStatusResponse { ok: boolean; value?: SavedRuntimeConnection[]; error?: string; }

export interface RemoteCommand {
  workspace_id?: string;
  remote_ssh_host?: string;
  command?: string;
  args?: Object;
  remote_connection_id?: string;
  cmd: string;
  _request_id?: string;
  session_id?: string;
  content?: string;
  workspace_path?: string;
  path?: string;
  agent_type?: string;
  session_name?: string;
  title?: string;
  limit?: number;
  offset?: number;
  query?: string;
  before_message_id?: string;
  since_version?: number;
  known_msg_count?: number;
  known_model_catalog_version?: number;
  turn_id?: string;
  display_content?: string;
  plan_file_path?: string;
  plan_name?: string;
  tool_id?: string;
  updated_input?: Object;
  model_id?: string;
  reason?: string;
  mode?: RemotePermissionMode;
  answers?: Object;
  image_contexts?: RemoteImageContext[];
  images?: ImageAttachment[];
  // provision_peer_device. `request_id` is minted by the device being
  // provisioned, unlike `_request_id`, which the phone stamps on every command
  // for its own correlation logging.
  device_id?: string;
  device_name?: string;
  request_id?: string;
}

export interface PairChallengeResponse {
  challenge: string;
}

export interface CommandStatusResponse {
  resp?: string;
  message?: string;
}

export interface PermissionModeResponse extends CommandStatusResponse {
  mode?: RemotePermissionMode;
}

export interface WorkspaceInfoResponse extends CommandStatusResponse {
  workspace_id?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
  has_workspace?: boolean;
  workspace_path?: string;
  workspace_name?: string;
  path?: string;
  project_name?: string;
  git_branch?: string;
  workspace_kind?: string;
  assistant_id?: string;
  capabilities?: string[];
}

export interface RecentWorkspaceEntryResponse {
  workspace_id?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
  path?: string;
  name?: string;
  last_opened?: string | number;
  lastOpened?: string | number;
  updated_at?: string | number;
  updatedAt?: string | number;
  workspace_kind?: string;
}

export interface RecentWorkspaceListResponse extends CommandStatusResponse {
  opened_workspaces?: RecentWorkspaceEntryResponse[] | null;
  workspaces?: RecentWorkspaceEntryResponse[];
}

export interface SetWorkspaceResponse extends CommandStatusResponse {
  workspace_id?: string;
  success?: boolean;
  path?: string;
  project_name?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
  error?: string;
}

export interface AssistantEntry {
  workspace_id?: string;
  path: string;
  name: string;
  assistant_id?: string;
}

export interface AssistantListResponse extends CommandStatusResponse {
  assistants?: AssistantEntry[];
}

export interface SetAssistantResponse extends CommandStatusResponse {
  workspace_id?: string;
  success?: boolean;
  path?: string;
  name?: string;
  error?: string;
}

export interface SessionItemResponse {
  /** Owning workspace record ID; always set by ID-aware hosts. */
  workspace_id?: string;
  id?: string;
  session_id?: string;
  title?: string;
  name?: string;
  agent_type?: string;
  status?: string;
  updated_at?: string | number;
  updatedAt?: string | number;
  updated?: string | number;
  updated_time?: string | number;
  update_time?: string | number;
  modified_at?: string | number;
  last_active_at?: string | number;
  last_activity_at?: string | number;
  last_message_at?: string | number;
  last_interaction_at?: string | number;
  lastUpdated?: string | number;
  lastActivityAt?: string | number;
  lastMessageAt?: string | number;
  created_at?: string | number;
  createdAt?: string | number;
  created?: string | number;
  created_time?: string | number;
  create_time?: string | number;
  inserted_at?: string | number;
  started_at?: string | number;
  start_time?: string | number;
  timestamp?: string | number;
  message_count?: number;
  workspace_path?: string;
  workspace_name?: string;
  parent_session_id?: string;
  relationship_kind?: string;
}

export interface SessionListResponse extends CommandStatusResponse {
  sessions?: SessionItemResponse[];
  has_more?: boolean;
}

export interface InitialSyncResponse extends CommandStatusResponse {
  workspace_id?: string;
  has_workspace?: boolean;
  path?: string;
  project_name?: string;
  git_branch?: string;
  workspace_kind?: string;
  assistant_id?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
  sessions?: SessionItemResponse[];
  has_more_sessions?: boolean;
  authenticated_user_id?: string;
  capabilities?: string[];
}

export interface DelegatedIdentityResponse extends CommandStatusResponse {
  token?: string;
  user_id?: string;
  master_key?: string;
  device_id?: string;
}

/**
 * Answer to `provision_peer_device`. Shaped like a delegated identity but
 * carrying a 30-day *full* device credential, and `device_id` names the device
 * that was just registered rather than the desktop that registered it.
 */
export interface PeerDeviceProvisionedResponse extends CommandStatusResponse {
  token?: string;
  user_id?: string;
  master_key?: string;
  device_id?: string;
}

export interface SessionListResult {
  sessions: RemoteSession[];
  hasMore: boolean;
}

export interface CreateSessionResponse extends CommandStatusResponse {
  /** Owning workspace record ID; absent only from pre-ID hosts. */
  workspace_id?: string;
  remote_ssh_host?: string;
  workspace_path?: string;
  remote_connection_id?: string;
  session_id?: string;
  id?: string;
  title?: string;
}

export interface SendMessageResponse extends CommandStatusResponse {
  turn_id?: string;
}

export interface SteerTurnResponse extends CommandStatusResponse {
  session_id?: string;
  turn_id?: string;
  steering_id?: string;
}

export interface SteerTurnResult {
  sessionId: string;
  turnId: string;
  steeringId: string;
}

export const REMOTE_CAPABILITY_DIALOG_STEER_V1: string = 'dialog_steer_v1';
export const REMOTE_CAPABILITY_PLAN_BUILD_V1: string = 'plan_build_v1';
export const REMOTE_CAPABILITY_HARNESS_PROFILES_V1: string = 'harness_profiles_v1';
/** The host resolves `workspace_id` in commands and stamps it on its projections. */
export const REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1: string = 'workspace_id_references_v1';

export interface RemoteModelConfig {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  model_name: string;
  context_window?: number;
  enabled: boolean;
  capabilities: string[];
  reasoning?: RemoteReasoningCatalogProjection;
}

export interface RemoteReasoningPresetDescriptor {
  id: string;
  label: string;
  order: number;
  actions: RemoteReasoningPresetAction[];
  source: string;
}

export interface RemoteReasoningPresetAction {
  type: string;
  value?: string | number;
  enabled?: boolean;
  body?: Record<string, Object>;
}

export interface RemoteReasoningCatalogProjection {
  status: string;
  default_preset?: string;
  presets?: RemoteReasoningPresetDescriptor[];
}

export interface RemoteDefaultModels {
  primary?: string;
  fast?: string;
  search?: string;
  image_understanding?: string;
}

export interface RemoteModelCatalog {
  version: number;
  models: RemoteModelConfig[];
  default_models: RemoteDefaultModels;
  session_model_id?: string;
}

export interface ModelCatalogResponse extends CommandStatusResponse {
  catalog?: RemoteModelCatalog;
}

export interface SetSessionModelResponse extends CommandStatusResponse {
  session_id?: string;
  model_id?: string;
}

export interface RemoteToolStatusResponse {
  permission_request_id?: string;
  id?: string;
  name?: string;
  status?: string;
  duration_ms?: number;
  start_ms?: number;
  input_preview?: string;
  tool_input?: Object;
  stdout?: string;
  stderr?: string;
  tool_output?: Object;
  result_preview?: string;
  error_preview?: string;
  exit_code?: number;
  plan?: RemotePlanToolResponse;
}

export interface RemotePlanToolResponse {
  file_path: string;
  name: string;
  overview?: string;
}

export interface RemoteQuestionAnswerPayload {
  answer?: string;
  '0'?: string | string[];
  '1'?: string | string[];
  '2'?: string | string[];
  '3'?: string | string[];
}

export interface ChatMessageItemResponse {
  type?: string;
  steering_id?: string;
  round_index?: number;
  content?: string;
  tool?: RemoteToolStatusResponse;
  is_subagent?: boolean;
  subItems?: ChatMessageItemResponse[];
  images?: ImageAttachment[];
}

export interface ImageAttachment {
  name: string;
  data_url: string;
  mime_type?: string;
}

export interface SelectedImageAttachment extends ImageAttachment {
  id: string;
  uri: string;
  mime_type: string;
  size: number;
  original_size: number;
  compressed: boolean;
}

export interface RemoteImageContext {
  id: string;
  image_path?: string;
  data_url?: string;
  mime_type: string;
  metadata?: Object;
}

export interface ChatMessageResponse {
  id?: string;
  message_id?: string;
  turn_id?: string;
  role: string;
  content: string;
  status?: string;
  error?: string;
  timestamp?: string;
  metadata?: Object;
  thinking?: string;
  items?: ChatMessageItemResponse[];
  tools?: RemoteToolStatusResponse[];
  images?: ImageAttachment[];
}

export interface ActiveTurnSnapshotResponse {
  turn_id: string;
  status: string;
  error?: string;
  text?: string;
  thinking?: string;
  tools?: RemoteToolStatusResponse[];
  round_index?: number;
  items?: ChatMessageItemResponse[];
}

export interface SessionMessagesResponse extends CommandStatusResponse {
  messages?: ChatMessageResponse[];
  has_more?: boolean;
}

export interface SessionMessagesResult {
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface PollSessionResponse extends CommandStatusResponse {
  version: number;
  changed: boolean;
  session_state?: string;
  title?: string;
  new_messages?: ChatMessageResponse[];
  total_msg_count?: number;
  message_snapshot?: ChatMessageResponse[];
  active_turn?: ActiveTurnSnapshotResponse;
  model_catalog?: RemoteModelCatalog;
}

export interface PollSessionResult {
  version: number;
  changed: boolean;
  sessionState: string;
  title: string;
  newMessages: ChatMessage[];
  totalMessageCount: number;
  messageSnapshot?: ChatMessage[];
  activeTurn?: ChatMessage;
  modelCatalog?: RemoteModelCatalog;
}

export interface FileInfoResponse extends CommandStatusResponse {
  name?: string;
  size?: number;
  mime_type?: string;
}

export interface FileInfo {
  name: string;
  size: number;
  mimeType: string;
}

export interface ReadFileChunkResponse extends CommandStatusResponse {
  revision?: string;
  name?: string;
  chunk_base64?: string;
  offset?: number;
  chunk_size?: number;
  total_size?: number;
  mime_type?: string;
}

export interface ReadFileResult {
  name: string;
  contentBase64: string;
  mimeType: string;
  size: number;
}

export interface ReadFileChunkResult {
  revision?: string;
  name: string;
  contentBase64: string;
  offset: number;
  chunkSize: number;
  totalSize: number;
  mimeType: string;
}
