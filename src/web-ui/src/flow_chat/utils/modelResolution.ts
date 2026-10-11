/**
 * Model selector resolution shared by session creation and the composer.
 *
 * Leaf module: session drivers and flow-chat-manager modules both depend on
 * it, so it must not import either.
 */

import { createLogger } from '@/shared/utils/logger';
import type {
  AIModelConfig,
  AgentModelDefaultsConfig,
  DefaultModelsConfig,
} from '@/infrastructure/config/types';
import { aiApi } from '@/infrastructure/api/service-api/AIApi';
import {
  filterSelectableTextChatModels,
  isSelectableTextChatModel,
} from '@/infrastructure/config/services/modelCategory';
import { getRecentReasoningPreset } from './reasoningPresets';

const log = createLogger('ModelResolution');

export type ModelSelectionSource =
  | 'session'
  | 'profile'
  | 'mode-default'
  | 'primary-default'
  | 'recovery'
  | 'none';

export type ModelAvailabilityStatus =
  | 'loading'
  | 'load-error'
  | 'unconfigured'
  | 'no-enabled-chat-model'
  | 'ready'
  | 'degraded'
  | 'catalog-unavailable'
  | 'target-model-unavailable';

export interface ModelSelectionResolution {
  model: AIModelConfig | null;
  selectorId?: string;
  concreteModelId?: string;
  source: ModelSelectionSource;
  /** True when a higher-priority persisted reference could not be used. */
  recovered: boolean;
}

function findSelectableModel(models: readonly AIModelConfig[], modelRef: string | null | undefined): AIModelConfig | null {
  const value = modelRef?.trim();
  if (!value) return null;
  // Config IDs identify credentials; display and upstream names do not.
  const matches = models.filter(model => isSelectableTextChatModel(model) && model.id === value);
  return matches.length === 1 ? matches[0] : null;
}

function resolveModelForContextWindow(
  modelRef: string | null | undefined,
  models: readonly AIModelConfig[],
  defaultModels: DefaultModelsConfig,
): AIModelConfig | null {
  const value = modelRef?.trim();
  if (!value) return null;

  if (value === 'primary') {
    return findSelectableModel(models, defaultModels.primary);
  }

  if (value === 'fast') {
    return findSelectableModel(models, defaultModels.fast)
      ?? findSelectableModel(models, defaultModels.primary);
  }

  return findSelectableModel(models, value);
}

export function resolveModelReference(
  models: readonly AIModelConfig[],
  modelRef: string | null | undefined,
  defaultModels: DefaultModelsConfig = {},
): AIModelConfig | null {
  const value = modelRef?.trim();
  if (!value) return null;
  if (value === 'primary') {
    return findSelectableModel(models, defaultModels.primary);
  }
  if (value === 'fast') {
    return findSelectableModel(models, defaultModels.fast)
      ?? findSelectableModel(models, defaultModels.primary);
  }
  return findSelectableModel(models, value);
}

export interface ResolveModelSelectionInput {
  models: readonly AIModelConfig[];
  sessionModelId?: string | null;
  profileModelId?: string | null;
  modeDefaultModelId?: string | null;
  defaultModels?: DefaultModelsConfig;
}

/**
 * Resolve the model used by the normal composer. The returned selector ID
 * keeps symbolic `primary`/`fast` values for persistence compatibility while
 * exposing the concrete configured model for display and context calculations.
 */
export function resolveModelSelection({
  models,
  sessionModelId,
  profileModelId,
  modeDefaultModelId,
  defaultModels = {},
}: ResolveModelSelectionInput): ModelSelectionResolution {
  const selectableModels = filterSelectableTextChatModels(models);
  if (selectableModels.length === 0) {
    return { model: null, source: 'none', recovered: false };
  }

  const candidates: Array<{
    ref: string | null | undefined;
    source: Exclude<ModelSelectionSource, 'recovery' | 'none'>;
  }> = [
    { ref: sessionModelId, source: 'session' },
    { ref: profileModelId, source: 'profile' },
    { ref: modeDefaultModelId, source: 'mode-default' },
    { ref: defaultModels.primary, source: 'primary-default' },
  ];
  let recovered = false;

  for (const candidate of candidates) {
    const ref = candidate.ref?.trim();
    if (!ref) continue;
    const model = resolveModelReference(selectableModels, ref, defaultModels);
    if (model) {
      const selectorId = ref === 'primary' || ref === 'fast'
        ? ref
        : model.id;
      return {
        model,
        selectorId,
        concreteModelId: model.id,
        source: candidate.source,
        recovered,
      };
    }
    // A pinned session must not silently switch accounts when its ID is unavailable.
    if (candidate.source === 'session') {
      return { model: null, source: 'session', recovered: true };
    }
    recovered = true;
  }

  const fallback = selectableModels[0];
  const concreteModelId = fallback.id;
  return {
    model: fallback,
    selectorId: concreteModelId,
    concreteModelId,
    source: 'recovery',
    recovered: true,
  };
}

/** Resolve from already loaded facts so selection and send do not read settings twice. */
export function resolveModelMaxTokens(
  modelName: string | undefined,
  models: readonly AIModelConfig[],
  defaultModels: DefaultModelsConfig,
  modeDefaultModel?: string,
): number {
  const selection = modelName?.trim() || modeDefaultModel;
  return resolveModelForContextWindow(selection, models, defaultModels)?.context_window
    || resolveModelForContextWindow('primary', models, defaultModels)?.context_window
    || 128128;
}

export async function getModelMaxTokens(modelName?: string, agentType?: string): Promise<number> {
  try {
    const configManager = await import('@/infrastructure/config/services/ConfigManager').then(m => m.configManager);
    const configData = await configManager.getConfigs([
      'ai.models',
      'ai.default_models',
      ...(!modelName?.trim() ? ['ai.agent_model_defaults'] : []),
    ]);
    return resolveModelMaxTokens(
      modelName,
      (configData['ai.models'] as AIModelConfig[] | undefined) || [],
      (configData['ai.default_models'] as DefaultModelsConfig | undefined) || {},
      (configData['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined)?.mode,
    );
  } catch (error) {
    log.warn('Failed to get model max tokens', { modelName, agentType, error });
    return 128128;
  }
}

export async function resolveReasoningPresetForSessionCreation(
  modelName?: string,
): Promise<string | undefined> {
  try {
    const configManager = await import('@/infrastructure/config/services/ConfigManager').then(m => m.configManager);
    const configData = await configManager.getConfigs([
      'ai.models',
      'ai.default_models',
      ...(!modelName?.trim() ? ['ai.agent_model_defaults'] : []),
    ]);
    const models = (configData['ai.models'] as AIModelConfig[] | undefined) || [];
    const defaultModels = (configData['ai.default_models'] as DefaultModelsConfig | undefined) || {};
    const agentModelDefaults = configData['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined;
    const selection = modelName?.trim() || agentModelDefaults?.mode?.trim() || 'primary';
    const model = resolveModelForContextWindow(selection, models, defaultModels)
      ?? resolveModelForContextWindow('primary', models, defaultModels);
    const modelId = model?.id;
    if (!model || !modelId) return undefined;

    const preset = getRecentReasoningPreset(modelId);
    // No recent preset means nothing to validate: stopping here keeps session
    // creation free of any catalog read.
    if (!preset) return undefined;

    // Ask the host for this one model's projection instead of pulling the whole
    // model catalog. The projection is a few hundred bytes, while the catalog
    // carried the public models.dev projections of every provider and reasoning
    // model — multi-MiB over a peer connection, and awaited before the session
    // RPC was even issued.
    const projection = await aiApi.projectReasoningCatalog({
      provider: model.provider,
      modelName: model.model_name || modelId,
      baseUrl: model.base_url,
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
      reasoning: model.reasoning ?? {},
    });
    if (projection.status !== 'known') return undefined;
    const presetSupported = projection.presets?.some(item => item.id === preset) ?? false;
    return presetSupported ? preset : undefined;
  } catch (error) {
    log.warn('Failed to resolve recent reasoning preset during session creation', { error });
    return undefined;
  }
}
