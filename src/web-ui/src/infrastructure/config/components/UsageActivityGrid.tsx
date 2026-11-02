import React, { useMemo, useRef, useState } from 'react';
import { Tooltip } from '@openbitfun/ui';
import type { UsageTrendPoint } from '@/infrastructure/api/tokenUsageStatisticsApi';
import { useI18n } from '@/infrastructure/i18n';
import { formatTokenCount } from '@/shared/utils/tokenUsageFormatting';
import { buildUsageActivity } from './usageActivity';
import './UsageActivityGrid.scss';

interface UsageActivityGridProps {
  points: UsageTrendPoint[];
  timeZone: string;
  now: Date;
}

/** Shared, read-only calendar presentation. The caller owns host-scoped data. */
export function UsageActivityGrid({ points, timeZone, now }: UsageActivityGridProps) {
  const { t, formatDate, formatNumber } = useI18n('settings/usage');
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const dayRefs = useRef(new Map<string, HTMLButtonElement>());
  const activity = useMemo(() => buildUsageActivity(points, timeZone, now), [points, timeZone, now]);
  const visibleDays = activity.days.filter(day => day.inRange);
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
    <div className="openbitfun-usage-stats__activity" data-openbitfun-component="usage-activity-grid" data-openbitfun-part="root">
      <div
        className="openbitfun-usage-stats__activity-grid"
        data-openbitfun-component="usage-activity-grid"
        data-openbitfun-part="grid"
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
                data-openbitfun-component="usage-activity-grid"
                data-openbitfun-part="day"
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
      <div className="openbitfun-usage-stats__activity-footer" data-openbitfun-component="usage-activity-grid" data-openbitfun-part="footer">
        <span>{t('activity.total', { tokens: formatTokenCount(activity.totalTokens, formatNumber) })}</span>
        <div className="openbitfun-usage-stats__activity-legend" aria-hidden="true" data-openbitfun-component="usage-activity-grid" data-openbitfun-part="legend">
          <span>{t('activity.less')}</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className="openbitfun-usage-stats__activity-day" data-level={level} />
          ))}
          <span>{t('activity.more')}</span>
        </div>
      </div>
    </div>
  );
}
