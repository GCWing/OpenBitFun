import { useEffect, useState } from 'react';
import { Tooltip } from '@openbitfun/ui';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { formatDuration } from '@/shared/utils/format';

export function SubscriptionAuthorizationExpiry({ expiresAt, active }: { expiresAt: number; active: boolean }) {
  const { t } = useI18n('settings/models');
  const [now, setNow] = useState(() => Date.now());
  const deadline = expiresAt * 1000;
  const valid = Number.isFinite(deadline) && !Number.isNaN(new Date(deadline).valueOf());

  useEffect(() => {
    if (!active || !valid) return;
    const update = () => {
      const current = Date.now();
      setNow(current);
      return current;
    };
    if (update() >= deadline) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && update() >= deadline) window.clearInterval(timer);
    }, 1000);
    const resume = () => { if (document.visibilityState !== 'hidden') update(); };
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [active, deadline, valid]);

  if (!valid) return null;
  const remaining = deadline - now;
  const expired = remaining <= 0;
  const fullExpiry = t('subscriptionAuth.expiresAt', {
    time: i18nService.formatDate(new Date(deadline), { dateStyle: 'medium', timeStyle: 'short' }),
  });
  return <Tooltip content={fullExpiry}>
    <time className="openbitfun-model-settings__cli-authorization-expiry" dateTime={new Date(deadline).toISOString()}
      tabIndex={0} data-expired={expired || undefined}>
      {expired ? t('subscriptionAuth.authorizationExpired')
        : t('subscriptionAuth.expiresIn', { time: formatDuration(Math.max(1000, remaining), 'live') })}
    </time>
  </Tooltip>;
}
