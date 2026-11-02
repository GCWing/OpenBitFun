import type { ReactNode } from 'react';
import type { SubscriptionQuotaMeter } from '@/infrastructure/api/service-api/AIApi';
import type { SubscriptionProvider } from '@/infrastructure/config/types';
import { useSubscriptionQuota } from '@/infrastructure/config/hooks/useSubscriptionQuota';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { Button, Card, Icon, IconButton, StatusPill, Tooltip } from '@openbitfun/ui';
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
  inline?: boolean;
  modelId?: string;
  accountLabel?: ReactNode;
  headerLeading?: ReactNode;
  headerActions?: ReactNode;
  /** Place the plan beside the account while keeping one account-scoped observation. */
  renderInline?: (parts: { plan: ReactNode; quota: ReactNode; loading: boolean }) => ReactNode;
}

export function SubscriptionQuotaPanel({ provider, accountId = provider, identity, active, supported, refreshVersion, compact, inline, modelId, accountLabel, headerLeading, headerActions, renderInline }: Props) {
  const { t } = useI18n('settings/models');
  const query = useSubscriptionQuota(provider, accountId, active, supported, identity, refreshVersion, modelId, Boolean(inline));
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
        : provider === 'grok' && snapshot?.state === 'known' && meters.some(meter => meter.id === 'period' && remainingPercent(meter) === undefined) ? t('quota.usageUnreported')
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
    const label = (meter.id === 'on-demand' ? t('quota.onDemand') : meter.display_name) || (meter.secondary ? t('quota.mcp')
      : !period ? t(meter.unit === 'credits' ? 'quota.credits' : 'quota.allowance') : null);
    const name = [label, period].filter(Boolean).join(' · ');
    const tone = remaining !== undefined && remaining <= 0 ? 'danger' : remaining !== undefined && remaining <= 20 ? 'warning' : 'normal';
    const unit = meter.unit === 'credits' ? t('quota.creditsUnit') : meter.unit === 'requests' ? t('quota.requestsUnit') : '';
    const details = <div className={styles.meterDetails}>
      {!meter.unlimited && used !== undefined && limit !== undefined
        ? <span>{t('quota.usedOf', { used: number(used), total: number(limit) })}</span>
        : null}
      {date(meter.resets_at) && <time dateTime={new Date(meter.resets_at! * 1000).toISOString()}>{t('quota.resetsAt', { time: date(meter.resets_at) })}</time>}
      {date(meter.expires_at) && <time dateTime={new Date(meter.expires_at! * 1000).toISOString()}>{t('quota.expiresAt', { time: date(meter.expires_at) })}</time>}
    </div>;
    const meterContent = (
      <div className={styles.meter} data-openbitfun-component="model-settings" data-openbitfun-part="quotaMeter" key={meter.id} data-tone={tone} data-secondary={meter.secondary || undefined} tabIndex={inline ? 0 : undefined}>
        <div className={styles.meterHeading}><span>{name}</span></div>
        <div className={styles.value} data-openbitfun-component="model-settings" data-openbitfun-part="quotaValue" aria-label={compact || inline ? t('quota.remainingFor', { name }) : undefined}>
          <strong>{meter.unlimited ? t('quota.unlimited') : left !== undefined ? number(left) : remaining !== undefined ? percent(remaining) : t('quota.noValue')}</strong>
          {!meter.unlimited && left !== undefined && unit && <span className={styles.unit}>{unit}</span>}
          {!compact && !inline && !meter.unlimited && (left !== undefined || remaining !== undefined) && <span className={styles.remainingLabel}>{t('quota.remaining')}</span>}
        </div>
        {remaining !== undefined && <div className={styles.track} data-openbitfun-component="model-settings" data-openbitfun-part="quotaTrack" role="progressbar" aria-label={t('quota.remainingFor', { name })}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={percent(remaining)}
          title={t('quota.usedPercent', { value: percent(100 - remaining) })}>
          {inline ? Array.from({ length: 24 }, (_, index) => (
            <span key={index} aria-hidden="true" data-filled={index < Math.ceil(remaining * 24 / 100)} />
          )) : <span style={{ inlineSize: `${remaining}%` }} />}
        </div>}
        {!inline && details}
      </div>
    );
    return inline ? <Tooltip key={meter.id} content={<>{t('quota.remainingFor', { name })}{details}</>}>{meterContent}</Tooltip> : meterContent;
  };
  const initialLoading = query.loading && !snapshot && !query.failed && !query.unsupportedHost;
  const inlineLoading = inline && initialLoading;
  const plan = inlineLoading ? <span className={styles.skeletonPlan} aria-hidden="true" />
    : snapshot?.plan ? (inline && snapshot.display?.version === 1 && date(snapshot.display.expires_at)
      ? <Tooltip content={t('quota.planUntil', { time: date(snapshot.display.expires_at) })}><StatusPill tone="neutral">{snapshot.plan}</StatusPill></Tooltip>
      : <StatusPill tone="neutral">{snapshot.plan}</StatusPill>) : null;
  const content = (
    <>
      <div className={styles.header} data-openbitfun-component="model-settings" data-openbitfun-part="quotaHeader">
        {headerLeading}
        <div className={styles.title}>
          {accountLabel ? <span className={styles.accountLabel}>{accountLabel}</span> : null}
          {!inlineLoading && !accountLabel && !(inline && renderInline) && ((!compact && !inline) || (!snapshot?.plan && !meters.length)) && <strong>{t('quota.title')}</strong>}
          {!(inline && renderInline) && plan}
          {!inline && stale && meters.length > 0 && <StatusPill tone="warning">{t('quota.stale')}</StatusPill>}
        </div>
        <div className={styles.actions}>
          {headerActions}
          {provider === 'opencode' && <Button size="xs" variant="outline"
            trailingIcon={<Icon name="arrow-up-right" size="xs" />}
            onClick={() => void systemAPI.openExternal('https://opencode.ai/console')}>
            {t('quota.openConsole')}
          </Button>}
          {!(inline && renderInline) && !query.unsupportedHost && snapshot?.state !== 'unsupported' && (
            <Tooltip content={t('quota.refresh')}>
              <IconButton size="xs" variant="quiet" aria-label={t('quota.refresh')}
                loading={query.loading} disabled={query.loading || !active}
                onClick={() => void query.refresh()} icon={<Icon name="refresh" size="xs" />} />
            </Tooltip>
          )}
        </div>
      </div>
      {status && <div className={inlineLoading ? 'sr-only' : styles.notice} data-warning={query.failed || undefined}
        role="status">
        {!initialLoading && <Icon name="info" size="sm" />}
        <span>{status}</span>
      </div>}
      {inlineLoading && <div className={`${styles.meter} ${styles.inlineSkeleton}`} aria-hidden="true" data-testid="subscription-quota-skeleton">
        <span className={styles.skeletonLabel} />
        <div className={`${styles.track} ${styles.skeletonTrack}`}>
          {Array.from({ length: 24 }, (_, index) => <span key={index}
            style={{ animationDelay: `calc(var(--openbitfun-motion-duration-loop) / 24 * ${-index})` }} />)}
        </div>
        <span className={styles.skeletonValue} />
      </div>}
      {initialLoading && !inline && <div className={styles.skeletons} aria-hidden="true">
        {[0, 1].map(index => <div className={styles.skeleton} key={index}><span /><span /><span /></div>)}
      </div>}
      {!query.unsupportedHost && meters.some(meter => !meter.secondary) && <div className={styles.meters}>
        {meters.filter(meter => !meter.secondary).map(renderMeter)}
      </div>}
      {!query.unsupportedHost && meters.some(meter => meter.secondary) && <div className={styles.secondaryMeters}>
        {meters.filter(meter => meter.secondary).map(renderMeter)}
      </div>}
      {snapshot?.unlimited_credits && <p className={styles.notice}>{t('quota.unlimitedCredits')}</p>}
      {!inline && snapshot?.display?.version === 1 && date(snapshot.display.expires_at) && <footer className={styles.footer} data-openbitfun-component="model-settings" data-openbitfun-part="quotaFooter">
        <time dateTime={new Date(snapshot.display.expires_at! * 1000).toISOString()}>{t('quota.planUntil', { time: date(snapshot.display.expires_at) })}</time>
      </footer>}
    </>
  );
  const panel = (
    <section className={`${styles.quota} ${compact ? styles.compact : ''} ${inline ? styles.inline : ''}`} aria-label={t('quota.title')}
      data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionQuota"
      aria-busy={query.loading} data-testid="subscription-quota" data-provider={provider} data-state={initialLoading ? 'loading' : snapshot?.state || 'unknown'}>
      {compact || inline ? content : <Card appearance="subtle" padding="sm">{content}</Card>}
    </section>
  );
  return inline && renderInline ? renderInline({ plan, quota: panel, loading: query.loading }) : panel;
}
