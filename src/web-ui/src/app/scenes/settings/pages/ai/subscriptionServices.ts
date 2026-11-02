import type { SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';
import type { SubscriptionProvider } from '@/infrastructure/config/types';

export function isZcodeProvider(provider?: SubscriptionProvider): provider is 'zcode' | 'zcode_cn' {
  return provider === 'zcode' || provider === 'zcode_cn';
}

/**
 * Retired products no longer support subscription sign-in: the vendor stopped
 * allowing subscription-token access. Their persisted accounts stay listed so
 * users can see and remove them, but nothing offers login, refresh or import.
 */
export function isRetiredSubscriptionProvider(
  provider?: SubscriptionProvider,
): provider is 'workbuddy' | 'workbuddy_ai' {
  return provider === 'workbuddy' || provider === 'workbuddy_ai';
}

/** Presentation grouping only. Every account retains its wire provider and region. */
export function groupSubscriptionServices(accounts: SubscriptionAccount[]): SubscriptionAccount[][] {
  const groups = new Map<SubscriptionProvider, SubscriptionAccount[]>();
  for (const account of accounts) {
    const product = isZcodeProvider(account.provider) ? 'zcode' : account.provider;
    const group = groups.get(product) ?? [];
    group.push(account);
    groups.set(product, group);
  }
  return [...groups.values()];
}

export function preferredZcodeProvider(accounts: SubscriptionAccount[]): 'zcode' | 'zcode_cn' {
  const available = accounts.filter(account => isZcodeProvider(account.provider));
  return (available.find(account => account.connected) ?? available[0])?.provider === 'zcode_cn'
    ? 'zcode_cn'
    : 'zcode';
}

export function subscriptionManagerAccounts(
  accounts: SubscriptionAccount[],
  provider: SubscriptionProvider | undefined,
  identityLocked: boolean,
): SubscriptionAccount[] {
  if (!provider) return accounts;
  return accounts.filter(account => isZcodeProvider(provider) && !identityLocked
    ? isZcodeProvider(account.provider)
    : account.provider === provider);
}

export interface ManagedSubscriptionAccount {
  account: SubscriptionAccount;
  accountId: string;
  enabled: boolean;
  upstreamIdentity?: string | null;
}

/** The provider list is a catalog; credentials and actions belong to exact slots. */
export function managedSubscriptionAccounts(
  accounts: SubscriptionAccount[],
  instances: import('@/infrastructure/api/service-api/AIApi').SubscriptionAccountInstance[],
  pending?: { provider: SubscriptionProvider; accountId: string } | null,
): ManagedSubscriptionAccount[] {
  const result: ManagedSubscriptionAccount[] = [];
  for (const account of accounts) {
    const slots = instances.filter(instance => instance.account.provider === account.provider);
    if (slots.length) {
      for (const instance of slots) {
        if (instance.account.connected || instance.account.account || instance.upstream_account_id
          || instance.account.vault_unavailable || instance.account.reauthentication_required
          || instance.account_id === pending?.accountId) {
          result.push({ account: instance.account, accountId: instance.account_id, enabled: instance.enabled,
            upstreamIdentity: instance.upstream_account_id });
        }
      }
    } else if (account.connected || account.account || account.vault_unavailable || account.reauthentication_required) {
      result.push({ account, accountId: account.provider, enabled: true });
    }
    if (pending?.provider === account.provider && !result.some(item => item.accountId === pending.accountId)) {
      result.push({ account: { ...account, connected: false, account: null, expires_at: null }, accountId: pending.accountId, enabled: true });
    }
  }
  return result;
}

export function modelsUsingSubscriptionAccount<T extends { auth?: import('@/infrastructure/config/types').AuthConfig }>(
  models: T[], provider: SubscriptionProvider, accountId: string,
): T[] {
  return models.filter(model => model.auth && model.auth.type !== 'api_key' && model.auth.provider === provider && (
    model.auth.type === 'subscription_pool' ? model.auth.accounts.includes(accountId)
      : model.auth.type === 'subscription' && (model.auth.account_id || provider) === accountId
  ));
}
