import { describe, expect, it } from 'vitest';
import type { ImageServiceConfig } from '@/infrastructure/config/types';
import { resolveImageEndpoint, withImageServiceAuth } from './imageDialects';

const legacyService: ImageServiceConfig = {
  id: 'saved-service', name: 'Saved image service', dialect: 'openai_images',
  base_url: 'https://api.openai.com/v1', request_url: 'https://api.openai.com/v1/images/generations',
  model_name: 'gpt-image-1', api_key: '', enabled: true,
  auth: { type: 'api_key' }, params: { size: '1024x1024', n: 3 },
};

describe('image service authentication routing', () => {
  it('preserves unsupported account-pool records instead of converting them to API keys', () => {
    const auth = { type: 'subscription_pool', provider: 'codex', accounts: ['account-a'], revision: 1 } as const;
    const saved = { ...legacyService, auth: { ...auth, accounts: [...auth.accounts] } };
    expect(withImageServiceAuth(saved, saved.auth)).toEqual(saved);
  });
  it('moves a reused Codex subscription off the public image endpoint', () => {
    const result = withImageServiceAuth(legacyService, { type: 'subscription', provider: 'codex' });
    expect(result).toMatchObject({ id: 'saved-service', dialect: 'chatgpt_codex', model_name: '', params: { n: 1 } });
    expect(resolveImageEndpoint(result.base_url, result.request_url, result.dialect))
      .toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(legacyService.request_url).toBe('https://api.openai.com/v1/images/generations');
  });

  it('recovers a serialized legacy subscription selection without changing the stored record', () => {
    const saved = JSON.parse(JSON.stringify({ ...legacyService, auth: { type: 'subscription', provider: 'codex' } }));
    expect(withImageServiceAuth(saved, saved.auth).dialect).toBe('chatgpt_codex');
    expect(saved.dialect).toBe('openai_images');
  });

  it('drops the subscription endpoint when returning to an API key', () => {
    const subscription = withImageServiceAuth(legacyService, { type: 'subscription', provider: 'codex' });
    const result = withImageServiceAuth({ ...subscription, request_url: 'https://chatgpt.com/backend-api/codex/responses' }, { type: 'api_key' });
    expect(result.dialect).toBe('openai_images');
    expect(resolveImageEndpoint(result.base_url, result.request_url, result.dialect)).toBe('https://api.openai.com/v1/images/generations');
  });

  it('preserves custom API-key gateways and explicitly chosen subscription models', () => {
    expect(withImageServiceAuth(legacyService, { type: 'api_key' })).toEqual(legacyService);
    const auth = { type: 'subscription' as const, provider: 'codex' as const };
    const service = { ...withImageServiceAuth(legacyService, auth), model_name: 'account-model' };
    expect(withImageServiceAuth(service, auth).model_name).toBe('account-model');
  });
});
