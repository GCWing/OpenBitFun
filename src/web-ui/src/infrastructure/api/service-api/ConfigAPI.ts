import { workspaceScopedRequest } from './legacyWorkspaceCompatibility';
 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import type {
  AgentProfileConfigItem,
  DiagnosticsBundleInfo,
  GlobalSkillSettings,
  ModeSkillInfo,
  RuntimeLoggingInfo,
  ConfigValidationResult,
  SkillInfo,
  SkillScanReport,
  SkillLevel,
  SkillMarketDownloadResult,
  SkillMarketItem,
  SkillMarketResults,
  SkillValidationResult,
} from '../../config/types';
import type {
  SaveCloudSpeechConfigRequest,
  SaveCloudSpeechConfigResult,
} from '@/generated/api';

export type { SaveCloudSpeechConfigRequest, SaveCloudSpeechConfigResult } from '@/generated/api';

export interface GetSkillConfigsParams {
  forceRefresh?: boolean;
  workspaceId?: string;
}

function normalizeSkillScanReport<T>(response: T[] | Omit<SkillScanReport<T>, 'diagnosticsAvailable'>): SkillScanReport<T> {
  if (Array.isArray(response)) {
    return { skills: response, diagnostics: [], diagnosticsAvailable: false };
  }
  if (!response || !Array.isArray(response.skills) || !Array.isArray(response.diagnostics)) {
    throw new Error('Invalid Skill discovery response');
  }
  return { ...response, diagnosticsAvailable: true };
}

export interface GetModeSkillConfigsParams {
  modeId: string;
  forceRefresh?: boolean;
  workspaceId?: string;
}

export interface SetGlobalSkillDisabledParams {
  workspaceId?: string;
  skillKey: string;
  disabled: boolean;
}

export interface SetModeSkillDisabledParams {
  modeId: string;
  skillKey: string;
  disabled: boolean;
  workspaceId?: string;
}

export interface ReplaceModeSkillSelectionParams {
  modeId: string;
  enabledSkillKeys: string[];
  workspaceId?: string;
}

export interface ResetModeSkillSelectionParams {
  modeId: string;
  workspaceId?: string;
}

export interface AddSkillParams {
  expectedSourceFingerprint?: string;
  targetName?: string;
  sourceKey?: string;
  sourcePath: string;
  level: SkillLevel;
  workspaceId?: string;
}

export interface DeleteSkillParams {
  expectedImportId?: string;
  skillKey: string;
  workspaceId?: string;
}

export interface WebSearchCredentialStatus {
  provider: string;
  configured: boolean;
}

export interface DownloadSkillMarketParams {
  packageId: string;
  level?: SkillLevel;
  workspaceId?: string;
}

const SKILL_CONFIG_REQUEST_TIMEOUT_MS = 60_000;


export class ConfigAPI {
   
  async getConfig(path?: string, options?: { skipRetryOnNotFound?: boolean }): Promise<any> {
    try {
      
      const shouldSkipRetry = options?.skipRetryOnNotFound ?? false;
      
      return await api.invoke('get_config', 
        {
          request: path
            ? { path, skipRetryOnNotFound: shouldSkipRetry }
            : { skipRetryOnNotFound: shouldSkipRetry },
        },
        shouldSkipRetry ? { retries: 0 } : undefined
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const normalized = errorMessage.toLowerCase();
      if (
        normalized.includes('not found:') &&
        normalized.includes('config path') &&
        normalized.includes(`'${path}'`)
      ) {
        return undefined;
      }
      throw createTauriCommandError('get_config', error, { path });
    }
  }

  async getConfigs(
    paths: string[],
    options?: { skipRetryOnNotFound?: boolean }
  ): Promise<Record<string, any>> {
    const uniquePaths = Array.from(new Set(paths));
    if (uniquePaths.length === 0) {
      return {};
    }

    const shouldSkipRetry = options?.skipRetryOnNotFound ?? false;

    try {
      return await api.invoke('get_configs', {
        request: {
          paths: uniquePaths,
          skipRetryOnNotFound: shouldSkipRetry,
        },
      });
    } catch {
      const entries = await Promise.all(
        uniquePaths.map(async (path) => [
          path,
          await this.getConfig(path, options),
        ] as const)
      );
      return Object.fromEntries(entries);
    }
  }

   
  async setConfig(path: string, value: any): Promise<void> {
    try {
      await api.invoke('set_config', { 
        request: { path, value } 
      });
    } catch (error) {
      throw createTauriCommandError('set_config', error, { path, value: path === 'app.skill_market' ? '[redacted]' : value });
    }
  }

  async saveCloudSpeechConfig(
    request: SaveCloudSpeechConfigRequest
  ): Promise<SaveCloudSpeechConfigResult> {
    try {
      return await api.invoke('save_cloud_speech_config', { request });
    } catch (error) {
      throw createTauriCommandError('save_cloud_speech_config', error, {
        ...request,
        apiKey: request.apiKey ? '[redacted]' : '',
      });
    }
  }

  async getWebSearchCredentialStatus(provider: string): Promise<WebSearchCredentialStatus> {
    try {
      return await api.invoke('get_web_search_credential_status', {
        request: { provider },
      });
    } catch (error) {
      throw createTauriCommandError('get_web_search_credential_status', error, { provider });
    }
  }

  async saveWebSearchCredential(
    provider: string,
    secret: string,
  ): Promise<WebSearchCredentialStatus> {
    try {
      return await api.invoke('save_web_search_credential', {
        request: { provider, secret },
      });
    } catch (error) {
      throw createTauriCommandError('save_web_search_credential', error, {
        provider,
        secret: secret ? '[redacted]' : '',
      });
    }
  }

  async clearWebSearchCredential(provider: string): Promise<WebSearchCredentialStatus> {
    try {
      return await api.invoke('clear_web_search_credential', {
        request: { provider },
      });
    } catch (error) {
      throw createTauriCommandError('clear_web_search_credential', error, { provider });
    }
  }

  async validateConfig(): Promise<ConfigValidationResult> {
    try {
      return await api.invoke('validate_config');
    } catch (error) {
      throw createTauriCommandError('validate_config', error);
    }
  }

   
  async resetConfig(path?: string): Promise<void> {
    try {
      await api.invoke('reset_config', { 
        request: path ? { path } : {} 
      });
    } catch (error) {
      throw createTauriCommandError('reset_config', error, { path });
    }
  }

   
  async exportConfig(): Promise<any> {
    try {
      return await api.invoke('export_config', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('export_config', error);
    }
  }

   
  async importConfig(configData: any): Promise<void> {
    try {
      const result = await api.invoke<{ success: boolean; errors: string[] }>('import_config', {
        request: { configData } 
      });
      if (!result?.success) {
        throw new Error(result?.errors?.join('; ') || 'Configuration import was not confirmed');
      }
    } catch (error) {
      // Imported documents can contain credentials; never attach them to errors.
      throw createTauriCommandError('import_config', error);
    }
  }

   
  async reloadConfig(): Promise<void> {
    try {
      await api.invoke('reload_config', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('reload_config', error);
    }
  }

  async getRuntimeLoggingInfo(): Promise<RuntimeLoggingInfo> {
    try {
      return await api.invoke('get_runtime_logging_info', {
        request: {},
      });
    } catch (error) {
      throw createTauriCommandError('get_runtime_logging_info', error);
    }
  }

  async exportDiagnosticsBundle(): Promise<DiagnosticsBundleInfo> {
    try {
      return await api.invoke('export_diagnostics_bundle', {
        request: {},
      });
    } catch (error) {
      throw createTauriCommandError('export_diagnostics_bundle', error);
    }
  }

   
  async getModelConfigs(): Promise<any[]> {
    try {
      return await api.invoke('get_model_configs', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('get_model_configs', error);
    }
  }

   
  async saveModelConfig(config: any): Promise<void> {
    try {
      await api.invoke('save_model_config', { 
        request: { config } 
      });
    } catch (error) {
      throw createTauriCommandError('save_model_config', error, { config });
    }
  }

   
  async deleteModelConfig(configId: string): Promise<void> {
    try {
      await api.invoke('delete_model_config', { 
        request: { configId } 
      });
    } catch (error) {
      throw createTauriCommandError('delete_model_config', error, { configId });
    }
  }

  

   
  async getAgentProfileConfigs(): Promise<Record<string, AgentProfileConfigItem>> {
    try {
      return await api.invoke<Record<string, AgentProfileConfigItem>>('get_agent_profile_configs');
    } catch (error) {
      throw createTauriCommandError('get_agent_profile_configs', error);
    }
  }

  async getAgentProfileConfig(agentId: string): Promise<AgentProfileConfigItem> {
    try {
      return await api.invoke<AgentProfileConfigItem>('get_agent_profile_config', { agentId });
    } catch (error) {
      throw createTauriCommandError('get_agent_profile_config', error, { agentId });
    }
  }

  async setAgentProfileConfig(agentId: string, config: any): Promise<string> {
    try {
      return await api.invoke('set_agent_profile_config', { agentId, config });
    } catch (error) {
      throw createTauriCommandError('set_agent_profile_config', error, { agentId, config });
    }
  }

  async resetAgentProfileConfig(agentId: string): Promise<string> {
    try {
      return await api.invoke('reset_agent_profile_config', { agentId });
    } catch (error) {
      throw createTauriCommandError('reset_agent_profile_config', error, { agentId });
    }
  }

  async deleteSubagent(subagentId: string): Promise<void> {
    try {
      await api.invoke('delete_subagent', {
        request: { subagentId },
      });
    } catch (error) {
      throw createTauriCommandError('delete_subagent', error, { subagentId });
    }
  }

  

   
  async getSkillConfigs({
    forceRefresh,
    workspaceId,
  }: GetSkillConfigsParams = {}): Promise<SkillInfo[]> {
    try {
      return await api.invoke(
        'get_skill_configs',
        await workspaceScopedRequest({ forceRefresh, workspaceId }),
        { timeout: SKILL_CONFIG_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      throw createTauriCommandError('get_skill_configs', error, { forceRefresh, workspaceId });
    }
  }

   
  async getModeSkillConfigs({
    modeId,
    forceRefresh,
    workspaceId,
  }: GetModeSkillConfigsParams): Promise<ModeSkillInfo[]> {
    try {
      return await api.invoke(
        'get_mode_skill_configs',
        await workspaceScopedRequest({ modeId, forceRefresh, workspaceId }),
        { timeout: SKILL_CONFIG_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      throw createTauriCommandError('get_mode_skill_configs', error, { modeId, forceRefresh, workspaceId });
    }
  }

  async getSkillScanReport({ forceRefresh, workspaceId }: GetSkillConfigsParams = {}): Promise<SkillScanReport> {
    try {
      const response = await api.invoke<SkillInfo[] | Omit<SkillScanReport, 'diagnosticsAvailable'>>(
        'get_skill_configs', await workspaceScopedRequest({ forceRefresh, workspaceId, includeDiagnostics: true }),
        { timeout: SKILL_CONFIG_REQUEST_TIMEOUT_MS },
      );
      return normalizeSkillScanReport(response);
    } catch (error) {
      throw createTauriCommandError('get_skill_configs', error, { forceRefresh, workspaceId });
    }
  }

  async getModeSkillScanReport({ modeId, forceRefresh, workspaceId }: GetModeSkillConfigsParams): Promise<SkillScanReport<ModeSkillInfo>> {
    try {
      const response = await api.invoke<ModeSkillInfo[] | Omit<SkillScanReport<ModeSkillInfo>, 'diagnosticsAvailable'>>(
        'get_mode_skill_configs', await workspaceScopedRequest({ modeId, forceRefresh, workspaceId, includeDiagnostics: true }),
        { timeout: SKILL_CONFIG_REQUEST_TIMEOUT_MS },
      );
      return normalizeSkillScanReport(response);
    } catch (error) {
      throw createTauriCommandError('get_mode_skill_configs', error, { modeId, forceRefresh, workspaceId });
    }
  }

  async getGlobalSkillSettings(workspaceId?: string): Promise<GlobalSkillSettings> {
    try {
      return await api.invoke('get_global_skill_settings', workspaceId !== undefined ? { request: await workspaceScopedRequest({ workspaceId }) } : undefined);
    } catch (error) {
      throw createTauriCommandError('get_global_skill_settings', error);
    }
  }

  async setGlobalSkillDisabled({
    workspaceId,
    skillKey,
    disabled,
  }: SetGlobalSkillDisabledParams): Promise<GlobalSkillSettings> {
    try {
      return await api.invoke('set_global_skill_disabled', {
        request: await workspaceScopedRequest({ skillKey, disabled, workspaceId }),
      });
    } catch (error) {
      throw createTauriCommandError('set_global_skill_disabled', error, { skillKey, disabled });
    }
  }

   
  async setModeSkillDisabled({
    modeId,
    skillKey,
    disabled,
    workspaceId,
  }: SetModeSkillDisabledParams): Promise<string> {
    try {
      return await api.invoke('set_mode_skill_disabled', await workspaceScopedRequest({ modeId, skillKey, disabled, workspaceId }));
    } catch (error) {
      throw createTauriCommandError('set_mode_skill_disabled', error, { modeId, skillKey, disabled, workspaceId });
    }
  }

  async replaceModeSkillSelection({
    modeId,
    enabledSkillKeys,
    workspaceId,
  }: ReplaceModeSkillSelectionParams): Promise<string> {
    try {
      return await api.invoke('replace_mode_skill_selection', {
        request: await workspaceScopedRequest({ modeId, enabledSkillKeys, workspaceId }),
      });
    } catch (error) {
      throw createTauriCommandError('replace_mode_skill_selection', error, {
        modeId,
        enabledSkillKeys,
        workspaceId,
      });
    }
  }

  async resetModeSkillSelection({
    modeId,
    workspaceId,
  }: ResetModeSkillSelectionParams): Promise<string> {
    try {
      return await api.invoke('reset_mode_skill_selection', {
        request: await workspaceScopedRequest({ modeId, workspaceId }),
      });
    } catch (error) {
      throw createTauriCommandError('reset_mode_skill_selection', error, {
        modeId,
        workspaceId,
      });
    }
  }

   
  async validateSkillPath(path: string, source?: { sourceKey: string; workspaceId?: string }): Promise<SkillValidationResult> {
    try {
      return await api.invoke('validate_skill_path', await workspaceScopedRequest({ path, ...source }));
    } catch (error) {
      throw createTauriCommandError('validate_skill_path', error, { path });
    }
  }

   
  async addSkill({
    expectedSourceFingerprint,
    targetName,
    sourceKey,
    sourcePath,
    level,
    workspaceId,
  }: AddSkillParams): Promise<string> {
    try {
      return await api.invoke('add_skill', await workspaceScopedRequest({ sourcePath, level, workspaceId, ...(sourceKey ? { sourceKey } : {}), ...(targetName ? { targetName } : {}), ...(expectedSourceFingerprint !== undefined ? { expectedSourceFingerprint } : {}) }));
    } catch (error) {
      throw createTauriCommandError('add_skill', error, { sourcePath, level, workspaceId });
    }
  }

   
  async deleteSkill({
    expectedImportId,
    skillKey,
    workspaceId,
  }: DeleteSkillParams): Promise<string> {
    try {
      return await api.invoke('delete_skill', await workspaceScopedRequest({ skillKey, workspaceId, ...(expectedImportId ? { expectedImportId } : {}) }));
    } catch (error) {
      throw createTauriCommandError('delete_skill', error, { skillKey, workspaceId });
    }
  }

  async listSkillMarket(query?: string, limit?: number): Promise<SkillMarketItem[]> {
    try {
      return await api.invoke('list_skill_market', {
        request: { query, limit }
      });
    } catch (error) {
      throw createTauriCommandError('list_skill_market', error, { query, limit });
    }
  }

  async searchSkillMarket(query: string, limit?: number): Promise<SkillMarketItem[]> {
    try {
      return await api.invoke('search_skill_market', {
        request: { query, limit }
      });
    } catch (error) {
      throw createTauriCommandError('search_skill_market', error, { query, limit });
    }
  }

  async querySkillMarkets(query?: string, limit?: number): Promise<SkillMarketResults> {
    const command = query?.trim() ? 'search_skill_market' : 'list_skill_market';
    try {
      const result = await api.invoke<SkillMarketResults | SkillMarketItem[]>(command, {
        request: { query, limit, includeDiagnostics: true },
      });
      // Older hosts ignore the additive request flag and return the original array.
      if (Array.isArray(result)) return { skills: result, sourceErrors: [] };
      if (!result || !Array.isArray(result.skills) || !Array.isArray(result.sourceErrors)) {
        throw new Error('Invalid marketplace response');
      }
      return result;
    } catch (error) {
      throw createTauriCommandError(command, error, { query, limit });
    }
  }

  async downloadSkillMarket({
    packageId,
    level = 'project',
    workspaceId,
  }: DownloadSkillMarketParams): Promise<SkillMarketDownloadResult> {
    try {
      return await api.invoke('download_skill_market', {
        request: await workspaceScopedRequest({ package: packageId, level, workspaceId })
      });
    } catch (error) {
      throw createTauriCommandError('download_skill_market', error, {
        package: packageId,
        level,
        workspaceId,
      });
    }
  }
}


export const configAPI = new ConfigAPI();
