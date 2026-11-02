import type { RemoteModelInfo, SubscriptionApiOffering } from '@/infrastructure/api/service-api/AIApi';

/** Zen accepts OpenCode's public key for anonymous free-model requests. */
export function openCodeApiKey(config: { api_key?: string; base_url?: string; auth?: { type: string } }) {
  return config.api_key?.trim() || (isOpenCodeZenApiKeyConfig(config) ? 'public' : '');
}

export function isOpenCodeZenApiKeyConfig(config: { base_url?: string; auth?: { type: string } }) {
  return (!config.auth || config.auth.type === 'api_key')
    && config.base_url?.replace(/\/+$/, '') === 'https://opencode.ai/zen/v1';
}

export function isOpenCodeZenOAuth(config: { auth?: { type: string; provider?: string; plan?: string }; base_url?: string }) {
  // Pools carry no plan; OpenCode Go uses an API key, so a pool is always Zen.
  return (config.auth?.type === 'subscription' || config.auth?.type === 'subscription_pool')
    && config.auth.provider === 'opencode'
    && config.auth.plan !== 'go' && config.base_url?.replace(/\/+$/, '') !== 'https://opencode.ai/zen/go/v1';
}

export function openCodeZenModels(offerings: SubscriptionApiOffering[]): RemoteModelInfo[] {
  return offerings.filter(item => item.plan === 'zen' && isConsoleInferenceBase(item.base_url))
    .flatMap(item => item.models.flatMap(model => {
      const suffix = ({ openai: 'chat/completions', responses: 'responses', anthropic: 'messages' })[item.format];
      if (!suffix) return [];
      return [{ id: model.id, display_name: model.display_name || undefined,
        routing: { format: item.format, base_url: item.base_url, request_url: `${item.base_url}/${suffix}` } }];
    }));
}

/** Display persisted routes only while the draft still refers to the same model and product. */
export function savedOpenCodeApiKeyRoute(
  draft: { id?: string; base_url?: string; auth?: { type: string; provider?: string; plan?: string } },
  model: string,
  saved?: { id?: string; model_name: string; base_url: string; provider: string; request_url?: string; auth?: { type: string; provider?: string; plan?: string } },
) {
  if (!saved || !draft.id || draft.id !== saved.id
    || model.trim() !== saved.model_name.trim()
    || draft.base_url?.replace(/\/+$/, '') !== saved.base_url.replace(/\/+$/, '')
    || !saved.request_url) return undefined;
  const routing = { format: saved.provider, base_url: saved.base_url, request_url: saved.request_url };
  if (isOpenCodeZenOAuth(draft) && isOpenCodeZenOAuth(saved)) {
    return resolveOpenCodeModelRoute(draft, model, [{ id: model.trim(), routing }]);
  }
  if (!isOpenCodeApiKeyConfig(draft) || !isOpenCodeApiKeyConfig(saved)) return undefined;
  return routing;
}

export function isOpenCodeApiKeyConfig(config: { auth?: { type: string }; base_url?: string }) {
  if (config.auth?.type && config.auth.type !== 'api_key') return false;
  const base = config.base_url?.replace(/\/+$/, '');
  return base === 'https://opencode.ai/zen/v1' || base === 'https://opencode.ai/zen/go/v1';
}

/** Only accept routes within the selected official product; manual IDs retain their route. */
export function resolveOpenCodeApiKeyRoute(
  config: { auth?: { type: string }; base_url?: string },
  model: string,
  models: RemoteModelInfo[],
) {
  if (!isOpenCodeApiKeyConfig(config)) return undefined;
  const base = config.base_url?.replace(/\/+$/, '');
  if (base !== 'https://opencode.ai/zen/v1' && base !== 'https://opencode.ai/zen/go/v1') return undefined;
  const route = models.find(item => item.id === model.trim())?.routing;
  if (!route || route.base_url !== base) return undefined;
  const suffix = ({ openai: '/chat/completions', responses: '/responses', anthropic: '/messages' } as Record<string, string>)[route.format];
  if (!suffix || route.request_url !== `${base}${suffix}`) return undefined;
  return route;
}

/** Console OAuth routes are account-owned; never reuse the public API-key resolver. */
function isConsoleInferenceBase(base: string) {
  try {
    const url = new URL(base);
    return url.protocol === 'https:' && url.hostname === 'opencode.ai'
      && (!url.port || url.port === '443') && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.startsWith('/inference/')
      && !base.includes('%') && !base.includes('\\')
      && !base.split('/').some(part => part === '.' || part === '..');
  } catch { return false; }
}

export function resolveOpenCodeModelRoute(
  config: { auth?: { type: string; provider?: string; plan?: string }; base_url?: string },
  model: string,
  models: RemoteModelInfo[],
) {
  if (!isOpenCodeZenOAuth(config)) return resolveOpenCodeApiKeyRoute(config, model, models);
  const route = models.find(item => item.id === model.trim())?.routing;
  if (!route || !isConsoleInferenceBase(route.base_url)) return undefined;
  const suffix = ({ openai: 'chat/completions', responses: 'responses', anthropic: 'messages' } as Record<string, string>)[route.format];
  return suffix && route.request_url === `${route.base_url}/${suffix}` ? route : undefined;
}
