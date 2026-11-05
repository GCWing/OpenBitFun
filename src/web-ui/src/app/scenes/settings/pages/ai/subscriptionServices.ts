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

/** Both ZCode regions are one product, so a service count must not double it. */
export function subscriptionProductOf(provider: SubscriptionProvider): SubscriptionProvider {
  return isZcodeProvider(provider) ? 'zcode' : provider;
}

/**
 * Distinct products behind the configured subscription models. Counting model
 * provider groups instead would report two services for one ZCode account.
 */
export function countSubscriptionServices(providers: readonly SubscriptionProvider[]): number {
  return new Set(providers.map(subscriptionProductOf)).size;
}

/** Why a slot cannot serve requests, in the order the account manager shows it. */
export type SubscriptionAccountBadge =
  | 'disabled'
  | 'vaultUnavailable'
  | 'reauthenticationRequired'
  | 'notSignedIn';

/** `null` means the slot is signed in and enabled; callers add no state suffix. */
export function subscriptionAccountBadge(
  account: SubscriptionAccount,
  enabled = true,
): SubscriptionAccountBadge | null {
  if (!enabled) return 'disabled';
  if (account.vault_unavailable) return 'vaultUnavailable';
  if (account.reauthentication_required) return 'reauthenticationRequired';
  if (!account.connected) return 'notSignedIn';
  return null;
}

export interface SubscriptionAccountLabelText {
  /** Translated ZCode region; ignored for other products. */
  region?: string;
  /** Account identity, or the translated "identity unavailable" fallback. */
  identity: string;
  /** Translated slot marker for a named slot that is not the default slot. */
  marker?: string;
  /** Translated connection state, absent for a connected and enabled slot. */
  state?: string;
}

/**
 * One slot as it appears next to a product name. Two slots of the same product
 * can hold the same account identity, so region, slot marker and connection
 * state must all be visible; otherwise they read as an exact duplicate.
 */
export function subscriptionAccountLabel(
  account: SubscriptionAccount,
  accountId: string,
  text: SubscriptionAccountLabelText,
): string {
  const parts: string[] = [];
  if (isZcodeProvider(account.provider) && text.region) parts.push(text.region);
  if (text.identity) parts.push(text.identity);
  if (accountId !== account.provider && text.marker) parts.push(text.marker);
  if (text.state) parts.push(text.state);
  return parts.join(' · ');
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

/**
 * Placeholder slot shown while an authorization is in flight, so a new account
 * is visible before the host stores it. A failed attempt keeps no placeholder:
 * the retry panel still targets the same slot, but the stale "not signed in"
 * row would otherwise sit next to the account that is signed in.
 */
export function subscriptionLoginPlaceholder(
  panel: { provider: SubscriptionProvider; status: 'starting' | 'pending' | 'cancelling' | 'failed' } | null,
  accountId: string | null,
): { provider: SubscriptionProvider; accountId: string } | null {
  if (!panel || panel.status === 'failed') return null;
  return { provider: panel.provider, accountId: accountId || panel.provider };
}

/**
 * Copy for the removal confirmation. Signing out a slot that still holds a
 * credential keeps its identity; a slot that already lost its credential is
 * forgotten, so the confirmation has to say which of the two will happen.
 */
export function subscriptionRemovalKeys(forgetting: boolean) {
  return forgetting
    ? {
      title: 'subscriptionAuth.forgetConfirmTitle',
      consequence: 'subscriptionAuth.forgetConsequence',
      confirm: 'subscriptionAuth.confirmForget',
      success: 'subscriptionAuth.forgetSuccess',
    } as const
    : {
      title: 'subscriptionAuth.logoutConfirmTitle',
      consequence: 'subscriptionAuth.logoutConsequence',
      confirm: 'subscriptionAuth.confirmLogout',
      success: 'subscriptionAuth.logoutSuccess',
    } as const;
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
