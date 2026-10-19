import { expect, it } from 'vitest';
import { canReadSavedOpenCodeQuota } from './OpenCodeModelQuota';
import type { AIModelConfig } from '@/infrastructure/config/types';

it('queries only the saved connection and keeps draft credentials away from the billing API', () => {
  const saved = { id: 'go', base_url: 'https://opencode.ai/zen/go/v1', api_key: 'synthetic', auth: { type: 'api_key' } } as AIModelConfig;
  expect(canReadSavedOpenCodeQuota(saved, saved)).toBe(true);
  for (const draft of [{ ...saved, id: undefined }, { ...saved, api_key: 'other' },
    { ...saved, base_url: 'https://opencode.ai/zen/v1' }, { ...saved, custom_headers: { Authorization: 'other' } },
    { ...saved, auth: { type: 'subscription', provider: 'opencode' } }]) {
    expect(canReadSavedOpenCodeQuota(draft as Partial<AIModelConfig>, saved)).toBe(false);
  }
});
