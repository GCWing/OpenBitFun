import type { AIModelConfig } from '@/infrastructure/config/types';
import type { ModelPlanQuotaProvider } from '@/infrastructure/api/service-api/AIApi';
import type { ProviderTemplate } from '@/shared/types';
import { modelPlanQuotaKind } from './modelPlanQuota';

export const PLAN_SUBSCRIPTION_SERVICES = ['minimax', 'kimi_code', 'stepfun'] as const;

/** Reuse catalog endpoint facts; plan imports keep API-key authentication. */
export function planSubscriptionPreset(kind: ModelPlanQuotaProvider, templates: Record<string, ProviderTemplate>) {
  const templateId = kind === 'kimi_code' ? 'moonshot' : kind;
  const template = templates[templateId];
  if (!template) return null;
  const endpoint = [{ url: template.baseUrl, format: template.format }, ...(template.baseUrlOptions || [])]
    .find(item => modelPlanQuotaKind({ base_url: item.url }) === kind);
  return endpoint ? { templateId, ...endpoint } : null;
}

export function isPlanSubscriptionModel(model: Partial<AIModelConfig>): boolean {
  const kind = modelPlanQuotaKind(model);
  if (!kind) return false;
  // MiniMax shares inference endpoints with pay-as-you-go. Only an explicit
  // plan import may classify it as a subscription; never guess from its key.
  return model.metadata?.subscription_plan === kind || kind === 'kimi_code'
    || (kind === 'stepfun' && new URL(model.base_url!).pathname.startsWith('/step_plan/'));
}

export function isSubscriptionChannel(model: Partial<AIModelConfig>): boolean {
  return model.auth?.type === 'subscription' || model.auth?.type === 'subscription_pool' || isPlanSubscriptionModel(model);
}
