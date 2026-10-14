import { Button, Icon } from '@openbitfun/ui';
import { LogIn, LogOut } from 'lucide-react';
import { useState } from 'react';
import {
  AccountIdentityError,
  accountIdentityService,
  type AccountIdentitySnapshot,
} from '@/infrastructure/account-identity';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useNotification } from '@/shared/notification-system';

export function OverviewAccountButton({ identity }: { identity: AccountIdentitySnapshot }) {
  const { t } = useI18n('scenes/personal-overview');
  const notification = useNotification();
  const [signingOut, setSigningOut] = useState(false);
  const signedIn = identity.status === 'signed-in';

  const signIn = async () => {
    try {
      if (accountIdentityService.getSnapshot().status === 'authorizing') {
        await accountIdentityService.reopenSignIn();
      } else {
        await accountIdentityService.signIn();
      }
    } catch (error) {
      if (error instanceof AccountIdentityError && error.code === 'cancelled') return;
      notification.error(error instanceof AccountIdentityError && error.code === 'expired'
        ? t('account.expired')
        : t('account.failed'));
    }
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await accountIdentityService.logout();
    } catch {
      notification.error(t('account.signOutFailed'));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Button
      className="personal-overview__account-button"
      variant="text"
      size="sm"
      leadingIcon={<Icon glyph={signedIn ? LogOut : LogIn} size="sm" />}
      disabled={!identity.resolved || identity.status === 'loading'}
      loading={signingOut}
      onClick={() => { if (signedIn) void signOut(); else void signIn(); }}
    >
      {signedIn ? t('account.signOut') : identity.status === 'authorizing' ? t('account.continue') : t('account.signIn')}
    </Button>
  );
}
