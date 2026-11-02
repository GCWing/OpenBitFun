import styles from './SubscriptionServiceGroup.module.scss';
import { SubscriptionServiceGroup } from './SubscriptionServiceGroup';
import { useState, type ReactNode } from 'react';
import type { SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';
import type { SubscriptionProvider } from '@/infrastructure/config/types';
import { ConfigPageRow } from '@/infrastructure/config/components/common';
import { useI18n } from '@/infrastructure/i18n';
import { Button } from '@openbitfun/ui';

interface Props {
  accounts: SubscriptionAccount[];
  busy: boolean;
  accountCount?: number;
  canAddAccounts?: boolean;
  visibleProviders?: SubscriptionProvider[];
  activeProvider?: SubscriptionProvider;
  onLogin: (provider: SubscriptionProvider) => void;
  renderAccount: (account: SubscriptionAccount) => ReactNode;
}

/** A single product entry; region is chosen only when starting authorization. */
export function ZcodeSubscriptionGroup({ accounts, busy, accountCount = 0, canAddAccounts = true, visibleProviders = [], activeProvider, onLogin, renderAccount }: Props) {
  const { t } = useI18n('settings/models');
  const [choosingRegion, setChoosingRegion] = useState(false);
  return (
    <SubscriptionServiceGroup
      testId="settings-zcode-service"
      title={accountCount > 0 ? `ZCode · ${t('subscriptionAuth.accountsCount', { count: accountCount })}` : 'ZCode'}
      description={t('subscriptionAuth.details.zcode')}
      actions={(
        <Button size="sm" variant="outline" disabled={busy}
          aria-expanded={choosingRegion}
          onClick={() => setChoosingRegion(value => !value)}>
          {t(choosingRegion ? 'subscriptionAuth.cancel' : accountCount > 0 && canAddAccounts ? 'subscriptionAuth.pool.addAccount' : 'subscriptionAuth.login')}
        </Button>
      )}
    >
      {choosingRegion && (
        <div className={styles.regionChoice} data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionRegion">
          <ConfigPageRow label={t('subscriptionAuth.chooseRegion')}
            description={t('subscriptionAuth.chooseRegionHint')}
            className="openbitfun-model-settings__cli-account" align="center">
            <div className="openbitfun-model-settings__cli-actions">
              {accounts.map(account => (
                <Button key={account.provider} size="sm" variant="outline" disabled={busy}
                  onClick={() => {
                    setChoosingRegion(false);
                    onLogin(account.provider);
                  }}>
                  {t(account.provider === 'zcode_cn' ? 'subscriptionAuth.regions.bigmodel' : 'subscriptionAuth.regions.zai')}
                </Button>
              ))}
            </div>
          </ConfigPageRow>
        </div>
      )}
      {accounts.filter(account => account.connected || account.vault_unavailable
        || account.reauthentication_required || visibleProviders.includes(account.provider) || account.provider === activeProvider).map(renderAccount)}
    </SubscriptionServiceGroup>
  );
}
