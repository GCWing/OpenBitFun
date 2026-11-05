import { describe, expect, it } from 'vitest';
import type { SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';
import { groupSubscriptionServices, isRetiredSubscriptionProvider, preferredZcodeProvider, subscriptionManagerAccounts } from './subscriptionServices';

const account = (provider: SubscriptionAccount['provider'], connected = false): SubscriptionAccount => ({
  provider, connected, display_label: provider, suggested_format: 'anthropic',
  suggested_base_url: 'https://example.invalid', suggested_model: '', api_offerings: [],
});

describe('subscription service presentation', () => {
  it('groups ZCode regions without merging accounts', () => {
    const accounts = [account('hermes'), account('zcode'), account('codex'), account('zcode_cn', true)];
    const groups = groupSubscriptionServices(accounts);
    expect(groups.map(group => group.map(a => a.provider))).toEqual([
      ['hermes'], ['zcode', 'zcode_cn'], ['codex'],
    ]);
    expect(groups[1][0]).toBe(accounts[1]);
    expect(groups[1][1]).toBe(accounts[3]);
    expect(preferredZcodeProvider(accounts)).toBe('zcode_cn');
  });

  it('never offers sign-in for the retired WorkBuddy products', () => {
    for (const provider of ['workbuddy', 'workbuddy_ai'] as const) {
      expect(isRetiredSubscriptionProvider(provider)).toBe(true);
    }
    for (const provider of ['codex', 'grok', 'hermes', 'zcode', 'zcode_cn', 'opencode', 'antigravity'] as const) {
      expect(isRetiredSubscriptionProvider(provider)).toBe(false);
    }
    // A retained account still groups on its own so it stays visible for removal.
    expect(groupSubscriptionServices([account('workbuddy_ai')])).toEqual([[account('workbuddy_ai')]]);
  });

  it('keeps an existing model bound to its region while a new draft may choose either', () => {
    const accounts = [account('zcode', true), account('zcode_cn', true), account('codex')];
    expect(subscriptionManagerAccounts(accounts, 'zcode_cn', true)).toEqual([accounts[1]]);
    expect(subscriptionManagerAccounts(accounts, 'zcode', false)).toEqual(accounts.slice(0, 2));
    expect(subscriptionManagerAccounts(accounts, 'codex', false)).toEqual([accounts[2]]);
    expect(subscriptionManagerAccounts(accounts, undefined, true)).toBe(accounts);
  });

  it('offers only the regional providers advertised by an older host', () => {
    const cnOnly = [account('zcode_cn')];
    expect(preferredZcodeProvider(cnOnly)).toBe('zcode_cn');
    expect(groupSubscriptionServices(cnOnly)).toEqual([cnOnly]);
    expect(groupSubscriptionServices([account('codex')])).toEqual([[account('codex')]]);
  });
});

import {
  countSubscriptionServices,
  managedSubscriptionAccounts,
  modelsUsingSubscriptionAccount,
  subscriptionAccountBadge,
  subscriptionAccountLabel,
  subscriptionProductOf,
} from './subscriptionServices';

it('shows independent named slots even when the default is signed out and the emails match', () => {
  const defaults = [account('codex'), account('zcode_cn')];
  const instances = ['slot-a', 'slot-b'].map(account_id => ({ account_id, enabled: account_id !== 'slot-b', is_default: false,
    account: { ...account('codex', true), account: 'same@example.invalid' } }));
  const managed = managedSubscriptionAccounts(defaults, instances);
  expect(managed.map(item => item.accountId)).toEqual(['slot-a', 'slot-b']);
  expect(managed.map(item => item.enabled)).toEqual([true, false]);
  const pending = managedSubscriptionAccounts(defaults, instances, { provider: 'zcode_cn', accountId: 'new-cn-slot' });
  expect(pending.at(-1)?.accountId).toBe('new-cn-slot');
  expect(pending.at(-1)?.account.connected).toBe(false);
  expect(managedSubscriptionAccounts([{ ...account('codex', true), account: 'legacy' }], [])[0].accountId).toBe('codex');
});

it('keeps logged-out identities visible for reauthentication without resurrecting an unused default', () => {
  const defaults = [account('codex')];
  const instances = [{ account_id: 'codex', enabled: true, is_default: true, account: defaults[0] },
    { account_id: 'signed-out', enabled: true, is_default: false, upstream_account_id: 'retained-identity', account: account('codex') }];
  expect(managedSubscriptionAccounts(defaults, instances).map(item => item.accountId)).toEqual(['signed-out']);
});

it('logout impacts only the selected slot and pools which explicitly include it', () => {
  const models: import('@/infrastructure/config/types').AIModelConfig[] = [
    { ...account('codex'), id: 'default', auth: { type: 'subscription', provider: 'codex' } },
    { ...account('codex'), id: 'one', auth: { type: 'subscription', provider: 'codex', account_id: 'slot-a' } },
    { ...account('codex'), id: 'two', auth: { type: 'subscription', provider: 'codex', account_id: 'slot-b' } },
    { ...account('codex'), id: 'pool', auth: { type: 'subscription_pool', provider: 'codex', accounts: ['slot-b', 'slot-a'] } },
  ] as unknown as import('@/infrastructure/config/types').AIModelConfig[];
  expect(modelsUsingSubscriptionAccount(models, 'codex', 'slot-a').map(model => model.id)).toEqual(['one', 'pool']);
  expect(modelsUsingSubscriptionAccount(models, 'codex', 'codex').map(model => model.id)).toEqual(['default']);
});

import {
  countSubscriptionServices,
  subscriptionAccountBadge,
  subscriptionAccountLabel,
  subscriptionLoginPlaceholder,
  subscriptionProductOf,
  subscriptionRemovalKeys,
} from './subscriptionServices';

const zcodeAccount = (overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount => ({
  ...account('zcode', true),
  account: 'lppdgqoa@example.invalid',
  ...overrides,
});

describe('subscription service counting and labels', () => {
  it('counts both ZCode regions and every extra slot as one product', () => {
    expect(subscriptionProductOf('zcode_cn')).toBe('zcode');
    expect(subscriptionProductOf('codex')).toBe('codex');
    expect(countSubscriptionServices(['zcode', 'zcode_cn'])).toBe(1);
    expect(countSubscriptionServices(['zcode', 'zcode_cn', 'codex'])).toBe(2);
    expect(countSubscriptionServices([])).toBe(0);
  });

  it('states why a slot cannot serve requests in the manager order', () => {
    expect(subscriptionAccountBadge(zcodeAccount({ connected: false }), true)).toBe('notSignedIn');
    expect(subscriptionAccountBadge(zcodeAccount({ connected: false, reauthentication_required: true }), true)).toBe('reauthenticationRequired');
    expect(subscriptionAccountBadge(zcodeAccount({ connected: false, vault_unavailable: true }), true)).toBe('vaultUnavailable');
    expect(subscriptionAccountBadge(zcodeAccount(), false)).toBe('disabled');
    expect(subscriptionAccountBadge(zcodeAccount())).toBeNull();
  });

  it('separates a signed-in account from a signed-out slot of the same identity', () => {
    const signedIn = zcodeAccount();
    const signedOut = zcodeAccount({ connected: false });
    const text = { region: 'Z.ai', identity: 'lppdgqoa@example.invalid', marker: '账号 · 3f2a1b9c', state: '未登录' };
    expect(subscriptionAccountLabel(signedIn, 'zcode', { ...text, state: undefined }))
      .toBe('Z.ai · lppdgqoa@example.invalid');
    expect(subscriptionAccountLabel(signedOut, 'zcode-account-3f2a1b9c-0000-4000-8000-000000000000', text))
      .toBe('Z.ai · lppdgqoa@example.invalid · 账号 · 3f2a1b9c · 未登录');
    // Another product keeps its product name and gains neither region nor state.
    expect(subscriptionAccountLabel(account('codex', true), 'codex', {
      region: 'Z.ai', identity: 'shared@example.invalid', marker: 'marker', state: undefined,
    })).toBe('shared@example.invalid');
  });

  it('keeps a login placeholder only while that authorization can still finish', () => {
    const slot = 'zcode-account-3f2a1b9c-0000-4000-8000-000000000000';
    expect(subscriptionLoginPlaceholder({ provider: 'zcode', status: 'pending' }, slot))
      .toEqual({ provider: 'zcode', accountId: slot });
    expect(subscriptionLoginPlaceholder({ provider: 'zcode', status: 'cancelling' }, slot))
      .toEqual({ provider: 'zcode', accountId: slot });
    // A failed attempt must not leave a "not signed in" twin of the real account.
    expect(subscriptionLoginPlaceholder({ provider: 'zcode', status: 'failed' }, slot)).toBeNull();
    expect(subscriptionLoginPlaceholder(null, slot)).toBeNull();
    expect(subscriptionLoginPlaceholder({ provider: 'codex', status: 'pending' }, null))
      .toEqual({ provider: 'codex', accountId: 'codex' });
  });

  it('confirms removal with copy that matches what the click will do', () => {
    // A signed-in slot keeps its identity, so the copy must not claim removal.
    expect(subscriptionRemovalKeys(false).title).toBe('subscriptionAuth.logoutConfirmTitle');
    expect(subscriptionRemovalKeys(false).confirm).toBe('subscriptionAuth.confirmLogout');
    // A slot that already lost its credential is forgotten: that is the only
    // way to clear a leftover row, and the copy has to say so.
    expect(subscriptionRemovalKeys(true).title).toBe('subscriptionAuth.forgetConfirmTitle');
    expect(subscriptionRemovalKeys(true).consequence).toBe('subscriptionAuth.forgetConsequence');
    expect(subscriptionRemovalKeys(true).confirm).toBe('subscriptionAuth.confirmForget');
    expect(subscriptionRemovalKeys(true).success).toBe('subscriptionAuth.forgetSuccess');
  });
});
