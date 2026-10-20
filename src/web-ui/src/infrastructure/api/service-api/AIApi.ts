 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type { SendMessageRequest } from './tauri-commands';
import type { ConnectionTestMessageCode } from '@/shared/utils/aiConnectionTestMessages';
import type {
  OpenCodePlan,
  ReasoningCatalogProjection,
  ReasoningConfig,
  SubscriptionProvider,
} from '@/infrastructure/config/types';
export type {
  ReasoningCatalogProjection,
  ReasoningPresetAction,
} from '@/infrastructure/config/types';

export const AI_MODEL_CATALOG_UPDATED_EVENT = 'ai://model-catalog-updated';

export interface AIModelCatalogUpdatedEvent {
  sourceVersion: string;
  sha256: string;
}

export interface CreateAISessionRequest {
  session_id?: string;
  agent_type: string;
  model_name: string;
  description?: string;
}

export interface CreateAISessionResponse {
  session_id: string;
}

export interface ConnectionTestResult {
  success: boolean;
  response_time_ms: number;
  model_response?: string;
  message_code?: ConnectionTestMessageCode;
  error_details?: string;
}

export interface RemoteModelInfo {
  id: string;
  display_name?: string;
  routing?: { format: string; base_url: string; request_url: string };
}

export interface AIModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  model_name: string;
  context_window?: number;
  enabled: boolean;
  capabilities: string[];
  reasoning?: ReasoningCatalogProjection;
}

export type ProviderCatalogSource = 'cache' | 'bundle' | 'openbitfun' | 'mixed';
export type ProviderCatalogModelSource = 'models_dev' | 'openbitfun' | 'merged';

export interface ProviderCatalogModelCapabilities {
  chat: boolean;
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  structured_output: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
}

export interface ProviderCatalogModel {
  id: string;
  display_name?: string;
  description?: string;
  recommended: boolean;
  source: ProviderCatalogModelSource;
  family?: string;
  status?: string;
  release_date?: string;
  last_updated?: string;
  knowledge?: string;
  open_weights?: boolean;
  catalog_provider_ids?: string[];
  endpoint_ids?: string[];
  capabilities: ProviderCatalogModelCapabilities;
  limits?: {
    context?: number;
    input?: number;
    output?: number;
  };
  pricing?: {
    input?: string;
    output?: string;
    cache_read?: string;
    cache_write?: string;
  };
}

export interface ProviderCatalogEndpoint {
  id: string;
  base_url: string;
  api_format: string;
  label: string;
  is_default: boolean;
  trusted_for_auto_detection: boolean;
  catalog_provider_ids?: string[];
}

export interface ProviderCatalogProvider {
  id: string;
  display_order: number;
  name: string;
  description: string;
  help_url?: string;
  requires_api_key: boolean;
  catalog_provider_ids?: string[];
  catalog_providers?: Array<{
    id: string;
    name: string;
    api?: string;
    doc?: string;
    env?: string[];
  }>;
  endpoints: ProviderCatalogEndpoint[];
  models: ProviderCatalogModel[];
}

export interface ProviderCatalog {
  revision: string;
  source: ProviderCatalogSource;
  providers: ProviderCatalogProvider[];
}

export type ModelsDevCatalogSource = 'cache' | 'bundle' | 'empty';

export interface ModelsDevReasoningCatalog {
  revision: string;
  source: ModelsDevCatalogSource;
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      display_name?: string;
    }>;
  }>;
}

export interface ModelsDevCatalogStatus {
  active_source: ModelsDevCatalogSource;
  revision: string;
  cache_path: string;
  cache_exists: boolean;
  cache_updated_at_ms?: number;
  provider_count: number;
  reasoning_model_count: number;
  refresh_in_progress: boolean;
}

export interface ModelsDevRefreshResult {
  outcome: 'updated' | 'unchanged' | 'throttled';
  status: ModelsDevCatalogStatus;
}

export interface AIModelCatalog {
  version: number;
  models: AIModelCatalogEntry[];
  provider_catalog?: ProviderCatalog;
  models_dev_reasoning_catalog?: ModelsDevReasoningCatalog;
  default_models: {
    primary?: string | null;
    fast?: string | null;
    search?: string | null;
    image_understanding?: string | null;
    image_generation?: string | null;
    speech_recognition?: string | null;
  };
  session_model_id?: string;
}

/**
 * This machine's own models.dev projections.
 *
 * They describe the public models.dev catalog, which every host refreshes for
 * itself, so a controller rendering Model Settings while a peer is selected
 * enriches locally instead of pulling the peer's multi-MiB copy over the wire.
 */
export interface LocalModelsDevCatalogs {
  provider_catalog?: ProviderCatalog;
  models_dev_reasoning_catalog?: ModelsDevReasoningCatalog;
}

export interface ReasoningCatalogProjectionRequest {
  provider: string;
  modelName: string;
  baseUrl: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: ReasoningConfig;
}

export type SubscriptionLoginStatus = 'pending' | 'authorized' | 'failed' | 'cancelled';
export type SubscriptionLoginMethod = 'browser' | 'device';

export interface SubscriptionOfferingModel {
  id: string;
  display_name?: string | null;
}

export interface SubscriptionApiOffering {
  plan: OpenCodePlan;
  format: 'openai' | 'responses' | 'anthropic';
  base_url: string;
  suggested_model: string;
  models: SubscriptionOfferingModel[];
}

export interface SubscriptionAccount {
  provider: SubscriptionProvider;
  display_label: string;
  account?: string | null;
  expires_at?: number | null;
  connected: boolean;
  login_methods?: SubscriptionLoginMethod[];
  reauthentication_required?: boolean;
  vault_unavailable?: boolean;
  suggested_format: string;
  suggested_base_url: string;
  suggested_model: string;
  api_offerings: SubscriptionApiOffering[];
  management_url?: string | null;
}

/** One account slot. The bare provider key is the legacy default slot. */
export interface SubscriptionAccountInstance {
  account_id: string;
  is_default: boolean;
  supports_multiple_accounts?: boolean;
  enabled: boolean;
  upstream_account_id?: string | null;
  account: SubscriptionAccount;
}

export interface SubscriptionQuotaWindow {
  id: string;
  duration_seconds?: number | null;
  used_percent?: number | null;
  resets_at?: number | null;
}

export interface SubscriptionQuotaMeter extends SubscriptionQuotaWindow {
  display_name?: string | null;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  unit?: string | null;
  expires_at?: number | null;
  secondary?: boolean;
  unlimited?: boolean;
}

export interface SubscriptionQuotaSnapshot {
  account_id: string;
  provider: string;
  state: 'known' | 'stale' | 'unknown' | 'unsupported' | 'query_failed';
  credential_revision?: number;
  observed_at?: number | null;
  valid_until?: number | null;
  plan?: string | null;
  unlimited_credits?: boolean | null;
  windows: SubscriptionQuotaWindow[];
  details?: {
    version: number;
    buckets?: { id: string; display_name?: string | null; windows: SubscriptionQuotaWindow[] }[];
  } | null;
  display?: { version: number; expires_at?: number | null; meters: SubscriptionQuotaMeter[] } | null;
  error?: string | null;
}

export interface SubscriptionLogoutResult {
  cleanup_pending: boolean;
  warning?: string | null;
}

export interface SubscriptionLoginStartResult {
  provider: SubscriptionProvider;
  session_id: string;
  method?: SubscriptionLoginMethod;
  authorization_url: string;
  user_code?: string | null;
  instructions: string;
}

export interface SubscriptionLoginSessionSnapshot {
  provider: SubscriptionProvider;
  session_id: string;
  status: SubscriptionLoginStatus;
  method?: SubscriptionLoginMethod | null;
  authorization_url?: string | null;
  user_code?: string | null;
  instructions?: string | null;
  error?: string | null;
  account?: SubscriptionAccount | null;
}

export class AIApi {
   
  async listModels(): Promise<any[]> {
    try {
      return await api.invoke('list_ai_models', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('list_ai_models', error);
    }
  }

  /**
   * Model catalog of the host that renders the current surface.
   *
   * It carries the configured models, defaults and the session selection. The
   * models.dev projections never travel — they describe the public models.dev
   * catalog, which every host refreshes for itself — so a surface that needs
   * them composes them with {@link getLocalModelsDevCatalogs}.
   */
  async getModelCatalog(): Promise<AIModelCatalog> {
    try {
      return await api.invoke<AIModelCatalog>('get_ai_model_catalog', {});
    } catch (error) {
      throw createTauriCommandError('get_ai_model_catalog', error);
    }
  }

  /**
   * This machine's own models.dev projections. Controller-local: the Product
   * Operation Registry never proxies it to a peer.
   */
  async getLocalModelsDevCatalogs(): Promise<LocalModelsDevCatalogs> {
    try {
      return await api.invoke<LocalModelsDevCatalogs>('get_local_models_dev_catalogs', {});
    } catch (error) {
      throw createTauriCommandError('get_local_models_dev_catalogs', error);
    }
  }

  async projectReasoningCatalog(
    request: ReasoningCatalogProjectionRequest,
  ): Promise<ReasoningCatalogProjection> {
    try {
      return await api.invoke<ReasoningCatalogProjection>(
        'project_ai_model_reasoning_catalog',
        { request },
      );
    } catch (error) {
      throw createTauriCommandError('project_ai_model_reasoning_catalog', error);
    }
  }

  async getModelsDevCatalogStatus(): Promise<ModelsDevCatalogStatus> {
    try {
      return await api.invoke<ModelsDevCatalogStatus>('get_models_dev_catalog_status', {});
    } catch (error) {
      throw createTauriCommandError('get_models_dev_catalog_status', error);
    }
  }

  async refreshModelsDevCatalogNow(): Promise<ModelsDevRefreshResult> {
    try {
      return await api.invoke<ModelsDevRefreshResult>('refresh_models_dev_catalog_now', {});
    } catch (error) {
      throw createTauriCommandError('refresh_models_dev_catalog_now', error);
    }
  }

  async revealModelsDevCacheDirectory(): Promise<void> {
    try {
      await api.invoke('reveal_models_dev_cache_directory', {});
    } catch (error) {
      throw createTauriCommandError('reveal_models_dev_cache_directory', error);
    }
  }

  onModelCatalogUpdated(callback: (event: AIModelCatalogUpdatedEvent) => void): () => void {
    return api.listen(AI_MODEL_CATALOG_UPDATED_EVENT, callback);
  }

   
  async getModelInfo(modelId: string): Promise<any> {
    try {
      return await api.invoke('get_model_info', { 
        request: { modelId } 
      });
    } catch (error) {
      throw createTauriCommandError('get_model_info', error, { modelId });
    }
  }

   
  async testConnection(config: any): Promise<ConnectionTestResult> {
    try {
      return await api.invoke('test_ai_connection', { 
        request: config 
      });
    } catch (error) {
      throw createTauriCommandError('test_ai_connection', error, { config });
    }
  }

   
  async testConfigConnection(config: any): Promise<ConnectionTestResult> {
    try {
      return await api.invoke('test_ai_config_connection', { 
        request: { config } 
      });
    } catch (error) {
      throw createTauriCommandError('test_ai_config_connection', error, { config });
    }
  }

   
  async sendMessage(request: SendMessageRequest): Promise<any> {
    try {
      return await api.invoke('send_ai_message', { 
        request 
      });
    } catch (error) {
      throw createTauriCommandError('send_ai_message', error, request);
    }
  }

   
  async initializeAI(config: any): Promise<void> {
    try {
      await api.invoke('initialize_ai', { 
        request: { config } 
      });
    } catch (error) {
      throw createTauriCommandError('initialize_ai', error, { config });
    }
  }

   
  async testAIConfigConnection(config: any): Promise<ConnectionTestResult> {
    try {
      return await api.invoke('test_ai_config_connection', { 
        request: { config } 
      });
    } catch (error) {
      throw createTauriCommandError('test_ai_config_connection', error, { config });
    }
  }

  async listModelsByConfig(config: any): Promise<RemoteModelInfo[]> {
    try {
      return await api.invoke<RemoteModelInfo[]>('list_ai_models_by_config', {
        request: { config }
      });
    } catch (error) {
      throw createTauriCommandError('list_ai_models_by_config', error, { config });
    }
  }

   
  async createAISession(config: CreateAISessionRequest): Promise<CreateAISessionResponse> {
    try {
      return await api.invoke('create_ai_session', { 
        request: config 
      });
    } catch (error) {
      throw createTauriCommandError('create_ai_session', error, { config });
    }
  }

   
  async invokeAICommand<T = any>(command: string, config: any, additionalArgs?: Record<string, any>): Promise<T> {
    try {
      const args = {
        config,
        ...additionalArgs
      };
      return await api.invoke(command, args);
    } catch (error) {
      throw createTauriCommandError(command, error, { config, additionalArgs });
    }
  }

   
  async listSubscriptionAccounts(): Promise<SubscriptionAccount[]> {
    try {
      return await api.invoke<SubscriptionAccount[]>('list_subscription_accounts', {});
    } catch (error) {
      throw createTauriCommandError('list_subscription_accounts', error);
    }
  }

  /** Executes on the rendered account host through the normal transport. */
  async getSubscriptionAccountQuota(
    provider: SubscriptionProvider,
    accountId: string = provider,
    forceRefresh = false,
  ): Promise<SubscriptionQuotaSnapshot> {
    try {
      return await api.invoke<SubscriptionQuotaSnapshot>('get_subscription_account_quota', {
        request: { provider, accountId, forceRefresh },
      });
    } catch (error) {
      throw createTauriCommandError('get_subscription_account_quota', error, { provider, accountId });
    }
  }

  /** Reads credentials from the saved model on the selected host, never from a UI draft. */
  async getModelProviderQuota(modelId: string): Promise<SubscriptionQuotaSnapshot> {
    try {
      return await api.invoke<SubscriptionQuotaSnapshot>('get_subscription_account_quota', {
        request: { provider: 'opencode', accountId: `model:${modelId}`, modelId },
      });
    } catch (error) {
      throw createTauriCommandError('get_subscription_account_quota', error, { modelId });
    }
  }

  async refreshSubscriptionAccountForSlot(provider: SubscriptionProvider, accountId: string = provider): Promise<SubscriptionAccount> {
    return accountId === provider ? this.refreshSubscriptionAccount(provider)
      : (await this.refreshSubscriptionAccountInstance(provider, accountId)).account;
  }

  async refreshSubscriptionAccountInstance(provider: SubscriptionProvider, accountId: string): Promise<SubscriptionAccountInstance> {
    return api.invoke('refresh_subscription_account_instance', { request: { provider, accountId } });
  }

  async logoutSubscriptionAccountInstance(provider: SubscriptionProvider, accountId: string): Promise<SubscriptionLogoutResult> {
    return api.invoke('logout_subscription_account_instance', { request: { provider, accountId } });
  }

  async listSubscriptionAccountInstances(): Promise<SubscriptionAccountInstance[]> {
    try {
      return await api.invoke<SubscriptionAccountInstance[]>('list_subscription_account_instances', {});
    } catch (error) {
      throw createTauriCommandError('list_subscription_account_instances', error);
    }
  }

  /** Signs in a new or existing slot; status uses `getSubscriptionLoginStatus`. */
  async startSubscriptionAccountLogin(
    provider: SubscriptionProvider,
    accountId: string,
    sessionId: string,
    method?: SubscriptionLoginMethod,
  ): Promise<SubscriptionLoginStartResult> {
    try {
      return await api.invoke<SubscriptionLoginStartResult>('start_subscription_account_login', {
        request: { provider, accountId, sessionId, method },
      });
    } catch (error) {
      throw createTauriCommandError('start_subscription_account_login', error, { provider, accountId, sessionId, method });
    }
  }

  async startSubscriptionLogin(
    provider: SubscriptionProvider,
    sessionId: string,
    method?: SubscriptionLoginMethod,
  ): Promise<SubscriptionLoginStartResult> {
    try {
      return await api.invoke<SubscriptionLoginStartResult>('start_subscription_login', {
        request: { provider, sessionId, method },
      });
    } catch (error) {
      throw createTauriCommandError('start_subscription_login', error, { provider, sessionId, method });
    }
  }

  async getSubscriptionLoginStatus(
    provider: SubscriptionProvider,
    sessionId: string,
  ): Promise<SubscriptionLoginSessionSnapshot> {
    try {
      return await api.invoke<SubscriptionLoginSessionSnapshot>('get_subscription_login_status', {
        request: { provider, sessionId },
      });
    } catch (error) {
      throw createTauriCommandError('get_subscription_login_status', error, { provider, sessionId });
    }
  }

  async cancelSubscriptionLogin(provider: SubscriptionProvider, sessionId: string): Promise<void> {
    try {
      await api.invoke('cancel_subscription_login', { request: { provider, sessionId } });
    } catch (error) {
      throw createTauriCommandError('cancel_subscription_login', error, { provider, sessionId });
    }
  }

  async logoutSubscriptionAccount(provider: SubscriptionProvider): Promise<SubscriptionLogoutResult> {
    try {
      return await api.invoke<SubscriptionLogoutResult>('logout_subscription_account', {
        request: { provider },
      });
    } catch (error) {
      throw createTauriCommandError('logout_subscription_account', error, { provider });
    }
  }

  async refreshSubscriptionAccount(
    provider: SubscriptionProvider,
  ): Promise<SubscriptionAccount> {
    try {
      return await api.invoke<SubscriptionAccount>('refresh_subscription_account', {
        request: { provider },
      });
    } catch (error) {
      throw createTauriCommandError('refresh_subscription_account', error, { provider });
    }
  }
}

export const aiApi = new AIApi();
