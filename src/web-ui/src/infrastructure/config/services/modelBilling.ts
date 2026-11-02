import type { AIModelConfig } from '../types';

/** Advisory annotations on a configured channel, never a runtime billing policy. */
export const MODEL_BILLING_KEY = 'billing_v1';
export type ModelBillingKind = 'unknown' | 'api' | 'subscription';
export interface ModelBilling {
  version: 1;
  kind: ModelBillingKind;
  currency: 'CNY' | 'USD';
  input?: number;
  output?: number;
  cacheRead?: number;
  source: string;
  account: string;
  updatedAt: string;
  binding: string;
  needsReview?: boolean;
}

/** No credential material is stored in the annotation. Quotes describe the base channel. */
export function modelBillingBinding(model: AIModelConfig): string {
  const identity: unknown[] = [
    model.id, model.provider, model.base_url, model.model_name,
    model.metadata?.provider_instance_id ?? null,
    model.auth?.type ?? 'api_key',
    model.auth?.type === 'subscription' ? model.auth.provider : null,
    model.auth?.type === 'subscription' ? model.auth.plan ?? null : null,
  ];
  const accountId = model.auth?.type === 'subscription'
    && model.auth.account_id && model.auth.account_id !== model.auth.provider
    ? model.auth.account_id : null;
  // Pool revisions fence edits; only the provider and ordered members identify billing.
  const pool = model.auth?.type === 'subscription_pool'
    ? [model.auth.provider, model.auth.accounts] : null;
  const routing = model.channel_routing
    ? [model.channel_routing.version, model.channel_routing.fallback_model_ids,
      model.channel_routing.manual_channel ?? null] : null;
  // Keep legacy single-channel quotes valid until their channel identity changes.
  if (accountId || pool || routing) identity.push({ accountId, pool, routing });
  return JSON.stringify(identity);
}

const rate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function getModelBilling(model?: AIModelConfig): ModelBilling | undefined {
  const value: unknown = model?.metadata?.[MODEL_BILLING_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as ModelBilling;
  if (b.version !== 1 || !['unknown', 'api', 'subscription'].includes(b.kind)
    || !['CNY', 'USD'].includes(b.currency)
    || typeof b.binding !== 'string' || typeof b.source !== 'string'
    || typeof b.account !== 'string' || typeof b.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(b.updatedAt))
    || [b.input, b.output, b.cacheRead].some(n => n !== undefined && !rate(n))) return undefined;
  return b;
}

export function isModelBillingCurrent(model: AIModelConfig, billing = getModelBilling(model)): boolean {
  return Boolean(billing && !billing.needsReview && billing.binding === modelBillingBinding(model));
}

export function withModelBilling(model: AIModelConfig, billing: ModelBilling): AIModelConfig {
  if (model.metadata != null && (typeof model.metadata !== 'object' || Array.isArray(model.metadata))) {
    throw new Error('Cannot update billing with unsupported model metadata');
  }
  const next = { ...model, metadata: { ...model.metadata, [MODEL_BILLING_KEY]: billing } };
  if (!getModelBilling(next) || billing.binding !== modelBillingBinding(model)) {
    throw new Error('Invalid model billing annotation');
  }
  return next;
}

export interface BillingUsage { input: number; output: number; cachedInput: number }
export const COMPARISON_USAGE: BillingUsage = { input: 10_000, output: 2_000, cachedInput: 0 };

/** Cached input is part of total input. Missing applicable rates stay unknown. */
export function estimateModelCost(model: AIModelConfig | undefined, usage: BillingUsage): number | undefined {
  if (!model || !Object.values(usage).every(rate) || usage.cachedInput > usage.input) return undefined;
  const billing = getModelBilling(model);
  if (!billing || billing.kind !== 'api' || !isModelBillingCurrent(model, billing)) return undefined;
  const parts = [
    [usage.input - usage.cachedInput, billing.input],
    [usage.output, billing.output],
    [usage.cachedInput, billing.cacheRead],
  ];
  if (parts.some(([tokens, price]) => tokens! > 0 && price === undefined)) return undefined;
  const total = parts.reduce((sum, [tokens, price]) => sum + tokens! * (price ?? 0) / 1_000_000, 0);
  return Number.isFinite(total) ? total : undefined;
}

export function compareModelCosts(primary?: AIModelConfig, fast?: AIModelConfig, usage = COMPARISON_USAGE) {
  const primaryBilling = getModelBilling(primary);
  const fastBilling = getModelBilling(fast);
  const primaryCost = estimateModelCost(primary, usage);
  const fastCost = estimateModelCost(fast, usage);
  if (primaryCost === undefined || fastCost === undefined) return { status: 'unknown' as const };
  if (primaryBilling?.currency !== fastBilling?.currency) return { status: 'currency' as const };
  return {
    status: fastCost > primaryCost ? 'fastHigher' as const : 'comparable' as const,
    primaryCost, fastCost, currency: primaryBilling!.currency,
  };
}

/** Save against the latest host snapshot; do not overwrite concurrent model edits. */
export function updateModelBilling(models: AIModelConfig[], expected: AIModelConfig, billing: ModelBilling): AIModelConfig[] {
  const current = models.find(model => model.id === expected.id);
  if (!current || modelBillingBinding(current) !== modelBillingBinding(expected)
    || (current.api_key ?? '') !== (expected.api_key ?? '')
    || JSON.stringify(current.custom_headers ?? {}) !== JSON.stringify(expected.custom_headers ?? {})
    || JSON.stringify(current.metadata?.[MODEL_BILLING_KEY]) !== JSON.stringify(expected.metadata?.[MODEL_BILLING_KEY])) {
    throw new Error('Model or billing changed while editing; reopen billing details');
  }
  return models.map(model => model === current ? withModelBilling(model, billing) : model);
}
