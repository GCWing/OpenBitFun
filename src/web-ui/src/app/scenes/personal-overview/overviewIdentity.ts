import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity/AccountIdentityService';

/** Email accounts use a generated login internally; it is never a display name. */
export function getOverviewIdentity(identity: AccountIdentitySnapshot) {
  if (!identity.resolved || identity.status !== 'signed-in' || !identity.me) return null;
  const email = identity.me.email?.trim();
  const login = identity.me.user.login.trim();
  const displayLogin = /^user-[0-9a-f]{32}$/i.test(login) ? '' : login;
  const name = email || displayLogin;
  return name ? { name, handle: displayLogin ? `@${displayLogin}` : null } : null;
}
