import { useEffect, useState } from 'react';
import { createSettingsReadCache } from '../services/SettingsReadCache';
import {
  TokenUsageStatisticsUnavailableError,
  tokenUsageStatisticsApi,
  type UsageTrendPoint,
} from '@/infrastructure/api';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigLoadingState, ConfigMessage, ConfigPageSection } from './common';
import { usageActivityRequestRange } from './usageActivity';
import { UsageActivityGrid } from './UsageActivityGrid';

type ActivitySnapshot = { points: UsageTrendPoint[]; now: Date; timeZone: string };
const activitySnapshot = createSettingsReadCache<ActivitySnapshot>();

interface UsageActivityHeatmapProps {
  refreshKey: number;
}

export function UsageActivityHeatmap({ refreshKey }: UsageActivityHeatmapProps) {
  const { t, resolvedTimeZone: timeZone } = useI18n('settings/usage');
  const [data, setData] = useState<ActivitySnapshot | null>(() => activitySnapshot.peek(timeZone) ?? null);
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    setData(current => current?.timeZone === timeZone ? current : activitySnapshot.peek(timeZone) ?? null);
    setMessage(null);
    void activitySnapshot.read(async () => {
      const result = await tokenUsageStatisticsApi.getStatistics({
      timeRange: 'custom',
      granularity: 'day',
      timeZone,
      includeSubagent: true,
      ...usageActivityRequestRange(timeZone, now),
      });
      return { points: result.trend, now, timeZone };
    }, timeZone).then(result => {
      if (!cancelled) setData(result);
    }).catch(error => {
      if (!cancelled) {
        if (error instanceof TokenUsageStatisticsUnavailableError) {
          activitySnapshot.invalidate();
          setData(null);
        }
        setMessage(error instanceof TokenUsageStatisticsUnavailableError
          ? { type: 'info', text: t('unsupported') }
          : { type: 'error', text: t('loadFailed') });
      }
    });
    return () => { cancelled = true; };
  }, [refreshKey, timeZone, t]);

  const activity = data?.timeZone === timeZone ? data : null;

  return (
    <ConfigPageSection
      title={t('activity.title')}
      extra={<span className="openbitfun-usage-stats__activity-period">{t('activity.description', { timeZone })}</span>}
      data-openbitfun-component="usage-statistics-config"
      data-openbitfun-part="activityPanel"
    >
      {message && <ConfigMessage className="openbitfun-usage-stats__activity-message" message={message} />}
      {!activity ? (message ? null : (
        <ConfigLoadingState label={t('loading')} variant="statistics" rows={1} />
      )) : (
        <UsageActivityGrid points={activity.points} timeZone={activity.timeZone} now={activity.now} />
      )}
    </ConfigPageSection>
  );
}
