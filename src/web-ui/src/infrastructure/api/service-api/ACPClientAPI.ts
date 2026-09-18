import { api } from './ApiClient';
import type { ImageContextData as ImageInputContextData } from './ImageContextTypes';

export type AcpClientPermissionMode = 'ask' | 'allow_once' | 'reject_once';
export type AcpClientStatus = 'configured' | 'starting' | 'running' | 'stopped' | 'failed';

export interface AcpClientSubagentConfig {
  enabled: boolean;
  description?: string;
  bestFor?: string;
}

export interface AcpClientInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  readonly: boolean;
  /** Missing on older hosts; absence preserves the historical enabled behavior. */
  subagent?: AcpClientSubagentConfig;
  permissionMode: AcpClientPermissionMode;
  status: AcpClientStatus;
  toolName: string;
  sessionCount: number;
}

export interface AcpRequirementProbeItem {
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface AcpClientRequirementProbe {
  id: string;
  tool: AcpRequirementProbeItem;
  adapter?: AcpRequirementProbeItem;
  runnable: boolean;
  notes: string[];
}

export interface AcpClientIdRequest {
  clientId: string;
  remoteConnectionId?: string;
}

export interface UpdateAcpClientSubagentConfigRequest extends AcpClientSubagentConfig {
  clientId: string;
}

export interface CreateAcpFlowSessionRequest {
  clientId: string;
  sessionName?: string;
  /** Workspace identity; authoritative when present. Paths below are IO projections. */
  workspaceId?: string;
  workspacePath: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface CreateAcpFlowSessionResponse {
  sessionId: string;
  sessionName: string;
  agentType: string;
}

export interface StartAcpDialogTurnRequest {
  sessionId: string;
  clientId: string;
  userInput: string;
  originalUserInput?: string;
  turnId: string;
  /** Workspace identity; authoritative when present. Paths below are IO projections. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  timeoutSeconds?: number;
  imageContexts?: ImageInputContextData[];
  userMessageMetadata?: Record<string, unknown>;
}

export interface CancelAcpDialogTurnRequest {
  sessionId: string;
  clientId: string;
  /** Workspace identity; authoritative when present. Paths below are IO projections. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface GetAcpSessionOptionsRequest {
  sessionId: string;
  clientId: string;
  /** Workspace identity; authoritative when present. Paths below are IO projections. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface SetAcpSessionModelRequest {
  sessionId: string;
  clientId: string;
  /** Workspace identity; authoritative when present. Paths below are IO projections. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  modelId: string;
}

export type AcpSessionConfigValue =
  | { type: 'select'; value: string }
  | { type: 'boolean'; value: boolean };

export interface SetAcpSessionConfigOptionRequest {
  sessionId: string;
  clientId: string;
  /** Workspace identity; authoritative when present. Paths below are IO projections. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
  configId: string;
  value: AcpSessionConfigValue;
}

export interface AcpSessionModelOption {
  id: string;
  name: string;
  providerName?: string;
  description?: string;
}

export interface AcpSessionConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

interface AcpSessionConfigOptionBase {
  id: string;
  name: string;
  description?: string;
  category?: 'mode' | 'model' | 'thought_level' | string;
}

export type AcpSessionConfigOption = AcpSessionConfigOptionBase & (
  | {
      type: 'select';
      currentValue: string;
      options: AcpSessionConfigSelectOption[];
    }
  | {
      type: 'boolean';
      currentValue: boolean;
    }
);

export interface AcpContextUsage {
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  };
}

export interface AcpSessionOptions {
  currentModelId?: string;
  availableModels: AcpSessionModelOption[];
  modelConfigId?: string;
  configOptions: AcpSessionConfigOption[];
  contextUsage?: AcpContextUsage;
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface AcpAvailableCommandsUpdatedEvent {
  sessionId: string;
  clientId: string;
  commands: AcpAvailableCommand[];
}

export interface AcpPlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low' | string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

export interface AcpPlanUpdatedEvent {
  sessionId: string;
  turnId: string;
  clientId: string;
  entries: AcpPlanEntry[];
}

export interface AcpSessionOptionsChangedEvent {
  sessionId: string;
  clientId: string;
}

export interface SubmitAcpPermissionResponseRequest {
  permissionId: string;
  approve: boolean;
  optionId?: string;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpPermissionRequestEvent {
  permissionId: string;
  sessionId: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    rawInput?: unknown;
    content?: unknown;
  };
  options?: AcpPermissionOption[];
}

const LOCAL_REQUIREMENT_CACHE_KEY = '__local__';
const CLIENT_LIST_CACHE_TTL_MS = 1000;
const requirementProbeCache = new Map<string, AcpClientRequirementProbe[]>();
const requirementProbeInFlight = new Map<string, Promise<AcpClientRequirementProbe[]>>();

export class ACPClientAPI {
  private static clientListCache: {
    clients: AcpClientInfo[];
    expiresAt: number;
  } | null = null;

  private static clientListInFlight: Promise<AcpClientInfo[]> | null = null;

  private static invalidateClientListCache(): void {
    ACPClientAPI.clientListCache = null;
    ACPClientAPI.clientListInFlight = null;
  }

  private static invalidateRequirementProbeCache(): void {
    requirementProbeCache.clear();
    requirementProbeInFlight.clear();
  }

  static async initializeClients(): Promise<void> {
    await api.invoke('initialize_acp_clients');
    ACPClientAPI.invalidateClientListCache();
    ACPClientAPI.invalidateRequirementProbeCache();
    window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
  }

  static async getClients(): Promise<AcpClientInfo[]> {
    const now = Date.now();
    if (ACPClientAPI.clientListCache && ACPClientAPI.clientListCache.expiresAt > now) {
      return ACPClientAPI.clientListCache.clients;
    }
    if (ACPClientAPI.clientListInFlight) {
      return ACPClientAPI.clientListInFlight;
    }

    const inFlight = api.invoke<AcpClientInfo[]>('get_acp_clients')
      .then((clients) => {
        ACPClientAPI.clientListCache = {
          clients,
          expiresAt: Date.now() + CLIENT_LIST_CACHE_TTL_MS,
        };
        return clients;
      })
      .finally(() => {
        ACPClientAPI.clientListInFlight = null;
      });

    ACPClientAPI.clientListInFlight = inFlight;
    return inFlight;
  }

  static async probeClientRequirements(
    options: { force?: boolean; remoteConnectionId?: string } = {}
  ): Promise<AcpClientRequirementProbe[]> {
    const cacheKey = options.remoteConnectionId || LOCAL_REQUIREMENT_CACHE_KEY;
    if (!options.force && requirementProbeCache.has(cacheKey)) {
      return requirementProbeCache.get(cacheKey) ?? [];
    }
    if (!options.force && requirementProbeInFlight.has(cacheKey)) {
      return requirementProbeInFlight.get(cacheKey)!;
    }

    const request = options.remoteConnectionId
      ? { remoteConnectionId: options.remoteConnectionId, forceRefresh: options.force === true }
      : {};

    const inFlight = api.invoke<AcpClientRequirementProbe[]>('probe_acp_client_requirements', { request })
      .then((probes) => {
        requirementProbeCache.set(cacheKey, probes);
        window.dispatchEvent(new Event('openbitfun:acp-requirements-changed'));
        return probes;
      })
      .finally(() => {
        requirementProbeInFlight.delete(cacheKey);
      });

    requirementProbeInFlight.set(cacheKey, inFlight);
    return inFlight;
  }

  static async predownloadClientAdapter(request: AcpClientIdRequest): Promise<void> {
    await api.invoke('predownload_acp_client_adapter', { request });
    ACPClientAPI.invalidateClientListCache();
    ACPClientAPI.invalidateRequirementProbeCache();
    window.dispatchEvent(new Event('openbitfun:acp-requirements-changed'));
  }

  static async installClientCli(request: AcpClientIdRequest): Promise<void> {
    await api.invoke('install_acp_client_cli', { request });
    ACPClientAPI.invalidateClientListCache();
    ACPClientAPI.invalidateRequirementProbeCache();
    window.dispatchEvent(new Event('openbitfun:acp-requirements-changed'));
  }

  static async stopClient(request: AcpClientIdRequest): Promise<void> {
    await api.invoke('stop_acp_client', { request });
    ACPClientAPI.invalidateClientListCache();
    window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
  }

  static async loadJsonConfig(): Promise<string> {
    return api.invoke('load_acp_json_config');
  }

  static async saveJsonConfig(jsonConfig: string): Promise<void> {
    await api.invoke('save_acp_json_config', { jsonConfig });
    ACPClientAPI.invalidateClientListCache();
    ACPClientAPI.invalidateRequirementProbeCache();
    window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
  }

  static async updateClientSubagentConfig(
    request: UpdateAcpClientSubagentConfigRequest
  ): Promise<void> {
    const rawConfig = JSON.parse(await ACPClientAPI.loadJsonConfig()) as unknown;
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error('ACP client configuration is invalid');
    }

    const config = rawConfig as Record<string, unknown>;
    const rawClients = config.acpClients;
    if (!rawClients || typeof rawClients !== 'object' || Array.isArray(rawClients)) {
      throw new Error('ACP client configuration has no client registry');
    }

    const clients = rawClients as Record<string, unknown>;
    const rawClient = clients[request.clientId];
    if (!rawClient || typeof rawClient !== 'object' || Array.isArray(rawClient)) {
      throw new Error(`ACP client '${request.clientId}' is not configured`);
    }

    const description = request.description?.trim();
    const bestFor = request.bestFor?.trim();
    const client = rawClient as Record<string, unknown>;
    client.subagent = {
      enabled: request.enabled,
      ...(description ? { description } : {}),
      ...(bestFor ? { bestFor } : {}),
    };

    await ACPClientAPI.saveJsonConfig(JSON.stringify(config, null, 2));
  }

  static async submitPermissionResponse(
    request: SubmitAcpPermissionResponseRequest
  ): Promise<void> {
    return api.invoke('submit_acp_permission_response', { request });
  }

  static async createFlowSession(
    request: CreateAcpFlowSessionRequest
  ): Promise<CreateAcpFlowSessionResponse> {
    const response = await api.invoke<CreateAcpFlowSessionResponse>('create_acp_flow_session', { request });
    ACPClientAPI.invalidateClientListCache();
    window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
    return response;
  }

  static async startDialogTurn(request: StartAcpDialogTurnRequest): Promise<void> {
    return api.invoke('start_acp_dialog_turn', { request });
  }

  static async cancelDialogTurn(request: CancelAcpDialogTurnRequest): Promise<void> {
    return api.invoke('cancel_acp_dialog_turn', { request });
  }

  static async getSessionOptions(
    request: GetAcpSessionOptionsRequest
  ): Promise<AcpSessionOptions> {
    return api.invoke('get_acp_session_options', { request });
  }

  static async getSessionCommands(
    request: GetAcpSessionOptionsRequest
  ): Promise<AcpAvailableCommand[]> {
    return api.invoke('get_acp_session_commands', { request });
  }

  static async setSessionModel(
    request: SetAcpSessionModelRequest
  ): Promise<AcpSessionOptions> {
    return api.invoke('set_acp_session_model', { request });
  }

  static async setSessionConfigOption(
    request: SetAcpSessionConfigOptionRequest
  ): Promise<AcpSessionOptions> {
    return api.invoke('set_acp_session_config_option', { request });
  }

  static onAvailableCommandsUpdated(
    callback: (event: AcpAvailableCommandsUpdatedEvent) => void
  ): () => void {
    return api.listen<AcpAvailableCommandsUpdatedEvent>(
      'agentic://acp-available-commands-updated',
      callback
    );
  }

  static onPlanUpdated(callback: (event: AcpPlanUpdatedEvent) => void): () => void {
    return api.listen<AcpPlanUpdatedEvent>('agentic://acp-plan-updated', callback);
  }

  static onSessionOptionsChanged(
    callback: (event: AcpSessionOptionsChangedEvent) => void
  ): () => void {
    return api.listen<AcpSessionOptionsChangedEvent>(
      'agentic://acp-session-options-changed',
      callback
    );
  }
}

export default ACPClientAPI;
