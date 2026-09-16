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

export async function getModelMaxTokens(modelName?: string, agentType?: string): Promise<number> {
  try {
    const configManager = await import('@/infrastructure/config/services/ConfigManager').then(m => m.configManager);
    const configData = await configManager.getConfigs([
      'ai.models',
      'ai.default_models',
      'ai.agent_model_defaults',
    ]);
    const models = (configData['ai.models'] as AIModelConfig[] | undefined) || [];
    const defaultModels = (configData['ai.default_models'] as DefaultModelsConfig | undefined) || {};
    const agentModelDefaults = configData['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined;

    const normalizedModelName = modelName?.trim();
    const explicitModel = resolveModelForContextWindow(modelName, models, defaultModels);
    if (explicitModel?.context_window) {
      return explicitModel.context_window;
    }

    // Only legacy sessions without a model selector inherit the current mode
    // default. Session-owned selectors are resolved above.
    if (!normalizedModelName) {
      const modeModel = resolveModelForContextWindow(
        agentModelDefaults?.mode,
        models,
        defaultModels,
      );
      if (modeModel?.context_window) {
        return modeModel.context_window;
      }
    }

    const primaryModel = resolveModelForContextWindow('primary', models, defaultModels);
    if (primaryModel?.context_window) {
      return primaryModel.context_window;
    }

    log.debug('Model context_window config not found, using default', { modelName, agentType });
    return 128128;
  } catch (error) {
    log.warn('Failed to get model max tokens', { modelName, agentType, error });
    return 128128;
  }
}

export async function resolveReasoningPresetForSessionCreation(
  modelName?: string,
): Promise<string | undefined> {
  try {
    let modelSelection = modelName?.trim();
    if (!modelSelection) {
      const configManager = await import('@/infrastructure/config/services/ConfigManager').then(m => m.configManager);
      const configData = await configManager.getConfigs(['ai.agent_model_defaults']);
      const agentModelDefaults = configData['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined;
      modelSelection = agentModelDefaults?.mode?.trim() || 'primary';
    }

    const catalog = await aiApi.getModelCatalog();
    const selectedModelId = modelSelection === 'primary'
      ? catalog.default_models.primary ?? undefined
      : modelSelection === 'fast'
        ? catalog.default_models.fast ?? catalog.default_models.primary ?? undefined
        : modelSelection;
    const concreteModelId = selectedModelId
      && catalog.models.some(model => model.id === selectedModelId)
      ? selectedModelId
      : catalog.default_models.primary ?? undefined;
    if (!concreteModelId) return undefined;
    const projection = catalog.models.find(model => model.id === concreteModelId)?.reasoning;
    if (projection?.status !== 'known') return undefined;
    const preset = getRecentReasoningPreset(concreteModelId);
    return projection.presets?.some(item => item.id === preset) ? preset : undefined;
  } catch (error) {
    log.warn('Failed to resolve recent reasoning preset during session creation', { error });
    return undefined;
  }
}
