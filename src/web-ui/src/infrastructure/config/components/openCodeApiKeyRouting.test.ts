import { describe, expect, it } from 'vitest';
import { openCodeApiKey, resolveOpenCodeModelRoute, isOpenCodeZenOAuth, openCodeZenModels, resolveOpenCodeApiKeyRoute, savedOpenCodeApiKeyRoute } from './openCodeApiKeyRouting';

describe('OpenCode API-key model routes', () => {
  it('keeps Console OAuth and account offerings within Zen', () => {
    const zen = { base_url: 'https://opencode.ai/zen/v1', auth: { type: 'subscription', provider: 'opencode' } };
    expect(isOpenCodeZenOAuth(zen)).toBe(true);
    expect(isOpenCodeZenOAuth({ ...zen, auth: { ...zen.auth, plan: 'go' } })).toBe(false);
    expect(isOpenCodeZenOAuth({ ...zen, base_url: 'https://opencode.ai/zen/go/v1' })).toBe(false);
    const models = openCodeZenModels([
      { plan: 'zen', format: 'responses', base_url: 'https://opencode.ai/inference/openai/v1', suggested_model: 'zen-model', models: [{ id: 'zen-model' }] },
      { plan: 'go', format: 'anthropic', base_url: 'https://opencode.ai/zen/go/v1', suggested_model: 'go-model', models: [{ id: 'go-model' }] },
    ]);
    expect(models.map(model => model.id)).toEqual(['zen-model']);
    expect(models[0].routing?.request_url).toBe('https://opencode.ai/inference/openai/v1/responses');
  });
  it('resolves Console model overrides independently of the saved public URL', () => {
    const config = { base_url: 'https://opencode.ai/zen/v1', auth: { type: 'subscription', provider: 'opencode' } };
    for (const [format, namespace, suffix] of [['openai', 'openai', 'chat/completions'], ['responses', 'openai', 'responses'], ['anthropic', 'anthropic', 'messages']]) {
      const base = `https://opencode.ai/inference/${namespace}/v1`;
      const routing = { format, base_url: base, request_url: `${base}/${suffix}` };
      expect(resolveOpenCodeModelRoute(config, 'model', [{ id: 'model', routing }])).toEqual(routing);
      expect(resolveOpenCodeModelRoute({ ...config, base_url: base }, 'model', [{ id: 'model', routing }])).toEqual(routing);
      for (const bad of ['https://evil.invalid/inference/openai/v1', 'https://opencode.ai/zen/go/v1', 'https://opencode.ai/zen/v1']) {
        expect(resolveOpenCodeModelRoute(config, 'model', [{ id: 'model', routing: { ...routing, base_url: bad, request_url: `${bad}/${suffix}` } }])).toBeUndefined();
      }
    }
  });
  it('displays a saved Console route before refreshing models', () => {
    const model = { id: 'saved-console', model_name: 'big-pickle', provider: 'openai',
      base_url: 'https://opencode.ai/inference/openai/v1',
      request_url: 'https://opencode.ai/inference/openai/v1/chat/completions',
      auth: { type: 'subscription', provider: 'opencode' } };
    expect(savedOpenCodeApiKeyRoute(model, 'big-pickle', model)?.request_url).toBe(model.request_url);
    expect(savedOpenCodeApiKeyRoute(model, 'other-model', model)).toBeUndefined();
    expect(savedOpenCodeApiKeyRoute({ ...model, auth: { ...model.auth, type: 'api_key' } }, 'big-pickle', model)).toBeUndefined();
  });
  const saved = { id: 'config-1', model_name: 'model', base_url: 'https://opencode.ai/zen/go/v1', provider: 'responses', request_url: 'https://opencode.ai/zen/go/v1/responses' };
  it('shows the saved route without fetching a catalog', () => {
    expect(savedOpenCodeApiKeyRoute(saved, 'model', saved)).toEqual({
      format: saved.provider, base_url: saved.base_url, request_url: saved.request_url,
    });
  });
  it('does not reuse saved routes after changing model, product, identity, or auth', () => {
    expect(savedOpenCodeApiKeyRoute(saved, 'different-model', saved)).toBeUndefined();
    expect(savedOpenCodeApiKeyRoute({ ...saved, base_url: 'https://opencode.ai/zen/v1' }, 'model', saved)).toBeUndefined();
    expect(savedOpenCodeApiKeyRoute({ ...saved, id: undefined }, 'model', saved)).toBeUndefined();
    expect(savedOpenCodeApiKeyRoute({ ...saved, auth: { type: 'subscription' } }, 'model', saved)).toBeUndefined();
  });
  for (const base of ['https://opencode.ai/zen/v1', 'https://opencode.ai/zen/go/v1']) {
    it(`selects each wire independently for ${base}`, () => {
      for (const [format, suffix] of [['openai', 'chat/completions'], ['responses', 'responses'], ['anthropic', 'messages']]) {
        const routing = { format, base_url: base, request_url: `${base}/${suffix}` };
        expect(resolveOpenCodeApiKeyRoute({ base_url: base }, 'model', [{ id: 'model', routing }])).toEqual(routing);
      }
    });
  }
  it('preserves manual routes and rejects foreign or cross-plan routes', () => {
    const config = { base_url: 'https://opencode.ai/zen/go/v1' };
    const routing = { format: 'openai', base_url: 'https://opencode.ai/zen/v1', request_url: 'https://opencode.ai/zen/v1/chat/completions' };
    expect(resolveOpenCodeApiKeyRoute(config, 'manual', [{ id: 'known', routing }])).toBeUndefined();
    expect(resolveOpenCodeApiKeyRoute(config, 'known', [{ id: 'known', routing }])).toBeUndefined();
    expect(resolveOpenCodeApiKeyRoute({ base_url: routing.base_url, auth: { type: 'subscription' } }, 'known', [{ id: 'known', routing }])).toBeUndefined();
    expect(resolveOpenCodeApiKeyRoute({ base_url: routing.base_url }, 'known', [{ id: 'known', routing: { ...routing, request_url: 'https://evil.invalid' } }])).toBeUndefined();
  });
});

describe('OpenCode anonymous API key', () => {
  it('allows anonymous Zen discovery and preserves explicit keys and auth modes', () => {
    const zen = { base_url: 'https://opencode.ai/zen/v1/' };
    expect(openCodeApiKey(zen)).toBe('public');
    expect(openCodeApiKey({ ...zen, api_key: ' user-key ' })).toBe('user-key');
    expect(openCodeApiKey({ ...zen, auth: { type: 'subscription' } })).toBe('');
    expect(openCodeApiKey({ ...zen, auth: { type: 'subscription_pool' } })).toBe('');
    for (const base_url of ['https://opencode.ai/zen/go/v1', 'https://opencode.ai.evil.test/zen/v1', 'http://opencode.ai/zen/v1', 'https://proxy.test/v1']) {
      expect(openCodeApiKey({ base_url })).toBe('');
    }
  });
});
