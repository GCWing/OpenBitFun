import { describe, expect, it } from 'vitest';
import type { SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';
import { getSubscriptionAccountState } from './subscriptionAccountState';

const now = 1_800_000_000_000;
// Older hosts omit the optional vault and reauthentication flags.
const account: SubscriptionAccount = {
  provider: 'codex',
  display_label: 'Codex',
  connected: true,
  suggested_format: 'responses',
  suggested_base_url: 'https://example.com',
  suggested_model: '',
  api_offerings: [],
};

describe('subscription account state', () => {
  it('accepts legacy accounts without identity, expiry or credential flags', () => {
    expect(getSubscriptionAccountState(account, false, false, now)).toBe('connected');
  });

  it('does not present a stale connected account as a successful load', () => {
    expect(getSubscriptionAccountState(account, true, false, now)).toBe('loading');
    expect(getSubscriptionAccountState(account, false, true, now)).toBe('loadFailed');
    expect(getSubscriptionAccountState(account, true, true, now)).toBe('loading');
  });

  it('distinguishes an unsupported service from a signed-out account', () => {
    expect(getSubscriptionAccountState(undefined, false, false, now)).toBe('unavailable');
    expect(getSubscriptionAccountState({ ...account, connected: false }, false, false, now)).toBe('disconnected');
  });

  it('keeps a retryable vault failure separate from missing credentials', () => {
    expect(getSubscriptionAccountState({ ...account, vault_unavailable: true }, false, false, now)).toBe('vaultUnavailable');
    expect(getSubscriptionAccountState({ ...account, reauthentication_required: true }, false, false, now)).toBe('reauthenticationRequired');
    expect(getSubscriptionAccountState({
      ...account, vault_unavailable: true, reauthentication_required: true,
    }, false, false, now)).toBe('vaultUnavailable');
  });

  it('treats credential expiry in Unix seconds as a refresh request, not a lost login', () => {
    expect(getSubscriptionAccountState({ ...account, expires_at: now / 1000 + 1 }, false, false, now)).toBe('connected');
    expect(getSubscriptionAccountState({ ...account, expires_at: now / 1000 }, false, false, now)).toBe('refreshRequired');
    expect(getSubscriptionAccountState({ ...account, expires_at: now / 1000 - 1 }, false, false, now)).toBe('refreshRequired');
    expect(getSubscriptionAccountState({
      ...account, connected: false, expires_at: now / 1000 - 1,
    }, false, false, now)).toBe('disconnected');
  });
});
