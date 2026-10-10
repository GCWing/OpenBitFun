import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createSettingsReadCache } from '../services/SettingsReadCache';
import { Tooltip } from '@openbitfun/ui';
import {
  TokenUsageStatisticsUnavailableError,
  tokenUsageStatisticsApi,
  type UsageTrendPoint,
} from '@/infrastructure/api';
import { useI18n } from '@/infrastructure/i18n';
import { formatTokenCount } from '@/shared/utils/tokenUsageFormatting';
import { ConfigLoadingState, ConfigMessage, ConfigPageSection } from './common';
import { buildUsageActivity, usageActivityRequestRange } from './usageActivity';

type ActivitySnapshot = { points: UsageTrendPoint[]; now: Date; timeZone: string };
const activitySnapshot = createSettingsReadCache<ActivitySnapshot>();

interface UsageActivityHeatmapProps {
  refreshKey: number;
}

export function UsageActivityHeatmap({ refreshKey }: UsageActivityHeatmapProps) {
  const { t, formatDate, formatNumber, resolvedTimeZone: timeZone } = useI18n('settings/usage');
  const [data, setData] = useState<ActivitySnapshot | null>(() => activitySnapshot.peek(timeZone) ?? null);
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string } | null>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());

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

  const activity = useMemo(
    () => data?.timeZone === timeZone ? buildUsageActivity(data.points, timeZone, data.now) : null,
    [data, timeZone],
  );
  const visibleDays = activity?.days.filter(day => day.inRange) ?? [];
  const tabStop = visibleDays.some(day => day.key === focusedDate)
    ? focusedDate
    : visibleDays.at(-1)?.key;
  const moveFocus = (event: React.KeyboardEvent, index: number) => {
    const moves: Record<string, number> = {
      ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1,
      Home: -visibleDays.length, End: visibleDays.length,
    };
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const day = visibleDays[Math.max(0, Math.min(visibleDays.length - 1, index + delta))];
    dayRefs.current.get(day.key)?.focus();
  };

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
        <div className="openbitfun-usage-stats__activity">
          <div
            className="openbitfun-usage-stats__activity-grid"
            role="group"
            aria-label={t('activity.title')}
            style={{ gridTemplateColumns: `max-content repeat(${activity.weekCount}, minmax(0, 1fr))` }}
          >
            {activity.days.map((day, index) => {
              // Omit a short leading/trailing month label to avoid collisions.
              if (!day.inRange || (day.date.getUTCDate() !== 1 && day !== visibleDays[0])) return null;
              const column = Math.floor(index / 7);
              if (day === visibleDays[0] && day.date.getUTCDate() > 14) return null;
              if (column > activity.weekCount - 3) return null;
              return (
                <span
                  key={`month-${day.key}`}
                  className="openbitfun-usage-stats__activity-month"
                  aria-hidden="true"
                  style={{ gridColumn: `${column + 2} / span 3`, gridRow: 1 }}
                >
                  {formatDate(day.date, { month: 'short', timeZone: 'UTC' })}
                </span>
              );
            })}
            {[0, 2, 4, 6].map(weekday => (
              <span
                key={weekday}
                className="openbitfun-usage-stats__activity-weekday"
                aria-hidden="true"
                style={{ gridColumn: 1, gridRow: weekday + 2 }}
              >
                {formatDate(activity.days[weekday].date, { weekday: 'short', timeZone: 'UTC' })}
              </span>
            ))}
            {activity.days.map((day, index) => {
              if (!day.inRange) return null;
              const label = t('activity.day', {
                date: formatDate(day.date, { dateStyle: 'full', timeZone: 'UTC' }),
                tokens: formatNumber(day.tokens),
              });
              return (
                <Tooltip key={day.key} content={label} trigger="hover-focus" placement="top">
                  <button
                    ref={node => {
                      if (node) dayRefs.current.set(day.key, node);
                      else dayRefs.current.delete(day.key);
                    }}
                    type="button"
                    className="openbitfun-usage-stats__activity-day"
                    data-level={day.level}
                    aria-label={label}
                    tabIndex={tabStop === day.key ? 0 : -1}
                    onClick={event => event.currentTarget.focus()}
                    onFocus={() => setFocusedDate(day.key)}
                    onKeyDown={event => moveFocus(event, visibleDays.indexOf(day))}
                    style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: index % 7 + 2 }}
                  />
                </Tooltip>
              );
            })}
          </div>
          <div className="openbitfun-usage-stats__activity-footer">
            <span>{t('activity.total', { tokens: formatTokenCount(activity.totalTokens, formatNumber) })}</span>
            <div className="openbitfun-usage-stats__activity-legend" aria-hidden="true">
              <span>{t('activity.less')}</span>
              {[0, 1, 2, 3, 4].map(level => (
                <span key={level} className="openbitfun-usage-stats__activity-day" data-level={level} />
              ))}
              <span>{t('activity.more')}</span>
            </div>
          </div>
        </div>
      )}
    </ConfigPageSection>
  );
}
