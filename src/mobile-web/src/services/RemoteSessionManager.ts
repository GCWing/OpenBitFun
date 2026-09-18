import { normalizeWorkspaceRouting } from './workspaceIdentity';
import type { SessionStreamHandle, SessionHistoryState } from '../../../shared/relay-transport/SessionStream';
import { translateAgentIdentityFields } from '../../../shared/agent-harness/wire';
/**
 * Manages remote sessions by sending commands to the desktop via the relay.
 * Commands use the shared authenticated realtime RPC connection.
 *
 * Durable session events drive presentation synchronization.
 */

import {
  RelayHttpClient,
  type ControlTargetSnapshot,
} from './RelayHttpClient';
import { getControlClientIdentity } from './controlClientIdentity';
import { projectWorkspaceCatalog, type WorkspaceCatalog } from './workspaceIdentity';

export class RemoteControlTargetChangedError extends Error {
  constructor() {
    super('Remote control target changed');
    this.name = 'RemoteControlTargetChangedError';
  }
}

export function isRemoteControlTargetChangedError(
  value: unknown,
): value is RemoteControlTargetChangedError {
  return value instanceof RemoteControlTargetChangedError;
}

/**
 * The client holds a workspace ID but the connected host predates
 * `workspace_id_references_v1`. The command is not sent: downgrading an ID to
 * its path projection could silently select another workspace on that host.
 */
export class WorkspaceIdReferencesUnsupportedError extends Error {
  /** Mobile-web i18n message key for the user-facing unsupported state. */
  readonly messageKey = 'workspace.idReferencesUnsupported' as const;

  constructor(readonly workspaceId: string) {
    super('Connected host does not support workspace ID references; update OpenBitFun on that device');
    this.name = 'WorkspaceIdReferencesUnsupportedError';
  }
}

export function isWorkspaceIdReferencesUnsupportedError(
  value: unknown,
): value is WorkspaceIdReferencesUnsupportedError {
  return value instanceof WorkspaceIdReferencesUnsupportedError;
}

const RETRYABLE_REMOTE_READ_COMMANDS = new Set([
  'get_workspace_info',
  'list_recent_workspaces',
  'list_assistants',
  'list_sessions',
  'get_session_messages',
  'get_model_catalog',
  'poll_session',
  'ping',
  'get_file_info',
  'read_file_chunk',
]);

// Session settings are small, idempotent writes. Keeping their deadline well
// below turn execution prevents a lost relay response from making the selector
// look frozen for the generic 65/130-second command timeout.
const REMOTE_SETTING_WRITE_TIMEOUT_MS = 20_000;

interface RemoteRequestOptions {
  timeoutMs?: number;
}

/** A runtime workspace or device location that scopes a file command. */
export interface RuntimeFileWorkspace {
  /** Runtime workspace ID; authoritative when present. */
  workspaceId?: string;
  /** Root or browsed directory used as the legacy projection / IO operand. */
  path: string;
  remoteConnectionId?: string;
}

export interface WorkspaceInfo {
  workspace_id?: string;
  has_workspace: boolean;
  path?: string;
  project_name?: string;
  git_branch?: string;
  /** Mirrors desktop `WorkspaceKind`: normal project, Claw assistant workspace, or remote SSH. */
  workspace_kind?: 'normal' | 'assistant' | 'remote';
  assistant_id?: string;
  /** Required to disambiguate multiple SSH hosts that share the same POSIX path. */
  remote_connection_id?: string;
  remote_ssh_host?: string;
  capabilities?: string[];
}

export interface RemoteWorkspaceIdentity {
  workspaceId?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface RecentWorkspaceEntry {
  workspace_id?: string;
  path: string;
  name: string;
  last_opened: string;
  workspace_kind?: 'normal' | 'assistant' | 'remote';
  remote_connection_id?: string;
  remote_ssh_host?: string;
}

export interface AssistantEntry {
  workspace_id?: string;
  path: string;
  name: string;
  assistant_id?: string;
}

export interface SessionInfo {
  workspace_id?: string;
  session_id: string;
  name: string;
  agent_type: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  workspace_path?: string;
  workspace_name?: string;
  /**
   * Client-side provenance of a scoped listing. Older cache records omit it
   * entirely or omit `workspace_id`; both shapes stay readable and are
   * attributed through the legacy compatibility helper.
   */
  workspace_identity?: {
    workspace_id?: string;
    path?: string;
    remote_connection_id?: string;
    remote_ssh_host?: string;
  };
}

/** `session_created` facts. Pre-ID hosts only return `session_id`. */
export interface CreatedSession {
  session_id: string;
  workspace_id?: string;
  workspace_path?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
}

export interface RemoteModelConfig {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  model_name: string;
  context_window?: number;
  enabled: boolean;
  capabilities: string[];
  reasoning?: {
    status: 'unsupported' | 'unknown' | 'known';
    default_preset?: string;
    presets?: Array<{
      id: string;
      label: string;
      order: number;
      actions: Array<
        | { type: 'effort'; value: string }
        | { type: 'toggle'; enabled: boolean }
        | { type: 'budget_tokens'; value: number }
        | { type: 'request_patch'; body: Record<string, unknown> }
      >;
      source: 'models_dev' | 'adapter_fallback' | 'model_config';
    }>;
  };
}

export interface RemoteDefaultModels {
  primary?: string | null;
  fast?: string | null;
}

export interface RemoteModelCatalog {
  version: number;
  models: RemoteModelConfig[];
  default_models: RemoteDefaultModels;
  reasoning_preset_selection_supported?: boolean;
  session_model_id?: string | null;
  session_reasoning_preset?: string | null;
}

export interface RemoteSessionModelSelection {
  model_id: string;
  reasoning_preset: string | null;
}

export interface ChatMessageItem {
  type: 'text' | 'tool' | 'thinking';
  content?: string;
  tool?: RemoteToolStatus;
  is_subagent?: boolean;
  subItems?: ChatMessageItem[];
}

export interface ChatImageAttachment {
  name: string;
  data_url: string;
}

export interface ChatMessage {
  turn_id?: string;
  status?: string;
  error?: string;
  id: string;
  role: string;
  content: string;
  timestamp: string;
  metadata?: any;
  tools?: RemoteToolStatus[];
  thinking?: string;
  items?: ChatMessageItem[];
  images?: ChatImageAttachment[];
}

export interface ActiveTurnSnapshot {
  turn_id: string;
  status: string;
  text: string;
  thinking: string;
  tools: RemoteToolStatus[];
  round_index: number;
  items?: ChatMessageItem[];
}

export interface RemoteToolStatus {
  id: string;
  name: string;
  status: string;
  duration_ms?: number;
  start_ms?: number;
  input_preview?: string;
  tool_input?: any;
  tool_output?: unknown;
  error_preview?: string;
}

export interface PollResponse {
  resp: string;
  version: number;
  changed: boolean;
  session_state?: string;
  title?: string;
  new_messages?: ChatMessage[];
  total_msg_count?: number;
  /** Authoritative replacement after persisted history changes in place. */
  message_snapshot?: ChatMessage[];
  active_turn?: ActiveTurnSnapshot | null;
  model_catalog?: RemoteModelCatalog;
}

export interface InitialSyncData {
  workspace_id?: string;
  has_workspace: boolean;
  path?: string;
  project_name?: string;
  git_branch?: string;
  workspace_kind?: 'normal' | 'assistant' | 'remote';
  assistant_id?: string;
  remote_connection_id?: string;
  remote_ssh_host?: string;
  sessions: SessionInfo[];
  has_more_sessions: boolean;
  authenticated_user_id?: string;
  capabilities?: string[];
}

export const REMOTE_CAPABILITY_HARNESS_PROFILES_V1 = 'harness_profiles_v1';
/** The host resolves `workspace_id` on workspace-scoped commands and events. */
export const REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1 = 'workspace_id_references_v1';

/**
 * A workspace reference as the UI knows it. `workspaceId` is authoritative;
 * the path and SSH selectors are only the legacy projection for pre-ID hosts.
 */
export interface WorkspaceCommandReference {
  workspaceId?: string;
  path?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

/**
 * Pure projection used by every workspace-scoped RemoteCommand. ID and legacy
 * fields never mix: with an ID the
 * payload carries only `workspace_id`, so an ID-aware host can never silently
 * fall back to the path. Without an ID the legacy triple is sent under the
 * command-specific path field name.
 */
export function projectWorkspaceWireReference(
  reference: WorkspaceCommandReference | undefined,
  pathField: 'path' | 'workspace_path',
  options: { nullablePath?: boolean } = {},
): Record<string, unknown> {
  const workspaceId = reference?.workspaceId?.trim();
  if (workspaceId) return { workspace_id: workspaceId };
  const legacy: Record<string, unknown> = {
    [pathField]: reference?.path ?? (options.nullablePath ? null : undefined),
  };
  if (reference?.remoteConnectionId !== undefined) {
    legacy.remote_connection_id = reference.remoteConnectionId;
  }
  if (reference?.remoteSshHost !== undefined) legacy.remote_ssh_host = reference.remoteSshHost;
  return legacy;
}

interface HostCapabilitySnapshot {
  /** Control target epoch the capabilities were read under. */
  epoch: number;
  /** False until a response from this target has advertised its capabilities. */
  known: boolean;
  capabilities: Set<string>;
}

export class RemoteSessionManager {
  private client: RelayHttpClient;
  private hostCapabilities: HostCapabilitySnapshot;
  private hostCapabilityProbe: Promise<void> | null = null;

  constructor(client: RelayHttpClient, capabilities?: string[]) {
    this.client = client;
    this.hostCapabilities = {
      epoch: client.controlTargetEpoch,
      known: capabilities !== undefined,
      capabilities: RemoteSessionManager.capabilitySet(capabilities),
    };
  }

  get controlTargetEpoch(): number {
    return this.client.controlTargetEpoch;
  }

  get controlTargetDeviceId(): string | null {
    return this.client.targetDeviceId;
  }

  private static capabilitySet(capabilities: string[] | undefined): Set<string> {
    return new Set(
      (capabilities ?? []).filter((capability) => typeof capability === 'string'),
    );
  }

  /** Capabilities belong to one control target; a switched target is unknown again. */
  private currentHostCapabilities(): HostCapabilitySnapshot | null {
    return this.hostCapabilities.epoch === this.client.controlTargetEpoch
      ? this.hostCapabilities
      : null;
  }

  supportsHostCapability(capability: string): boolean {
    return this.currentHostCapabilities()?.capabilities.has(capability) ?? false;
  }

  /** True when the connected host resolves workspace IDs on scoped commands. */
  supportsWorkspaceIdReferences(): boolean {
    return this.supportsHostCapability(REMOTE_CAPABILITY_WORKSPACE_ID_REFERENCES_V1);
  }

  /** True once this control target has answered with its capability list. */
  get hostCapabilitiesKnown(): boolean {
    return this.currentHostCapabilities()?.known ?? false;
  }

  private replaceHostCapabilities(capabilities: string[] | undefined, epoch: number): void {
    if (epoch !== this.client.controlTargetEpoch) return;
    this.hostCapabilities = {
      epoch,
      known: true,
      capabilities: RemoteSessionManager.capabilitySet(capabilities),
    };
  }

  /**
   * Learn the target's capabilities before the first ID-bearing command. The
   * host advertises them on `get_workspace_info`; hosts that predate the
   * capability list answer without one, which records an empty set.
   */
  private async ensureHostCapabilitiesKnown(target: ControlTargetSnapshot): Promise<void> {
    this.ensureControlTargetCurrent(target);
    if (this.hostCapabilitiesKnown) return;
    if (!this.hostCapabilityProbe) {
      this.hostCapabilityProbe = this.request<{ capabilities?: string[] }>(
        { cmd: 'get_workspace_info' },
        target,
      ).then((resp) => {
        this.replaceHostCapabilities(resp.capabilities, target.epoch);
      }).finally(() => {
        this.hostCapabilityProbe = null;
      });
    }
    await this.hostCapabilityProbe;
    this.ensureControlTargetCurrent(target);
  }

  /**
   * Project a workspace reference for a RemoteCommand. An ID is only sent to
   * a host that advertises `workspace_id_references_v1`; otherwise the caller
   * receives an explicit unsupported error instead of a path downgrade.
   */
  private async workspaceWireReference(
    reference: WorkspaceCommandReference | undefined,
    pathField: 'path' | 'workspace_path',
    target: ControlTargetSnapshot,
    options: { nullablePath?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const workspaceId = reference?.workspaceId?.trim();
    if (workspaceId) {
      await this.ensureHostCapabilitiesKnown(target);
      if (!this.supportsWorkspaceIdReferences()) {
        throw new WorkspaceIdReferencesUnsupportedError(workspaceId);
      }
    }
    return projectWorkspaceWireReference(reference, pathField, options);
  }

  /**
   * File commands address a runtime workspace by ID, or a bare device location
   * by its browsed directory and captured connection. The file `path` itself
   * stays a separate IO operand on the command.
   */
  private async runtimeFileWorkspaceReference(
    workspace: RuntimeFileWorkspace | undefined,
    target: ControlTargetSnapshot,
  ): Promise<Record<string, unknown>> {
    return this.workspaceWireReference({
      workspaceId: workspace?.workspaceId,
      path: workspace?.path,
      remoteConnectionId: workspace?.remoteConnectionId,
    }, 'workspace_path', target);
  }

  onControlTargetChange(listener: () => void): () => void {
    return this.client.onControlTargetChange(listener);
  }

  private ensureControlTargetCurrent(snapshot: ControlTargetSnapshot): void {
    if (!this.client.isControlTargetCurrent(snapshot)) {
      throw new RemoteControlTargetChangedError();
    }
  }

  private async request<T>(
    cmd: object,
    target: ControlTargetSnapshot = this.client.getControlTargetSnapshot(),
    options: RemoteRequestOptions = {},
  ): Promise<T> {
    // A caller may bind several transport requests into one logical operation
    // (for example, a chunked file download). Fence before any transport call
    // so a stale operation cannot send its next step to the replacement target.
    this.ensureControlTargetCurrent(target);
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cmdWithId = { ...cmd, _request_id: requestId };
    const commandName = (cmd as { cmd?: unknown }).cmd;
    const retryable = typeof commandName === 'string'
      && RETRYABLE_REMOTE_READ_COMMANDS.has(commandName);
    const relayOptions = options.timeoutMs === undefined
      ? { retryable }
      : { retryable, timeoutMs: options.timeoutMs };
    const targetDeviceId = target.deviceId;
    if (!targetDeviceId) throw new Error('Select an account device to continue');
    try {
      const resp = await this.client.sendDeviceRpc<T>(
        targetDeviceId,
        translateAgentIdentityFields(cmdWithId, 'legacy'),
        relayOptions,
      );
      this.ensureControlTargetCurrent(target);
      const respAny = resp as any;
      if (respAny.resp === 'error') {
        throw new Error(respAny.message || 'Unknown error');
      }
      return translateAgentIdentityFields(resp, 'canonical');
    } catch (error: unknown) {
      // Suppress both successful and failed completions after a target switch.
      // The epoch check (rather than device id alone) also closes A -> B -> A
      // ABA races.
      this.ensureControlTargetCurrent(target);
      throw error;
    }
  }

  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const target = this.client.getControlTargetSnapshot();
    const resp = await this.request<{ resp: string } & WorkspaceInfo>({
      cmd: 'get_workspace_info',
    }, target);
    this.replaceHostCapabilities(resp.capabilities, target.epoch);
    return {
      workspace_id: resp.workspace_id,
      has_workspace: resp.has_workspace,
      path: resp.path,
      project_name: resp.project_name,
      git_branch: resp.git_branch,
      workspace_kind: resp.workspace_kind,
      assistant_id: resp.assistant_id,
      remote_connection_id: normalizeWorkspaceRouting(resp).remote_connection_id,
      remote_ssh_host: normalizeWorkspaceRouting(resp).remote_ssh_host,
      capabilities: resp.capabilities,
    };
  }

  async listRecentWorkspaces(): Promise<RecentWorkspaceEntry[]> {
    const resp = await this.request<{
      resp: string;
      workspaces: RecentWorkspaceEntry[];
    }>({ cmd: 'list_recent_workspaces' });
    return (resp.workspaces || []).map(normalizeWorkspaceRouting);
  }

  async listWorkspaceCatalog(): Promise<WorkspaceCatalog> {
    const target = this.client.getControlTargetSnapshot();
    const resp = await this.request<{
      workspaces: RecentWorkspaceEntry[];
      opened_workspaces?: RecentWorkspaceEntry[] | null;
    }>({ cmd: 'list_recent_workspaces' }, target);
    // Workspace catalogs carry directory labels; assistant identities own their display names.
    const { assistants } = await this.request<{ assistants: AssistantEntry[] }>(
      { cmd: 'list_assistants' }, target,
    );
    return projectWorkspaceCatalog(resp, assistants);
  }

  async setWorkspace(workspace: RecentWorkspaceEntry): Promise<{
    success: boolean; workspace_id?: string; path?: string; project_name?: string;
    remote_connection_id?: string; remote_ssh_host?: string; error?: string;
  }> {
    const target = this.client.getControlTargetSnapshot();
    // Without an ID this is the upgrade-only protocol adapter for 1.0.0 hosts.
    const reference = await this.workspaceWireReference({
      workspaceId: workspace.workspace_id,
      path: workspace.path,
      remoteConnectionId: workspace.remote_connection_id,
      remoteSshHost: workspace.remote_ssh_host,
    }, 'path', target);
    return this.request({ cmd: 'set_workspace', ...reference }, target);
  }

  async subscribeSessionStream(sessionId: string,
    onEvent: (event: import('../../../shared/relay-transport/SessionCipher').SessionEvent) => void,
    onError: (error: unknown) => void, onCaughtUp?: () => void, onHistoryState?: (state: SessionHistoryState) => void, onResumed?: () => void): Promise<SessionStreamHandle> {
    const target = this.client.getControlTargetSnapshot();
    const grant = await this.request<{ session_id: string; relay_session_id: string; key: string }>({ cmd: 'get_session_key', session_id: sessionId }, target);
    this.ensureControlTargetCurrent(target);
    if (grant.session_id !== sessionId) throw new Error('Session key grant does not match the requested stream');
    return this.client.subscribeSessionStream(sessionId, grant.relay_session_id, grant.key, onEvent, onError, onCaughtUp, onHistoryState, onResumed);
  }

  /** Product operations execute on the controlled host, including its SSH adapter. */
  async invokeHost<T>(command: string, request: Record<string, unknown>, structured = true): Promise<T> {
    const response = await this.request<{ ok: boolean; value?: T; error?: string }>({
      cmd: 'host_invoke', command, args: structured ? { request } : request,
    });
    if (!response.ok) throw new Error(response.error || `Host operation failed: ${command}`);
    return response.value as T;
  }

  async listAssistants(): Promise<AssistantEntry[]> {
    const resp = await this.request<{
      resp: string;
      assistants: AssistantEntry[];
    }>({ cmd: 'list_assistants' });
    return resp.assistants || [];
  }

  async setAssistant(
    assistant: AssistantEntry,
  ): Promise<{
    success: boolean;
    workspace_id?: string;
    path?: string;
    name?: string;
    error?: string;
  }> {
    const target = this.client.getControlTargetSnapshot();
    // Assistant roots are local to the host; the legacy projection is path-only.
    const reference = await this.workspaceWireReference({
      workspaceId: assistant.workspace_id,
      path: assistant.path,
    }, 'path', target);
    return this.request({ cmd: 'set_assistant', ...reference }, target);
  }

  async listSessions(
    workspacePath?: string,
    limit = 30,
    offset = 0,
    query?: string,
    identity?: RemoteWorkspaceIdentity,
  ): Promise<{ sessions: SessionInfo[]; has_more: boolean }> {
    const target = this.client.getControlTargetSnapshot();
    const scoped = Boolean(identity?.workspaceId || workspacePath);
    // An unscoped listing keeps `workspace_path: null` so old hosts list the
    // current workspace; a scoped one sends the ID alone or the legacy triple.
    const reference = await this.workspaceWireReference({
      workspaceId: identity?.workspaceId,
      path: workspacePath,
      remoteConnectionId: identity?.remoteConnectionId,
      remoteSshHost: identity?.remoteSshHost,
    }, 'workspace_path', target, { nullablePath: true });
    const resp = await this.request<{
      resp: string;
      sessions: SessionInfo[];
      has_more: boolean;
    }>({
      cmd: 'list_sessions',
      ...reference,
      limit,
      offset,
      query: query?.trim() || null,
    }, target);
    return {
      sessions: (resp.sessions || []).map((session) => scoped ? {
        ...session,
        workspace_id: session.workspace_id ?? identity?.workspaceId,
        workspace_path: session.workspace_path || workspacePath,
        workspace_identity: {
          workspace_id: session.workspace_id ?? identity?.workspaceId,
          path: session.workspace_path || workspacePath || '',
          remote_connection_id: identity?.remoteConnectionId,
          remote_ssh_host: identity?.remoteSshHost,
        },
      } : session),
      has_more: resp.has_more ?? false,
    };
  }

  async createSession(
    agentType?: string,
    sessionName?: string,
    workspacePath?: string,
    identity?: RemoteWorkspaceIdentity,
  ): Promise<CreatedSession> {
    if (!identity?.workspaceId && !workspacePath?.trim()) throw new Error('Workspace path is required to create a session');
    const target = this.client.getControlTargetSnapshot();
    const reference = await this.workspaceWireReference({
      workspaceId: identity?.workspaceId,
      path: workspacePath,
      remoteConnectionId: identity?.remoteConnectionId,
      remoteSshHost: identity?.remoteSshHost,
    }, 'workspace_path', target, { nullablePath: true });
    const resp = await this.request<{ resp: string } & CreatedSession>({
      cmd: 'create_session',
      ...reference,
      agent_type: agentType || undefined,
      session_name: sessionName || undefined,
    }, target);
    return {
      session_id: resp.session_id,
      // Pre-ID hosts answer with the session ID only; the caller keeps its own
      // reference. New hosts pin the session to its workspace record.
      workspace_id: resp.workspace_id ?? identity?.workspaceId,
      workspace_path: resp.workspace_path ?? workspacePath,
      remote_connection_id: resp.remote_connection_id ?? identity?.remoteConnectionId,
      remote_ssh_host: resp.remote_ssh_host ?? identity?.remoteSshHost,
    };
  }

  async getSessionMessages(
    sessionId: string,
    limit?: number,
    beforeId?: string,
  ): Promise<{ messages: ChatMessage[]; has_more: boolean }> {
    const resp = await this.request<{
      resp: string;
      messages: ChatMessage[];
      has_more: boolean;
    }>({
      cmd: 'get_session_messages',
      session_id: sessionId,
      limit,
      before_message_id: beforeId,
    });
    return {
      messages: resp.messages || [],
      has_more: resp.has_more || false,
    };
  }

  async getModelCatalog(sessionId?: string): Promise<RemoteModelCatalog> {
    const resp = await this.request<{
      resp: string;
      catalog: RemoteModelCatalog;
    }>({
      cmd: 'get_model_catalog',
      session_id: sessionId ?? undefined,
    });
    return resp.catalog;
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<string> {
    const resp = await this.request<{
      resp: string;
      session_id: string;
      model_id: string;
    }>({
      cmd: 'set_session_model',
      session_id: sessionId,
      model_id: modelId,
    }, undefined, { timeoutMs: REMOTE_SETTING_WRITE_TIMEOUT_MS });
    return resp.model_id;
  }

  async setSessionModelSelection(
    sessionId: string,
    modelId: string,
    reasoningPreset: string | null,
  ): Promise<RemoteSessionModelSelection> {
    const resp = await this.request<{
      resp: string;
      session_id: string;
      model_id: string;
      reasoning_preset: string | null;
    }>({
      cmd: 'set_session_model',
      session_id: sessionId,
      model_id: modelId,
      reasoning_preset: reasoningPreset,
    }, undefined, { timeoutMs: REMOTE_SETTING_WRITE_TIMEOUT_MS });
    return {
      model_id: resp.model_id,
      reasoning_preset: resp.reasoning_preset ?? null,
    };
  }

  async sendMessage(
    sessionId: string,
    content: string,
    agentType?: string,
    imageContexts?: Array<{
      id: string;
      image_path?: string;
      data_url?: string;
      mime_type: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<string> {
    const resp = await this.request<{ resp: string; turn_id: string }>({
      cmd: 'send_message',
      session_id: sessionId,
      content,
      agent_type: agentType || undefined,
      image_contexts: imageContexts && imageContexts.length > 0 ? imageContexts : undefined,
    });
    return resp.turn_id;
  }

  async cancelTask(sessionId: string, turnId?: string): Promise<void> {
    await this.request({
      cmd: 'cancel_task',
      session_id: sessionId,
      turn_id: turnId ?? undefined,
    });
  }

  async cancelTool(toolId: string, reason?: string): Promise<void> {
    await this.request({
      cmd: 'cancel_tool',
      tool_id: toolId,
      reason: reason ?? undefined,
    });
  }

  async confirmTool(toolId: string, updatedInput?: Record<string, unknown>): Promise<void> {
    await this.request({ cmd: 'confirm_tool', tool_id: toolId, updated_input: updatedInput });
  }

  async rejectTool(toolId: string, reason?: string): Promise<void> {
    await this.request({
      cmd: 'reject_tool',
      tool_id: toolId,
      reason: reason ?? undefined,
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request({ cmd: 'delete_session', session_id: sessionId });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.request({
      cmd: 'update_session_title',
      session_id: sessionId,
      title,
    });
  }

  async startQuestionInteraction(sessionId: string, toolId: string): Promise<void> {
    if (!this.supportsHostCapability('user_question_interaction_v1')) {
      throw new Error('Execution host does not support stopping the question timeout');
    }
    await this.request({ cmd: 'start_question_interaction', session_id: sessionId, tool_id: toolId });
  }

  async answerQuestion(toolId: string, answers: any): Promise<void> {
    await this.request({ cmd: 'answer_question', tool_id: toolId, answers });
  }

  async pollSession(
    sessionId: string,
    sinceVersion: number,
    knownMsgCount: number,
    knownModelCatalogVersion = 0,
  ): Promise<PollResponse> {
    return this.request<PollResponse>({
      cmd: 'poll_session',
      session_id: sessionId,
      since_version: sinceVersion,
      known_msg_count: knownMsgCount,
      known_model_catalog_version: knownModelCatalogVersion,
    });
  }

  async ping(): Promise<void> {
    const controllerDeviceId = this.client.controllerDeviceId;
    if (!controllerDeviceId) throw new Error('Sign in to continue');
    await this.request({ cmd: 'ping', client: getControlClientIdentity(controllerDeviceId) });
  }

  /**
   * Fetch metadata for a workspace file (name, size, MIME type) without
   * transferring its content.  Used to render file cards before the user
   * confirms a download.
   */
  async getFileInfo(path: string, sessionId?: string, workspace?: RuntimeFileWorkspace): Promise<{
    name: string;
    size: number;
    mimeType: string;
  }> {
    const target = this.client.getControlTargetSnapshot();
    const workspaceIdentity = sessionId
      ? {}
      : await this.runtimeFileWorkspaceReference(workspace, target);
    const resp = await this.request<{
      resp: string;
      name: string;
      size: number;
      mime_type: string;
    }>({ cmd: 'get_file_info', path, session_id: sessionId ?? undefined, ...workspaceIdentity }, target);
    return {
      name: resp.name,
      size: resp.size,
      mimeType: resp.mime_type,
    };
  }

  /**
   * Read a workspace file using chunked transfer.
   *
   * Reads revision-checked bounded chunks into an awaited sink, and
   * calls `onProgress(downloaded, total)` after each chunk so the UI can
   * display a progress bar.
   */
  async streamFile(
    path: string,
    onChunk: (bytes: Uint8Array) => Promise<void>,
    sessionId?: string,
    onProgress?: (downloaded: number, total: number) => void,
    maxBytes?: number,
    workspace?: RuntimeFileWorkspace,
  ): Promise<{
    name: string;
    mimeType: string;
    size: number;
  }> {
    if (!sessionId && !workspace?.path && !workspace?.workspaceId) {
      throw new Error('A fixed runtime workspace is required for download');
    }
    const target = this.client.getControlTargetSnapshot();
    const workspaceIdentity = sessionId
      ? {}
      : await this.runtimeFileWorkspaceReference(workspace, target);
    const CHUNK_SIZE = 3 * 1024 * 1024; // 3 MB per request
    let offset = 0;
    let receivedFirstChunk = false;
    let fileName = '';
    let mimeType = '';
    let totalSize = 0;
    let revision: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.request<{
        resp: string;
        name: string;
        chunk_base64: string;
        revision?: string;
        offset: number;
        chunk_size: number;
        total_size: number;
        mime_type: string;
      }>({
        cmd: 'read_file_chunk',
        ...workspaceIdentity,
        path,
        session_id: sessionId ?? undefined,
        offset,
        limit: Math.min(CHUNK_SIZE, maxBytes ?? CHUNK_SIZE),
      }, target);
      this.ensureControlTargetCurrent(target);

      if (!Number.isSafeInteger(resp.total_size) || resp.total_size < 0
        || resp.offset !== offset || !Number.isSafeInteger(resp.chunk_size)
        || resp.chunk_size < 0 || resp.chunk_size > CHUNK_SIZE
        || resp.chunk_size > resp.total_size - offset
        || (resp.chunk_size === 0 && offset < resp.total_size)) {
        throw new Error('Invalid or incomplete file transfer. Please retry.');
      }
      if (maxBytes !== undefined && resp.total_size > maxBytes) {
        throw new Error('File is too large for an inline preview. Download it to view.');
      }
      if (receivedFirstChunk && (resp.total_size !== totalSize || resp.name !== fileName || resp.mime_type !== mimeType || resp.revision !== revision)) {
        throw new Error('File changed during transfer. Please retry.');
      }
      const bytes = atob(resp.chunk_base64);
      if (bytes.length !== resp.chunk_size) throw new Error('File transfer byte count mismatch. Please retry.');
      await onChunk(Uint8Array.from(bytes, character => character.charCodeAt(0)));
      this.ensureControlTargetCurrent(target);
      receivedFirstChunk = true;
      fileName = resp.name;
      mimeType = resp.mime_type;
      totalSize = resp.total_size;
      revision = resp.revision;
      offset += resp.chunk_size;

      onProgress?.(Math.min(offset, totalSize), totalSize);

      if (offset >= totalSize || resp.chunk_size === 0) break;
    }

    this.ensureControlTargetCurrent(target);

    return {
      name: fileName,
      mimeType,
      size: totalSize,
    };
  }

  /** Inline previews only. Downloads should consume streamFile directly. */
  async readFile(
    path: string,
    sessionId?: string,
    onProgress?: (downloaded: number, total: number) => void,
    maxBytes?: number,
  ): Promise<{ name: string; contentBase64: string; mimeType: string; size: number }> {
    const parts: string[] = [];
    const metadata = await this.streamFile(path, async bytes => {
      let part = '';
      for (const byte of bytes) part += String.fromCharCode(byte);
      parts.push(part);
    }, sessionId, onProgress, maxBytes);
    return { ...metadata, contentBase64: btoa(parts.join('')) };
  }

}

export { SessionSynchronizer } from './SessionSynchronizer';
