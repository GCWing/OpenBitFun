import type { AIModelConfig, ModelCapability } from '../types';
import type { MagpieModel } from '@/infrastructure/api/service-api/MagpieAPI';
import { allocateModelConfigId, getProviderGroupKey, getProviderTemplateId } from './modelConfigs';
import { preserveModelAnnotations } from './modelTags';

export const MAGPIE_DEFAULT_URL = 'http://127.0.0.1:3425/v1';
export const MAGPIE_APP_KEY = 'magpie-openbitfun';

export function magpieGatewayUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
    return url.toString();
  } catch { return value.trim(); }
}

export function isMagpieModel(config: AIModelConfig): boolean {
  return getProviderTemplateId(config) === 'magpie';
}

export interface MagpieConnection {
  id: string;
  baseUrl: string;
  apiKey: string;
  models: AIModelConfig[];
}

export function magpieConnections(models: AIModelConfig[]): MagpieConnection[] {
  const result: MagpieConnection[] = [];
  for (const model of models.filter(isMagpieModel)) {
    const baseUrl = magpieGatewayUrl(model.base_url);
    const apiKey = model.api_key?.trim() || MAGPIE_APP_KEY;
    const existing = result.find(item => item.baseUrl === baseUrl && item.apiKey === apiKey);
    if (existing) existing.models.push(model);
    else result.push({ id: getProviderGroupKey(model), baseUrl, apiKey, models: [model] });
  }
  return result;
}

// Mirrors config-contracts' persisted u32 limits and minimum supported context.
export function magpieModelImportIssue(model: MagpieModel): 'contextTooSmall' | 'invalidLimits' | undefined {
  for (const value of [model.context_window, model.max_output_tokens]) {
    if (value != null && (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff)) return 'invalidLimits';
  }
  if (model.context_window != null && model.context_window < 32_000) return 'contextTooSmall';
  return undefined;
}

/** Append selections atomically. Stable model IDs keep defaults/pool references intact. */
export function mergeMagpieModels(current: AIModelConfig[], catalog: MagpieModel[], selected: string[],
  baseUrl: string, apiKey: string, connection?: MagpieConnection): AIModelConfig[] {
  const gateway = magpieGatewayUrl(baseUrl);
  const key = apiKey.trim() || MAGPIE_APP_KEY;
  const oldIds = new Set(connection?.models.flatMap(model => model.id ? [model.id] : []));
  const belongs = (model: AIModelConfig): boolean => {
    if (model.auth && model.auth.type !== 'api_key') return false;
    const address = magpieGatewayUrl(model.base_url);
    const credential = model.api_key?.trim() || MAGPIE_APP_KEY;
    const fromConnection = Boolean(connection && (
      (model.id && oldIds.has(model.id)) || (address === connection.baseUrl && credential === connection.apiKey)
    ));
    return fromConnection || (address === gateway && credential === key);
  };
  const matching = current.filter(belongs);
  const instanceId = matching[0]?.metadata?.provider_instance_id || connection?.id || crypto.randomUUID();
  const source = { model_source: 'magpie', provider_instance_id: instanceId };
  // Retain absent catalog entries, disabled flags, custom settings and unknown metadata.
  const merged = current.map(model => {
    if (!belongs(model)) return model;
    if (model.metadata != null && (typeof model.metadata !== 'object' || Array.isArray(model.metadata))) {
      throw new Error('Cannot update unsupported Magpie model metadata');
    }
    const moved = magpieGatewayUrl(model.base_url) !== gateway;
    return preserveModelAnnotations(model, { ...model,
      ...(moved ? { base_url: model.provider === 'anthropic' ? gateway.replace(/\/v1$/, '') : gateway,
        request_url: undefined } : {}),
      api_key: key, metadata: { ...model.metadata, ...source },
    });
  });
  const imported = new Set(matching.map(model => model.model_name));
  const ids = new Set(current.flatMap(model => model.id ? [model.id] : []));
  for (const model of catalog) {
    if (!selected.includes(model.id) || imported.has(model.id)) continue;
    if (magpieModelImportIssue(model)) throw new Error('Unsupported Magpie model limits');
    const capabilities: ModelCapability[] = ['text_chat'];
    if (model.tool_call === true) capabilities.push('function_calling');
    if (model.modalities?.input.includes('image')) capabilities.push('image_understanding');
    const id = allocateModelConfigId(model.id, ids);
    ids.add(id); imported.add(model.id);
    // Advertised output is a ceiling; the configured request budget must also
    // satisfy OpenBitFun's 40% cap. Unknown context keeps the existing default.
    const maxTokens = model.max_output_tokens == null ? undefined
      : Math.min(model.max_output_tokens, Math.floor((model.context_window ?? 128_128) * 40 / 100));
    merged.push({ id, name: 'Magpie', provider: 'openai', base_url: gateway,
      api_key: key, auth: { type: 'api_key' }, model_name: model.id, enabled: true, recommended_for: [],
      category: capabilities.includes('image_understanding') ? 'multimodal' : 'general_chat',
      capabilities, context_window: model.context_window ?? undefined, max_tokens: maxTokens,
      metadata: { ...source, magpie_catalog_name: model.display_name ?? model.id,
        ...(model.max_output_tokens != null ? { magpie_max_output_tokens: model.max_output_tokens } : {}),
      },
    });
  }
  return merged;
}
