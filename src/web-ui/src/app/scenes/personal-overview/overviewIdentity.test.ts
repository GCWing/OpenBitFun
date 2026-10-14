import { describe, expect, it } from 'vitest';
import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity/AccountIdentityService';
import { getOverviewIdentity } from './overviewIdentity';

const internalLogin = 'user-6ad742378dc144debcbe1d32ef06314f';
const identity: AccountIdentitySnapshot = {
  resolved: true,
  status: 'signed-in',
  me: { user: { githubId: 0, login: internalLogin, avatarUrl: '' }, isAdmin: false },
};

describe('personal overview identity', () => {
  it('shows the verified email instead of an email account’s generated login', () => {
    expect(getOverviewIdentity({ ...identity, me: { ...identity.me!, email: 'cwing@example.com' } }))
      .toEqual({ name: 'cwing@example.com', handle: null });
  });

  it('hides the generated login when older metadata does not provide the email', () => {
    expect(getOverviewIdentity(identity)).toBeNull();
  });

  it.each(['signed-out', 'loading', 'authorizing'] as const)('hides even cached account metadata while %s', status => {
    expect(getOverviewIdentity({ ...identity, status, me: { ...identity.me!, email: 'cwing@example.com' } })).toBeNull();
  });

  it('keeps legacy GitHub names working without optional email metadata', () => {
    expect(getOverviewIdentity({ ...identity, me: { user: { githubId: 42, login: 'GCWing', avatarUrl: '' }, isAdmin: false } }))
      .toEqual({ name: 'GCWing', handle: '@GCWing' });
  });

  it('does not hide normal usernames that share the user prefix', () => {
    expect(getOverviewIdentity({ ...identity, me: { ...identity.me!, user: { ...identity.me!.user, login: 'user-friendly' } } })?.name)
      .toBe('user-friendly');
  });
});
