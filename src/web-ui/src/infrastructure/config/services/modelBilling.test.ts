import { describe, expect, it } from 'vitest';
import type { AIModelConfig } from '../types';
import { COMPARISON_USAGE, MODEL_BILLING_KEY, compareModelCosts, estimateModelCost, getModelBilling, isModelBillingCurrent, modelBillingBinding, updateModelBilling, withModelBilling } from './modelBilling';
import { preserveModelAnnotations } from './modelTags';

const base = (id = 'one'): AIModelConfig => ({
  id, provider: 'openai', base_url: 'https://provider.test/v1', name: 'Provider', model_name: 'same-model',
  category: 'text', capabilities: ['text_chat'], enabled: true,
});
const priced = (input: number, output: number, id = 'one') => {
  const model = base(id);
  return withModelBilling(model, {
    version: 1, kind: 'api', currency: 'CNY', input, output,
    binding: modelBillingBinding(model), source: 'Account quote', account: 'Work', updatedAt: '2026-10-16T00:00:00Z',
  });
};

describe('configured-channel billing annotations', () => {
  it('leaves legacy models and malformed/newer annotations unknown, without altering the record', () => {
    const legacy = base();
    expect(estimateModelCost(legacy, COMPARISON_USAGE)).toBeUndefined();
    const future = { ...legacy, metadata: { [MODEL_BILLING_KEY]: { version: 2, future: 'kept' } } };
    expect(getModelBilling(future)).toBeUndefined();
    expect(JSON.parse(JSON.stringify(future))).toEqual(future);
    const bad = priced(1, 2);
    bad.metadata![MODEL_BILLING_KEY].input = -1;
    expect(getModelBilling(bad)).toBeUndefined();
  });

  it('compares the same workload for two configured channels, not model names', () => {
    expect(compareModelCosts(priced(1, 2), priced(3, 4, 'two')).status).toBe('fastHigher');
    expect(compareModelCosts(priced(3, 4), priced(1, 2, 'two')).status).toBe('comparable');
    expect(estimateModelCost(priced(1, 2), COMPARISON_USAGE)).toBeCloseTo(0.014);
  });

  it('counts cached input once and requires the cache price only when applicable', () => {
    const m = priced(2, 4);
    expect(estimateModelCost(m, { input: 10000, output: 2000, cachedInput: 5000 })).toBeUndefined();
    m.metadata![MODEL_BILLING_KEY].cacheRead = 0.2;
    expect(estimateModelCost(m, { input: 10000, output: 2000, cachedInput: 5000 })).toBeCloseTo(0.019);
    expect(estimateModelCost(m, { input: 1, output: 0, cachedInput: 2 })).toBeUndefined();
    expect(estimateModelCost(m, { input: NaN, output: 0, cachedInput: 0 })).toBeUndefined();
  });

  it('distinguishes unknown rates, explicit zero, plans and currencies', () => {
    const free = priced(0, 0);
    expect(estimateModelCost(free, COMPARISON_USAGE)).toBe(0);
    delete free.metadata![MODEL_BILLING_KEY].input;
    expect(estimateModelCost(free, COMPARISON_USAGE)).toBeUndefined();
    const plan = priced(1, 2);
    plan.metadata![MODEL_BILLING_KEY].kind = 'subscription';
    expect(compareModelCosts(plan, priced(2, 3)).status).toBe('unknown');
    const usd = priced(1, 2, 'usd');
    usd.metadata![MODEL_BILLING_KEY].currency = 'USD';
    expect(compareModelCosts(usd, priced(1, 2)).status).toBe('currency');
  });

  it('does not infer billing from API keys or a subscription login', () => {
    const m = { ...base(), auth: { type: 'subscription', provider: 'opencode', plan: 'zen' } } as AIModelConfig;
    expect(getModelBilling(m)).toBeUndefined();
    expect(compareModelCosts(m, base('second')).status).toBe('unknown');
  });

  it('keeps legacy single-channel bindings valid and treats the implicit default account identically', () => {
    const api = priced(1, 2);
    expect(getModelBilling(api)?.binding).toBe(JSON.stringify([
      api.id, api.provider, api.base_url, api.model_name, null, 'api_key', null, null,
    ]));
    const subscription: AIModelConfig = { ...base(), auth: { type: 'subscription', provider: 'codex' } };
    const legacyBinding = JSON.stringify([
      subscription.id, subscription.provider, subscription.base_url, subscription.model_name,
      null, 'subscription', 'codex', null,
    ]);
    expect(modelBillingBinding(subscription)).toBe(legacyBinding);
    expect(modelBillingBinding({ ...subscription, auth: { ...subscription.auth, type: 'subscription', provider: 'codex', account_id: 'codex' } })).toBe(legacyBinding);
  });

  it('invalidates account, pool and channel changes without discarding the previous quote', () => {
    const account: AIModelConfig = { ...base(), auth: { type: 'subscription', provider: 'codex', account_id: 'account-one' } };
    const pool: AIModelConfig = { ...base(), auth: { type: 'subscription_pool', provider: 'codex', accounts: ['one', 'two'], revision: 2 } };
    const channel: AIModelConfig = { ...base(), channel_routing: { version: 1, fallback_model_ids: ['backup'] } };
    const quote = (model: AIModelConfig) => withModelBilling(model, {
      ...getModelBilling(priced(1, 2))!, binding: modelBillingBinding(model),
    });
    const changes: [AIModelConfig, Partial<AIModelConfig>][] = [
      [account, { auth: { type: 'subscription', provider: 'codex', account_id: 'account-two' } }],
      [pool, { auth: { type: 'subscription_pool', provider: 'opencode', accounts: ['one', 'two'], revision: 2 } }],
      [pool, { auth: { type: 'subscription_pool', provider: 'codex', accounts: ['two', 'one'], revision: 2 } }],
      [pool, { auth: { type: 'subscription_pool', provider: 'codex', accounts: ['one', 'three'], revision: 2 } }],
      [channel, { channel_routing: { version: 1, fallback_model_ids: ['other'] } }],
      [channel, { channel_routing: { version: 1, fallback_model_ids: ['backup'], manual_channel: 'backup' } }],
    ];
    for (const [original, change] of changes) {
      const model = quote(original);
      const changed = { ...model, ...change };
      expect(isModelBillingCurrent(changed)).toBe(false);
      const preserved = preserveModelAnnotations(model, changed);
      expect(getModelBilling(preserved)?.needsReview).toBe(true);
      expect(getModelBilling(preserved)?.input).toBe(1);
      expect(estimateModelCost(preserved, COMPARISON_USAGE)).toBeUndefined();
      expect(() => updateModelBilling([changed], model, getModelBilling(model)!)).toThrow();
    }
    const reviewedPool = quote(pool);
    expect(isModelBillingCurrent({ ...reviewedPool, auth: { type: 'subscription_pool', provider: 'codex', accounts: ['one', 'two'], revision: 3 } })).toBe(true);
  });

  it('binds only non-credential routing identities and leaves unquoted pools unknown', () => {
    const pool: AIModelConfig = { ...base(), api_key: 'fixture-api-secret',
      custom_headers: { Authorization: 'fixture-header-secret' },
      auth: { type: 'subscription_pool', provider: 'codex', accounts: ['one', 'two'], revision: 1 },
      channel_routing: { version: 1, fallback_model_ids: ['backup'] } };
    const binding = modelBillingBinding(pool);
    expect(binding).not.toContain('fixture-api-secret');
    expect(binding).not.toContain('fixture-header-secret');
    expect(binding).toContain('backup');
    expect(estimateModelCost(pool, COMPARISON_USAGE)).toBeUndefined();
  });

  it('invalidates a changed endpoint, model, auth or credential while preserving the quote', () => {
    const m = priced(1, 2);
    for (const change of [{ base_url: 'https://other.test' }, { model_name: 'new-model' }, { api_key: 'rotated' }]) {
      const next = preserveModelAnnotations(m, { ...m, ...change });
      expect(getModelBilling(next)?.needsReview).toBe(true);
      expect(estimateModelCost(next, COMPARISON_USAGE)).toBeUndefined();
      expect(getModelBilling(next)?.input).toBe(1);
    }
    expect(isModelBillingCurrent({ ...m, base_url: 'https://other.test' })).toBe(false);
    m.api_key = 'secret-credential';
    expect(JSON.stringify(getModelBilling(m))).not.toContain('secret-credential');
  });

  it('preserves latest per-model billing during group edits and never copies it to a new model', () => {
    const one = priced(1, 2);
    const two = priced(5, 6, 'two');
    const next = preserveModelAnnotations(two, { ...two, metadata: one.metadata });
    expect(getModelBilling(next)?.input).toBe(5);
    expect(getModelBilling(preserveModelAnnotations(undefined, { ...one, id: 'new' }))).toBeUndefined();
  });

  it('saves into the latest host snapshot and rejects concurrent changes or removal', () => {
    const m = priced(1, 2);
    const quote = { ...getModelBilling(m)!, input: 3 };
    const withTag = { ...m, metadata: { ...m.metadata, user_tags: ['keep'] } };
    const updated = updateModelBilling([withTag, base('other')], m, quote);
    expect(updated[0].metadata?.user_tags).toEqual(['keep']);
    expect(getModelBilling(JSON.parse(JSON.stringify(updated[0])))?.input).toBe(3);
    expect(() => updateModelBilling([], m, quote)).toThrow();
    expect(() => updateModelBilling([{ ...m, api_key: 'changed' }], m, quote)).toThrow();
    expect(() => updateModelBilling([priced(7, 8)], m, quote)).toThrow();
  });
});
