import styles from './SubscriptionServiceGroup.module.scss';
import type { ManagedSubscriptionAccount } from './subscriptionServices';
import type { ReactNode } from 'react';
import { CardHeader } from '@openbitfun/ui';

/** One product heading followed by independent account rows. */
export function SubscriptionServiceGroup({ title, description, actions, children, testId = 'settings-subscription-service' }: {
  title: string; description?: string; actions?: ReactNode; children: ReactNode; testId?: string;
}) {
  return <div className={styles.group} data-testid={testId} data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionService">
    <CardHeader
      className={styles.header}
      align="center"
      padding="md"
      title={<h3 className={styles.title}>{title}</h3>}
      description={description}
      actions={actions}
    />
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
