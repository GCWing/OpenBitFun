import { useId, useState, type ReactNode } from 'react';
import { SegmentedControl } from '@openbitfun/ui';
import type { SubscriptionProvider } from '@/infrastructure/config/types';
import { useI18n } from '@/infrastructure/i18n';
import styles from './SubscriptionProviderBrowser.module.scss';

export function SubscriptionProviderBrowser({ providers, disabled, children }: {
  providers: { value: SubscriptionProvider; label: string; icon?: ReactNode }[];
  disabled?: boolean;
  children: (provider: SubscriptionProvider | 'all') => ReactNode;
}) {
  const { t } = useI18n('settings/models');
  const listId = useId();
  const [selected, setSelected] = useState<SubscriptionProvider | 'all'>('all');
  const filter = providers.some(provider => provider.value === selected) ? selected : 'all';
  return <div className={styles.browser} data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionBrowser">
    <SegmentedControl variant="pills" tone="neutral" size="sm" className={styles.filters} disabled={disabled}
      aria-label={t('pool.providerFilter')} aria-controls={listId}
      value={filter} onValueChange={value => setSelected(value as SubscriptionProvider | 'all')}
      options={[{ value: 'all', label: t('pool.allProviders') }, ...providers]} />
    <div id={listId}>{children(filter)}</div>
  </div>;
}
