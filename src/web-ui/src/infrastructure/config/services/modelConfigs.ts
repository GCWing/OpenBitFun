import { ModelConfig, ProviderTemplate, ApiFormat } from '../../../shared/types';
import { configManager } from './ConfigManager';
import { getCapabilitiesByCategory, resolveModelCategory } from './modelCategory';
import { i18nService } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { extractProviderSegmentFromBaseUrl, matchProviderCatalogItemByBaseUrl } from './providerCatalog';
import { BUILTIN_PROVIDER_TEMPLATES } from './builtinProviderCatalog';

const log = createLogger('ModelConfigManager');
const t = (key: string, options?: Record<string, unknown>) => i18nService.t(key, options);

type ProviderConfigLike = {
  id?: string;
  name?: string;
  model_name?: string;
  base_url?: string;
  metadata?: Record<string, unknown> | null;
};

export const PROVIDER_INSTANCE_METADATA_KEY = 'provider_instance_id';

/**
 * The provider instance a model config belongs to: one configured endpoint plus
 * credential, which is what the user manages as a single "provider".
 */
export function getProviderInstanceId(
  config: ProviderConfigLike | null | undefined,
): string | undefined {
  const value = config?.metadata?.[PROVIDER_INSTANCE_METADATA_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Grouping key for presenting models by provider. Configs written before the
 * provider-instance migration, and drafts that have not been saved yet, fall
 * back to their own identity so they stay visible as their own group.
 */
export function getProviderGroupKey(config: ProviderConfigLike): string {
  return getProviderInstanceId(config)
    || config.id
    || `${config.name ?? ''}:${config.model_name ?? ''}`;
}

/** Count exact model-id references in persisted selector/config structures. */
export function countModelConfigReferences(
  value: unknown,
  modelIds: ReadonlySet<string>,
): number {
  if (typeof value === 'string') return modelIds.has(value) ? 1 : 0;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (count, entry) => count + countModelConfigReferences(entry, modelIds),
      0,
    );
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (count, entry) => count + countModelConfigReferences(entry, modelIds),
      0,
    );
  }
  return 0;
}

/** Remove one configured provider instance and every model owned by it. */
export function removeProviderModelConfigs<T extends ProviderConfigLike>(
  configs: readonly T[],
  providerGroupKey: string,
): { remaining: T[]; removed: T[] } {
  const remaining: T[] = [];
  const removed: T[] = [];
  configs.forEach((config) => {
    if (getProviderGroupKey(config) === providerGroupKey) {
      removed.push(config);
    } else {
      remaining.push(config);
    }
  });
  return { remaining, removed };
}

function inferProviderTemplate(config: ProviderConfigLike): ProviderTemplate | undefined {
  const matchedCatalogItem = matchProviderCatalogItemByBaseUrl(config.base_url);
  // Safe module-level forward reference: PROVIDER_TEMPLATES is initialized before this runs.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  return matchedCatalogItem ? PROVIDER_TEMPLATES[matchedCatalogItem.id] : undefined;
}

export function getProviderTemplateId(config: ProviderConfigLike): string | undefined {
  return inferProviderTemplate(config)?.id;
}

export function getProviderDisplayName(config: ProviderConfigLike): string {
  const rawName = config.name?.trim() || '';
  const rawModelName = config.model_name?.trim() || '';
  if (rawName && rawModelName) {
    const dashedSuffix = ` - ${rawModelName}`;
    const slashSuffix = `/${rawModelName}`;

    if (rawName.endsWith(dashedSuffix)) {
      return rawName.slice(0, -dashedSuffix.length).trim();
    }
    if (rawName.endsWith(slashSuffix)) {
      return rawName.slice(0, -slashSuffix.length).trim();
    }
  }

  if (rawName) {
    return rawName;
  }

  const inferredTemplate = inferProviderTemplate(config);
  if (inferredTemplate) {
    return t(`settings/models:providers.${inferredTemplate.id}.name`);
  }

  return extractProviderSegmentFromBaseUrl(config.base_url) || t('settings/models:providerSelection.customTitle');
}

export function getModelDisplayName(config: ProviderConfigLike): string {
  const providerName = getProviderDisplayName(config);
  const modelName = config.model_name?.trim() || '';

  if (!providerName) return modelName;
  if (!modelName) return providerName;

  return `${providerName}/${modelName}`;
}

// Keep the retired `auto` selector reserved so legacy session data can never
// become ambiguous with a newly allocated concrete model config ID.
const RESERVED_MODEL_CONFIG_IDS = new Set(['primary', 'fast', 'auto', 'default']);

/** Allocate a readable config ID for a newly created model. */
export function allocateModelConfigId(modelName: string, existingIds: Iterable<string>): string {
  const base = modelName.trim();
  if (!base) {
    throw new Error('Model name is required to allocate a model config ID.');
  }

  const occupiedIds = new Set(
    Array.from(existingIds, (id) => id.trim()).filter(Boolean),
  );
  const isAvailable = (candidate: string) => (
    !occupiedIds.has(candidate)
    && !RESERVED_MODEL_CONFIG_IDS.has(candidate.toLowerCase())
  );

  if (isAvailable(base)) {
    return base;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (isAvailable(candidate)) {
      return candidate;
    }
  }
}

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = BUILTIN_PROVIDER_TEMPLATES;

type ConfigChangeListener = (configs: ModelConfig[]) => void;

class ModelConfigManager {
  private configs: ModelConfig[] = [];
  private listeners: Set<ConfigChangeListener> = new Set();
  private loadPromise: Promise<void> | null = null;
  private hasRequestedLoad = false;

  // Listener management
  addListener(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    this.loadConfigs();
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Notify listeners
  private notifyListeners(): void {
    const configsCopy = [...this.configs];
    
    this.listeners.forEach(listener => {
      try {
        listener(configsCopy);
      } catch (error) {
        log.error('Error in config change listener', error);
      }
    });
  }

  // New architecture: load via the unified config manager.
  private loadConfigs(): void {
    if (this.loadPromise || this.hasRequestedLoad) {
      return;
    }
    this.hasRequestedLoad = true;
    // Start with an empty set, then sync async.
    this.configs = [];

    // Async load the real config.
    this.loadPromise = this.syncFromConfigManager()
      .catch(error => {
        log.error('Failed to load configs', error);
        this.configs = [];
        this.notifyListeners();
      })
      .finally(() => {
        this.loadPromise = null;
      });
  }

  // New architecture: sync from the unified config manager.
  private async syncFromConfigManager(): Promise<void> {
    try {
      // Fetch AI model configuration from the unified config manager.
      const aiModels = await configManager.getConfig<any[]>('ai.models');
      
      if (aiModels && aiModels.length > 0) {
        // Convert backend shape -> frontend shape.
        this.configs = aiModels.map(model => ({
          id: model.id,
          name: model.name,
          baseUrl: model.base_url,
          apiKey: model.api_key,
          modelName: model.model_name,
          format: model.provider as ApiFormat,
          description: model.description || t('settings/models:messages.defaultDescription', { name: model.name }),
          isBuiltIn: false,
          contextWindow: model.context_window,
          maxTokens: model.max_tokens,
          maxImagesPerRequest: model.max_images_per_request,
          category: resolveModelCategory(
            model.model_name || '',
            model.category,
            model.provider
          ),
          capabilities: Array.isArray(model.capabilities) && model.capabilities.length > 0
            ? model.capabilities
            : getCapabilitiesByCategory(
                resolveModelCategory(
                  model.model_name || '',
                  model.category,
                  model.provider
                )
              ),
        }));
      } else {
        // No config available from backend.
        this.configs = [];
      }
      
      this.notifyListeners();
    } catch (error) {
      log.error('Failed to load configs from backend', error);
      this.configs = [];
      this.notifyListeners();
    }
  }

  // New architecture: persist via the unified config manager.
  private async saveConfigs(): Promise<void> {
    try {
      // Convert to backend shape.
      const backendConfigs = this.configs.map(config => ({
        id: config.id,
        name: config.name,
        model_name: config.modelName,
        provider: config.format,
        base_url: config.baseUrl,
        api_key: config.apiKey || '',
        enabled: true,
        description: config.description,
        context_window: config.contextWindow,
        max_tokens: config.maxTokens,
        max_images_per_request: config.maxImagesPerRequest,
        category: resolveModelCategory(
          config.modelName,
          config.category,
          config.format
        ),
        capabilities: config.capabilities && config.capabilities.length > 0
          ? config.capabilities
          : getCapabilitiesByCategory(
              resolveModelCategory(
                config.modelName,
                config.category,
                config.format
              )
            ),
      }));
      
      // Save to the unified config system.
      await configManager.setConfig('ai.models', backendConfigs);
      
      this.notifyListeners();
    } catch (error) {
      log.error('Failed to save configs', error);
      throw error;
    }
  }

  // Reload configuration (public).
  async reload(): Promise<void> {
    this.hasRequestedLoad = true;
    await this.syncFromConfigManager();
  }

  // Read operations
  getAllConfigs(): ModelConfig[] {
    this.loadConfigs();
    return [...this.configs];
  }

  getConfigById(id: string): ModelConfig | undefined {
    return this.configs.find(config => config.id === id);
  }

  // Write operations
  addConfig(config: Omit<ModelConfig, 'id'>): ModelConfig {
    const newConfig: ModelConfig = {
      ...config,
      id: this.generateId(),
    };
    this.configs.push(newConfig);
    
    // Persist async.
    this.saveConfigs().catch(error => {
      log.error('Failed to save new config', error);
    });
    
    return newConfig;
  }

  updateConfig(id: string, updates: Partial<ModelConfig>): boolean {
    const index = this.configs.findIndex(config => config.id === id);
    if (index === -1) return false;

    this.configs[index] = { ...this.configs[index], ...updates };
    
    // Persist async.
    this.saveConfigs().catch(error => {
      log.error('Failed to update config', { configId: id, error });
    });
    
    return true;
  }

  deleteConfig(id: string): boolean {
    const index = this.configs.findIndex(config => config.id === id);
    if (index === -1) return false;

    this.configs.splice(index, 1);
    
    this.saveConfigs().catch(error => {
      log.error('Failed to delete config', { configId: id, error });
    });
    
    return true;
  }

  cloneConfig(id: string): ModelConfig | null {
    const config = this.getConfigById(id);
    if (!config) return null;

    const cloned = this.addConfig({
      ...config,
      name: t('settings/models:messages.cloneName', { name: config.name }),
      isBuiltIn: false
    });
    return cloned;
  }

  private generateId(): string {
    return `config_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  createFromTemplate(providerId: string, modelName: string): ModelConfig | null {
    const template = PROVIDER_TEMPLATES[providerId];
    if (!template) return null;

    const category = resolveModelCategory(modelName, undefined, template.format);

    return this.addConfig({
      name: template.name,
      baseUrl: template.baseUrl,
      modelName,
      format: template.format,
      description: t('settings/models:messages.templateDescription', { description: template.description, modelName }),
      isBuiltIn: false,
      category,
      capabilities: getCapabilitiesByCategory(category),
    });
  }

  resetToDefault(): void {
    this.configs = [];
    this.saveConfigs().catch(error => {
      log.error('Failed to reset configs', error);
    });
  }
}

export const getAllTemplates = (): ProviderTemplate[] => {
  return Object.values(PROVIDER_TEMPLATES);
};

export const getFormatDisplayName = (format: ApiFormat): string => {
  switch (format) {
    case 'openai':
      return t('settings/models:formats.openaiCompatible');
    case 'responses':
      return t('settings/models:formats.responsesApi');
    case 'anthropic':
      return t('settings/models:formats.claudeApi');
    case 'gemini':
      return t('settings/models:formats.geminiApi');
    default:
      return format;
  }
};

export const modelConfigManager = new ModelConfigManager();

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).modelConfigManager = modelConfigManager;
}
