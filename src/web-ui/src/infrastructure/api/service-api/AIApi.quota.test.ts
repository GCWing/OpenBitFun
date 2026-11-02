import { beforeEach, expect, it, vi } from 'vitest';
import { AIApi } from './AIApi';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));
beforeEach(() => { invoke.mockReset(); });
it('uses the typed host command with the exact account slot and force flag', async () => {
  const value = { provider: 'zcode_cn', account_id: 'zcode_cn-account-fixture', state: 'known', windows: [] };
  invoke.mockResolvedValue(value);
  await expect(new AIApi().getSubscriptionAccountQuota('zcode_cn', value.account_id, true)).resolves.toBe(value);
  expect(invoke).toHaveBeenCalledWith('get_subscription_account_quota', {
    request: { provider: 'zcode_cn', accountId: value.account_id, forceRefresh: true },
  });
});
it('keeps old hosts on the provider-default slot and surfaces transport failures', async () => {
  invoke.mockRejectedValue(new Error('not_available: quota'));
  await expect(new AIApi().getSubscriptionAccountQuota('codex')).rejects.toThrow('not_available: quota');
  expect(invoke).toHaveBeenCalledWith('get_subscription_account_quota', {
    request: { provider: 'codex', accountId: 'codex', forceRefresh: false },
  });
});

it('queries a saved model on its owner host without transmitting a draft key', async () => {
  invoke.mockResolvedValue({ state: 'known' });
  await new AIApi().getModelProviderQuota('go-model');
  expect(invoke).toHaveBeenCalledWith('get_subscription_account_quota', {
    request: { provider: 'opencode', accountId: 'model:go-model', modelId: 'go-model' },
  });
});

it('refreshes and signs out the named account without touching its provider default', async () => {
  invoke.mockResolvedValue({});
  const api = new AIApi();
  await api.refreshSubscriptionAccountInstance('codex', 'slot-b');
  await api.logoutSubscriptionAccountInstance('codex', 'slot-b');
  expect(invoke.mock.calls).toEqual([
    ['refresh_subscription_account_instance', { request: { provider: 'codex', accountId: 'slot-b' } }],
    ['logout_subscription_account_instance', { request: { provider: 'codex', accountId: 'slot-b' } }],
  ]);
});

it('discovers the selected Console account catalog instead of the provider default', async () => {
  const account = { provider: 'opencode', connected: true };
  invoke.mockResolvedValue({ account });
  await expect(new AIApi().refreshSubscriptionAccountForSlot('opencode', 'slot-c')).resolves.toBe(account);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('refresh_subscription_account_instance', {
    request: { provider: 'opencode', accountId: 'slot-c' },
  });
});
