import { globalEventBus } from '@/infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import { configManager } from './ConfigManager';
import type { PermissionEffect, PermissionRule, ToolPermissionConfig } from '../types';

const log = createLogger('PermissionConfig');
const CONFIG_PATH = 'tool_permissions';

export const DEFAULT_TOOL_PERMISSION_CONFIG: ToolPermissionConfig = {
  policy: {
    preset: 'full_access',
    rules: [],
  },
  interaction: {
    auto_approve_ask: false,
  },
};

function normalizeRule(value: unknown): PermissionRule | null {
  if (!value || typeof value !== 'object') return null;
  const rule = value as Partial<PermissionRule>;
  const effect: PermissionEffect = rule.effect === 'allow' || rule.effect === 'deny' ? rule.effect : 'ask';
  if (typeof rule.action !== 'string' || typeof rule.resource !== 'string') return null;
  return { action: rule.action, resource: rule.resource, effect };
}

export function normalizeToolPermissionConfig(value: unknown): ToolPermissionConfig {
  const input = value && typeof value === 'object'
    ? value as { policy?: { preset?: unknown; rules?: unknown }; interaction?: { auto_approve_ask?: unknown } }
    : {};
  const policy = input.policy ?? {};
  const interaction = input.interaction ?? {};
  const rules = Array.isArray(policy.rules)
    ? policy.rules.map(normalizeRule).filter((rule): rule is PermissionRule => rule !== null)
    : [];

  return {
    policy: {
      preset: policy.preset === undefined
        ? DEFAULT_TOOL_PERMISSION_CONFIG.policy.preset
        : policy.preset === 'full_access' ? 'full_access' : 'ask',
      rules,
    },
    interaction: {
      auto_approve_ask: interaction.auto_approve_ask === true,
    },
  };
}

export class PermissionConfigService {
  async getConfig(options?: { requireLoaded?: boolean }): Promise<ToolPermissionConfig> {
    try {
      return normalizeToolPermissionConfig(await configManager.getConfig<ToolPermissionConfig>(CONFIG_PATH));
    } catch (error) {
      if (options?.requireLoaded) throw error;
      log.warn('Failed to load tool permission config, using safe defaults', error);
      return {
        policy: { preset: 'ask', rules: [] },
        interaction: { auto_approve_ask: DEFAULT_TOOL_PERMISSION_CONFIG.interaction.auto_approve_ask },
      };
    }
  }

  async saveConfig(config: ToolPermissionConfig): Promise<ToolPermissionConfig> {
    const normalized = normalizeToolPermissionConfig(config);
    await configManager.setConfig(CONFIG_PATH, normalized);
    globalEventBus.emit('permission:config:updated', normalized);
    return normalized;
  }

  async setPreset(preset: ToolPermissionConfig['policy']['preset']): Promise<ToolPermissionConfig> {
    await configManager.setConfig(`${CONFIG_PATH}.policy.preset`, preset);
    globalEventBus.emit('permission:config:updated');
    return this.getConfig();
  }

  async setAutoApproveAsk(enabled: boolean): Promise<ToolPermissionConfig> {
    await configManager.setConfig(`${CONFIG_PATH}.interaction.auto_approve_ask`, enabled);
    globalEventBus.emit('permission:config:updated');
    return this.getConfig();
  }
}

export const permissionConfigService = new PermissionConfigService();
