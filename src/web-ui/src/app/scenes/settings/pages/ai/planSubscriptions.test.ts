import { expect, it } from 'vitest';
import { BUILTIN_PROVIDER_TEMPLATES } from '@/infrastructure/config/services/builtinProviderCatalog';
import { isSubscriptionChannel, planSubscriptionPreset, PLAN_SUBSCRIPTION_SERVICES } from './planSubscriptions';

it('imports all three plans using catalog-owned official endpoints and explicit API-key auth', () => {
  const expected = {
    minimax: ['https://api.minimaxi.com/anthropic', 'anthropic'],
    kimi_code: ['https://api.kimi.com/coding', 'anthropic'],
    stepfun: ['https://api.stepfun.com/step_plan/v1', 'openai'],
  };
  for (const kind of PLAN_SUBSCRIPTION_SERVICES) {
    const preset = planSubscriptionPreset(kind, BUILTIN_PROVIDER_TEMPLATES)!;
    expect([preset.url, preset.format]).toEqual(expected[kind]);
    expect(isSubscriptionChannel({ base_url: preset.url, auth: { type: 'api_key' }, metadata: { subscription_plan: kind } })).toBe(true);
  }
});
it('keeps legacy and pay-as-you-go models in their original section while recognizing coding endpoints', () => {
  expect(isSubscriptionChannel({ base_url: 'https://api.minimaxi.com/anthropic' })).toBe(false);
  expect(isSubscriptionChannel({ base_url: 'https://api.moonshot.cn/v1' })).toBe(false);
  expect(isSubscriptionChannel({ base_url: 'https://api.stepfun.com/v1' })).toBe(false);
  expect(isSubscriptionChannel({ base_url: 'https://api.kimi.com/coding' })).toBe(true);
  expect(isSubscriptionChannel({ base_url: 'https://api.stepfun.ai/step_plan/v1' })).toBe(true);
  expect(isSubscriptionChannel({ auth: { type: 'subscription', provider: 'grok' } })).toBe(true);
  expect(isSubscriptionChannel({ base_url: 'https://proxy.test/v1', metadata: { subscription_plan: 'minimax' } })).toBe(false);
});
