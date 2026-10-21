import styles from './SubscriptionServiceGroup.module.scss';
import type { ManagedSubscriptionAccount } from './subscriptionServices';
import type { ReactNode } from 'react';
import { Button } from '@openbitfun/ui';
import { ConfigPageRow } from '@/infrastructure/config/components/common';

/** One product heading followed by independent account rows. */
export function SubscriptionServiceGroup({ title, description, action, busy, onAdd, children }: {
  title: string; description?: string; action?: string; busy: boolean; onAdd?: () => void; children: ReactNode;
}) {
  return <div className={styles.group} data-testid="settings-subscription-service" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionService">
    <ConfigPageRow label={title} description={description} className="openbitfun-model-settings__cli-account" align="center">
      {action && onAdd && <Button size="sm" variant="outline" disabled={busy} onClick={onAdd}>{action}</Button>}
    </ConfigPageRow>
    {children}
  </div>;
}

export function SubscriptionAccountList({ accounts, renderAccount }: {
  accounts: ManagedSubscriptionAccount[]; renderAccount: (account: ManagedSubscriptionAccount) => ReactNode;
}) {
  if (!accounts.length) return null;
  return <div className={styles.accounts} role="list" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionAccounts">
    {accounts.map(account => <div className={styles.account} role="listitem" key={account.accountId}
      data-account-id={account.accountId} data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionAccount">
      {renderAccount(account)}
    </div>)}
  </div>;
}
