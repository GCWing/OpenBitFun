import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Capsule, Card, CardBody, CardFooter, OverflowText, Select, Spinner } from '@openbitfun/ui';
import type { SubscriptionProvider } from '@/infrastructure/config/types';
import { useI18n } from '@/infrastructure/i18n';
import { ProductBrandIcon } from '@/shared/ui/ProductBrandIcon';
import styles from './SubscriptionProviderPicker.module.scss';

interface ProviderOption {
  provider: SubscriptionProvider;
  title: string;
  description: string;
  regions?: { provider: SubscriptionProvider; label: string; shortLabel: string }[];
}

/** Each provider card starts authorization directly, without listing accounts. */
export function SubscriptionProviderPicker({ options, disabled, loginStatus, onLogin, onCancel, onBack, renderAuthorization }: {
  options: ProviderOption[];
  disabled: boolean;
  loginStatus?: { provider: SubscriptionProvider; status: 'starting' | 'pending' | 'cancelling' | 'failed' } | null;
  onLogin: (provider: SubscriptionProvider) => void;
  onCancel: (provider: SubscriptionProvider) => void;
  onBack: () => void;
  renderAuthorization: (provider: SubscriptionProvider) => ReactNode;
}) {
  const { t } = useI18n('settings/models');
  const [regions, setRegions] = useState<Partial<Record<SubscriptionProvider, SubscriptionProvider>>>({});
  const trackingRef = useRef<HTMLDivElement>(null);
  const loginButtons = useRef(new Map<SubscriptionProvider, HTMLButtonElement>());
  const lastProvider = useRef<SubscriptionProvider | null>(null);
  const activeOption = options.find(option => option.provider === loginStatus?.provider
    || option.regions?.some(region => region.provider === loginStatus?.provider));
  const activeProvider = loginStatus?.provider;

  useEffect(() => {
    if (activeProvider) trackingRef.current?.focus();
    else if (lastProvider.current) loginButtons.current.get(lastProvider.current)?.focus();
  }, [activeProvider]);

  if (loginStatus) {
    const region = activeOption?.regions?.find(item => item.provider === loginStatus.provider);
    const failed = loginStatus.status === 'failed';
    return <div className={styles.tracking} ref={trackingRef} tabIndex={-1}
      role="group" aria-label={activeOption?.title}
      data-testid="settings-subscription-login" data-provider={loginStatus.provider}>
      <div className={styles.identity}>
        <ProductBrandIcon productId={loginStatus.provider} size={40} />
        <span className={styles.plan}>{activeOption?.description}</span>
        {region && <span className={styles.region}>{region.label}</span>}
      </div>
      {!failed && <div className={styles.progress}><Spinner size="sm" /></div>}
      {renderAuthorization(loginStatus.provider)}
      <div className={styles.actions}>
        {failed ? <>
          <Button size="sm" variant="fill" onClick={onBack}>{t('subscriptionAuth.backToProviders')}</Button>
          <Button size="sm" variant="primary" disabled={disabled}
            onClick={() => onLogin(loginStatus.provider)}>{t('subscriptionAuth.retryLogin')}</Button>
        </> : <Button size="sm" variant="fill" disabled={loginStatus.status === 'cancelling'}
          loading={loginStatus.status === 'cancelling'}
          onClick={() => onCancel(loginStatus.provider)}>{t('subscriptionAuth.cancelAndBack')}</Button>}
      </div>
    </div>;
  }

  return <div className={styles.picker}>
    <div className={styles.options} role="group" aria-label={t('acquisition.subscriptions')}
      data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionArea">
      {options.map(option => {
        const region = regions[option.provider];
        const provider = option.regions?.find(item => item.provider === region)?.provider ?? option.provider;
        const loginButton = <Button size="sm" variant="primary" disabled={disabled}
          ref={button => { if (button) loginButtons.current.set(option.provider, button); else loginButtons.current.delete(option.provider); }}
          onClick={() => { lastProvider.current = option.provider; onLogin(provider); }}>
          {t('subscriptionAuth.login')}
        </Button>;
        return <Card key={option.provider} appearance="neutral" padding="sm"
          className={styles.card} role="group" aria-label={option.title}
          data-testid="settings-subscription-provider" data-provider={option.provider}>
          <CardBody align="center" className={styles.content}>
            <ProductBrandIcon productId={option.provider} size={40} />
            <div className={styles.heading}>
              <span className={styles.plan}><OverflowText>{option.description}</OverflowText></span>
            </div>
          </CardBody>
          <CardFooter align="center" className={styles.footer}>
            <div className={styles.actions} data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionActions">
              {option.regions ? <Capsule layout="split" splitSizing="content" size="sm" role="group" aria-label={option.title}>
                <Select size="sm" variant="pill" width="content" popupWidth="content"
                  aria-label={t('subscriptionAuth.chooseRegion')} disabled={disabled}
                  options={option.regions.map(item => ({ value: item.provider, label: item.label, selectedLabel: item.shortLabel, tooltip: item.label }))}
                  value={provider} onValueChange={value => setRegions(current => ({ ...current, [option.provider]: value as SubscriptionProvider }))} />
                {loginButton}
              </Capsule> : loginButton}
            </div>
          </CardFooter>
        </Card>;
      })}
    </div>
  </div>;
}
