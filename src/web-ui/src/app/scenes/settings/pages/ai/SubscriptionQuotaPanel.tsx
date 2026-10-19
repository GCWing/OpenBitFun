import type { SubscriptionQuotaMeter } from '@/infrastructure/api/service-api/AIApi';
import type { SubscriptionProvider } from '@/infrastructure/config/types';
import { useSubscriptionQuota } from '@/infrastructure/config/hooks/useSubscriptionQuota';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { Button, Icon, IconButton, StatusPill, Tooltip } from '@openbitfun/ui';
import { finiteQuota, quotaIsStale, quotaMeters, remainingPercent } from './subscriptionQuotaPresentation';
import styles from './SubscriptionQuotaPanel.module.scss';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';

interface Props {
  provider: SubscriptionProvider;
  accountId?: string;
  identity: string;
  active: boolean;
  supported: boolean;
  refreshVersion?: number;
  compact?: boolean;
  modelId?: string;
}

export function SubscriptionQuotaPanel({ provider, accountId = provider, identity, active, supported, refreshVersion, compact, modelId }: Props) {
  const { t } = useI18n('settings/models');
  const query = useSubscriptionQuota(provider, accountId, active, supported, identity, refreshVersion, modelId);
  const snapshot = query.value;
  const meters = quotaMeters(snapshot);
  const stale = quotaIsStale(snapshot, query.failed);
  const number = (value: number) => i18nService.formatNumber(value, { maximumFractionDigits: 2 });
  const percent = (value: number) => i18nService.formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 });
  const date = (value?: number | null) => value != null && Number.isFinite(value) && !Number.isNaN(new Date(value * 1000).valueOf())
    ? i18nService.formatDate(new Date(value * 1000), { dateStyle: 'short', timeStyle: 'short' }) : null;
  const reasons: Record<string, string> = {
    opencode_public: 'quota.opencodePublic',
    opencode_balance_unavailable: 'quota.opencodeBalanceUnavailable',
    opencode_go_key_required: 'quota.opencodeGoKeyRequired',
    opencode_key_rejected: 'quota.opencodeKeyRejected',
    opencode_go_required: 'quota.opencodeGoRequired',
    opencode_query_failed: 'quota.queryFailed',
    opencode_custom_auth: 'quota.opencodeCustomAuth',
  };
  const reason = snapshot?.error && reasons[snapshot.error];
  const status = query.unsupportedHost ? t('quota.hostUnsupported')
    : reason && !meters.length ? t(reason)
    : snapshot?.state === 'unsupported' ? t('quota.unsupported')
      : query.failed ? t(meters.length ? 'quota.refreshFailedRetained' : 'quota.queryFailed')
        : query.loading && !snapshot ? t('quota.loading')
          : !meters.length ? t('quota.unknown') : null;
  const renderMeter = (meter: SubscriptionQuotaMeter) => {
    const left = finiteQuota(meter.remaining);
    const used = finiteQuota(meter.used);
    const limit = finiteQuota(meter.limit);
    const remaining = remainingPercent(meter);
    const duration = meter.duration_seconds;
    const period = duration === 7 * 86400 ? t('quota.weekly')
      : duration === 30 * 86400 ? t('quota.monthly')
        : duration && duration < 3600 ? t('quota.minutes', { count: number(duration / 60) })
          : duration && duration < 86400 ? t('quota.hours', { count: number(duration / 3600) })
            : duration ? t('quota.days', { count: number(duration / 86400) }) : null;
    const label = meter.display_name || (meter.secondary ? t('quota.mcp')
      : !period ? t(meter.unit === 'credits' ? 'quota.credits' : 'quota.allowance') : null);
    const name = [label, period].filter(Boolean).join(' · ');
    const tone = remaining !== undefined && remaining <= 0 ? 'danger' : remaining !== undefined && remaining <= 20 ? 'warning' : 'normal';
    const unit = meter.unit === 'credits' ? t('quota.creditsUnit') : meter.unit === 'requests' ? t('quota.requestsUnit') : '';
    return (
      <div className={styles.meter} data-openbitfun-component="model-settings" data-openbitfun-part="quotaMeter" key={meter.id} data-tone={tone} data-secondary={meter.secondary || undefined}>
        <div className={styles.meterHeading}><span>{name}</span></div>
        <div className={styles.value} data-openbitfun-component="model-settings" data-openbitfun-part="quotaValue">
          <strong>{meter.unlimited ? t('quota.unlimited') : left !== undefined ? number(left) : remaining !== undefined ? percent(remaining) : t('quota.noValue')}</strong>
          {!meter.unlimited && left !== undefined && unit && <span className={styles.unit}>{unit}</span>}
          {!meter.unlimited && (left !== undefined || remaining !== undefined) && <span className={styles.remainingLabel}>{t('quota.remaining')}</span>}
        </div>
        {remaining !== undefined && <div className={styles.track} data-openbitfun-component="model-settings" data-openbitfun-part="quotaTrack" role="progressbar" aria-label={t('quota.remainingFor', { name })}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={percent(remaining)}
          title={t('quota.usedPercent', { value: percent(100 - remaining) })}>
          <span style={{ inlineSize: `${remaining}%` }} />
        </div>}
        <div className={styles.meterDetails}>
          {!meter.unlimited && used !== undefined && limit !== undefined
            ? <span>{t('quota.usedOf', { used: number(used), total: number(limit) })}</span>
            : null}
          {date(meter.resets_at) && <time dateTime={new Date(meter.resets_at! * 1000).toISOString()}>{t('quota.resetsAt', { time: date(meter.resets_at) })}</time>}
          {date(meter.expires_at) && <time dateTime={new Date(meter.expires_at! * 1000).toISOString()}>{t('quota.expiresAt', { time: date(meter.expires_at) })}</time>}
        </div>
      </div>
    );
  };
  const initialLoading = query.loading && !snapshot && !query.failed && !query.unsupportedHost;
  return (
    <section className={`${styles.quota} ${compact ? styles.compact : ''}`} aria-label={t('quota.title')}
      data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionQuota"
      aria-busy={query.loading} data-testid="subscription-quota" data-provider={provider} data-state={initialLoading ? 'loading' : snapshot?.state || 'unknown'}>
      <div className={styles.header} data-openbitfun-component="model-settings" data-openbitfun-part="quotaHeader">
        <div className={styles.title}>
          <strong>{t('quota.title')}</strong>
          {snapshot?.plan && <span className={styles.plan}>{snapshot.plan}</span>}
          {stale && meters.length > 0 && <StatusPill tone="warning">{t('quota.stale')}</StatusPill>}
        </div>
        <div className={styles.actions}>
          {provider === 'opencode' && <Button size="xs" variant="text"
            trailingIcon={<Icon name="arrow-up-right" size="xs" />}
            onClick={() => void systemAPI.openExternal('https://opencode.ai/console')}>
            {t('quota.openConsole')}
          </Button>}
          {!query.unsupportedHost && snapshot?.state !== 'unsupported' && (
            <Tooltip content={t('quota.refresh')}>
              <IconButton size="xs" variant="quiet" aria-label={t('quota.refresh')}
                loading={query.loading} disabled={query.loading || !active}
                onClick={() => void query.refresh()} icon={<Icon name="refresh" size="xs" />} />
            </Tooltip>
          )}
        </div>
      </div>
      {status && <div className={styles.notice} data-warning={query.failed || undefined}
        role="status">
        {!initialLoading && <Icon name="info" size="sm" />}
        <span>{status}</span>
      </div>}
      {initialLoading && <div className={styles.skeletons} aria-hidden="true">
        {[0, 1].map(index => <div className={styles.skeleton} key={index}><span /><span /><span /></div>)}
      </div>}
      {!query.unsupportedHost && meters.some(meter => !meter.secondary) && <div className={styles.meters}>
        {meters.filter(meter => !meter.secondary).map(renderMeter)}
      </div>}
      {!query.unsupportedHost && meters.some(meter => meter.secondary) && <div className={styles.secondaryMeters}>
        {meters.filter(meter => meter.secondary).map(renderMeter)}
      </div>}
      {snapshot?.unlimited_credits && <p className={styles.notice}>{t('quota.unlimitedCredits')}</p>}
      {snapshot && (date(snapshot.observed_at) || (snapshot.display?.version === 1 && date(snapshot.display.expires_at))) && <footer className={styles.footer} data-openbitfun-component="model-settings" data-openbitfun-part="quotaFooter">
        {date(snapshot.observed_at) && <time dateTime={new Date(snapshot.observed_at! * 1000).toISOString()}>{t('quota.updatedAt', { time: date(snapshot.observed_at) })}</time>}
        {snapshot.display?.version === 1 && date(snapshot.display.expires_at) && <time dateTime={new Date(snapshot.display.expires_at! * 1000).toISOString()}>{t('quota.planUntil', { time: date(snapshot.display.expires_at) })}</time>}
      </footer>}
    </section>
  );
}
