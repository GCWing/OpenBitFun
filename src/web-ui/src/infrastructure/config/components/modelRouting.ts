import type {
  AIModelConfig,
  AuthConfig,
  ModelChannelRouting,
  SubscriptionProvider,
} from '../types';

/** Provider whose accounts sign this model's requests, if any. */
export function subscriptionProviderOf(auth?: AuthConfig): SubscriptionProvider | undefined {
  return auth?.type === 'subscription' || auth?.type === 'subscription_pool'
    ? auth.provider
    : undefined;
}

/** Ordered account slots this auth selects; the bare key is the default slot. */
export function selectedAccountIds(auth?: AuthConfig): string[] {
  if (auth?.type === 'subscription_pool') return auth.accounts;
  if (auth?.type === 'subscription') return [auth.account_id || auth.provider];
  return [];
}

/**
 * One account keeps the plain subscription shape older hosts understand; the
 * default slot stays implicit. Several accounts become an ordered pool that
 * carries the revision read from the host, which rejects stale edits.
 */
export function authForAccounts(
  provider: SubscriptionProvider,
  accounts: string[],
  previous?: AuthConfig,
): AuthConfig {
  if (accounts.length > 1) {
    return {
      type: 'subscription_pool',
      provider,
      accounts,
      revision: previous?.type === 'subscription_pool' ? previous.revision : 0,
    };
  }
  const plan = previous?.type === 'subscription' ? previous.plan : undefined;
  const accountId = accounts[0];
  return {
    type: 'subscription',
    provider,
    ...(plan ? { plan } : {}),
    ...(accountId && accountId !== provider ? { account_id: accountId } : {}),
  };
}

export function newAccountSlotId(provider: SubscriptionProvider): string {
  return `${provider}-account-${crypto.randomUUID()}`;
}

// Mirrors config-contracts' output-cap resolution, including legacy invalid
// caps falling back to automatic tiers. The shared safety reserve cancels out.
function channelInputCapacity(model: Pick<AIModelConfig, 'context_window' | 'max_tokens'>): number {
  const context = model.context_window ?? 128_128;
  const configured = model.max_tokens;
  const quarter = Math.floor(context / 4);
  const output = configured && configured > 0 && configured * 100 <= context * 40
    ? configured
    : [64_000, 32_000, 24_000, 16_000, 8_000].find(tier => tier <= quarter) ?? quarter;
  return Math.max(0, context - output);
}

/**
 * Mirrors the host's route validation: a backup must generate text, carry no
 * route of its own, and keep the primary's context window and capabilities.
 */
export function isEligibleBackup(
  primary: Pick<AIModelConfig, 'id' | 'context_window' | 'max_tokens' | 'capabilities'>,
  candidate: AIModelConfig,
): boolean {
  if (!candidate.id || candidate.id === primary.id) return false;
  if (candidate.category === 'speech_recognition') return false;
  if ((candidate.channel_routing?.fallback_model_ids.length ?? 0) > 0) return false;
  if ((candidate.context_window ?? 128_128) < (primary.context_window ?? 128_128)) return false;
  if (channelInputCapacity(candidate) < channelInputCapacity(primary)) return false;
  return (primary.capabilities ?? []).every(capability => candidate.capabilities.includes(capability));
}

/** Empty routes are stored as absent so older hosts see an unchanged model. */
export function normalizeChannelRouting(
  routing?: ModelChannelRouting,
): ModelChannelRouting | undefined {
  if (!routing || routing.fallback_model_ids.length === 0) return undefined;
  const manual = routing.manual_channel;
  return {
    version: routing.version || 1,
    fallback_model_ids: routing.fallback_model_ids,
    ...(manual ? { manual_channel: manual } : {}),
  };
}

/**
 * Removing a model must also remove it from every route that named it, or
 * the host rejects the whole `ai.models` write.
 */
export function pruneChannelReferences(
  models: AIModelConfig[],
  removedIds: ReadonlySet<string>,
): AIModelConfig[] {
  if (removedIds.size === 0) return models;
  return models.map(model => {
    const routing = model.channel_routing;
    if (!routing) return model;
    const fallback = routing.fallback_model_ids.filter(id => !removedIds.has(id));
    const manual = routing.manual_channel && removedIds.has(routing.manual_channel)
      ? undefined
      : routing.manual_channel;
    if (fallback.length === routing.fallback_model_ids.length && manual === routing.manual_channel) {
      return model;
    }
    const next = { ...model };
    const normalized = normalizeChannelRouting({ ...routing, fallback_model_ids: fallback, manual_channel: manual });
    if (normalized) next.channel_routing = normalized;
    else delete next.channel_routing;
    return next;
  });
}

export function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
