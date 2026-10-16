import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { AccountIdentityControls } from '@/features/market-account/AccountIdentityControls';

export function OverviewAccountButton({ identity }: { identity: AccountIdentitySnapshot }) {
  if (!identity.resolved || identity.status !== 'signed-in' || !identity.me) return null;
  return <AccountIdentityControls showSignIn={false} />;
}
