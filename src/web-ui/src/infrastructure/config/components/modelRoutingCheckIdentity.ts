import type { AIModelConfig, DefaultModelsConfig, ModelRoutingConfig } from '../types';
import { stableJson } from './modelConnectionTestPlan';

/**
 * Private comparison data for the selected request configurations. It includes
 * credentials, so callers must never log, render, persist or transmit this value.
 * Labels and advisory metadata do not change a provider probe.
 */
export function modelRoutingCheckIdentity(
  models: AIModelConfig[],
  roles: DefaultModelsConfig | null,
  routerModelId: string | null | undefined,
  routing?: Partial<Pick<ModelRoutingConfig, 'protocol' | 'timeout_ms'>>,
): string {
  return stableJson({ routing: routerRequestSettings(routing), models: [roles?.primary, roles?.economy, routerModelId].map(id => {
    const model = models.find(candidate => Boolean(id) && candidate.id === id);
    if (!model) return [id ?? null, null];
    const { name: _name, metadata: _metadata, recommended_for: _recommendedFor, is_default: _isDefault, ...requestConfig } = model;
    return [id, {
      ...requestConfig,
      capabilities: Array.isArray(model.capabilities) ? [...model.capabilities].sort() : model.capabilities,
    }];
  }) });
}

/** Legacy hosts omit the protocol; their request contract is the original profile. */
export function routerRequestSettings(routing?: Partial<Pick<ModelRoutingConfig, 'protocol' | 'timeout_ms'>>) {
  return { protocol: routing?.protocol ?? 'openai_logprobs', timeout_ms: routing?.timeout_ms ?? 10000 };
}

/** Global request settings are not part of the model catalog supplied as props. */
export function affectsModelRoutingConnectionChecks(path: string): boolean {
  return !path || path === 'ai' || [
    'ai.proxy', 'ai.stream_idle_timeout_secs', 'ai.stream_ttft_timeout_secs',
    'ai.model_routing.protocol', 'ai.model_routing.timeout_ms',
  ].some(owned => path === owned || path.startsWith(`${owned}.`));
}

/** Compare host selection events only after a probe captured those selections. */
export function modelRoutingProbeSelectionChanged(
  path: string,
  newValue: unknown,
  roles: DefaultModelsConfig,
  routerModelId: string | null,
  routing?: Partial<Pick<ModelRoutingConfig, 'protocol' | 'timeout_ms'>>,
): boolean {
  const id = (value: unknown) => typeof value === 'string' && value ? value : null;
  if (path === 'ai.default_models.primary' || path === 'ai.default_models.economy') {
    const role = path.endsWith('.primary') ? 'primary' : 'economy';
    return newValue === undefined || id(newValue) !== id(roles[role]);
  }
  if (path === 'ai.model_routing.router_model_id') {
    return newValue === undefined || id(newValue) !== id(routerModelId);
  }
  if (path !== 'ai.default_models' && path !== 'ai.model_routing') return false;
  if (!newValue || typeof newValue !== 'object' || Array.isArray(newValue)) return true;
  const value = newValue as Record<string, unknown>;
  return path === 'ai.default_models'
    ? id(value.primary) !== id(roles.primary) || id(value.economy) !== id(roles.economy)
    : id(value.router_model_id) !== id(routerModelId)
      || (routing !== undefined && stableJson(routerRequestSettings(value as Partial<ModelRoutingConfig>)) !== stableJson(routerRequestSettings(routing)));
}
