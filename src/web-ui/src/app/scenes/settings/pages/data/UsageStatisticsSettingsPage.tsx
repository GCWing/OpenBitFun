import '@/app/scenes/settings/pages/data/UsageStatisticsSettingsPage.scss';
import {
  TokenUsageStatisticsUnavailableError,
  tokenUsageStatisticsApi,
  type UsageGranularity,
  type UsageStatistics,
  type UsageStatisticsEntry,
  type UsageTimeRange,
} from '@/infrastructure/api';
import {
  ConfigLoadingState,
  ConfigMessage,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
  ConfigPageSectionStack,
  ConfigRefreshButton,
} from '@/infrastructure/config/components/common';
import { UsageActivityHeatmap } from '@/infrastructure/config/components/UsageActivityHeatmap';
import { useI18n } from '@/infrastructure/i18n';
import { observeElementResize } from '@/shared/utils/sharedResizeObserver';
import {
  formatCacheHitRate,
  formatTokenCount,
  type LocalizedNumberFormatter,
} from '@/shared/utils/tokenUsageFormatting';
import {
  Button,
  Empty,
  Icon,
  IconButton,
  Input,
  Select,
  TabGroup,
  Tooltip,
} from '@openbitfun/ui';
import { BarChart3 } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

type DistributionKind = 'model' | 'group' | 'endpoint';

const TIME_RANGE_OPTIONS: { value: UsageTimeRange; key: string }[] = [
  { value: 'last24Hours', key: 'timeRange.last24Hours' },
  { value: 'today', key: 'timeRange.today' },
  { value: 'thisWeek', key: 'timeRange.thisWeek' },
  { value: 'thisMonth', key: 'timeRange.thisMonth' },
  { value: 'all', key: 'timeRange.all' },
];

const DISTRIBUTION_KINDS = ['model', 'group'] as const;
const TREND_MAX_VISIBLE_BUCKETS = 90;
const TREND_HEIGHT = 184;
const TREND_PAD_LEFT = 48;
const TREND_PAD_RIGHT = 12;
const TREND_PAD_TOP = 8;
const TREND_PAD_BOTTOM = 30;

function formatTokens(value: number, formatNumber: LocalizedNumberFormatter): string {
  return formatTokenCount(value, formatNumber);
}

function formatHitRate(value: number | null, formatNumber: LocalizedNumberFormatter): string {
  return value === null || !Number.isFinite(value)
    ? '–'
    : formatCacheHitRate(value, formatNumber);
}

function granularityForRange(range: UsageTimeRange): UsageGranularity {
  return range === 'today' || range === 'last24Hours' ? 'hour' : 'day';
}

function entryDisplay(
  entry: UsageStatisticsEntry,
  kind: DistributionKind,
  t: (key: string) => string,
): { primary: string; secondary?: string } {
  const missingConfig = entry.attributionStatus === 'config_missing'
    ? t('attribution.deletedConfig')
    : entry.attributionStatus === 'config_id_missing'
      ? t('attribution.unknownConfig')
      : undefined;
  if (kind === 'model') {
    return {
      primary: entry.name || t('attribution.unknownModel'),
      secondary: missingConfig || entry.providerName || t('attribution.unknownProvider'),
    };
  }
  if (kind === 'group' && missingConfig) {
    return { primary: missingConfig, secondary: entry.name || t('attribution.unknownModel') };
  }
  if (kind === 'endpoint' && missingConfig) {
    return { primary: t('attribution.unknownEndpoint'), secondary: missingConfig };
  }
  return {
    primary: entry.name || (kind === 'endpoint'
      ? t('attribution.unknownEndpoint')
      : t('attribution.unknownProvider')),
  };
}

function DistributionRows({
  kind,
  entries,
  totalTokens,
}: {
  kind: DistributionKind;
  entries: UsageStatisticsEntry[];
  totalTokens: number;
}) {
  const { t, formatNumber } = useI18n('settings/usage');
  return (
    <>
      {entries.map(entry => {
        const display = entryDisplay(entry, kind, t);
        const share = totalTokens > 0 ? entry.tokens / totalTokens : 0;
        return (
          <ConfigPageRow
            key={entry.key}
            label={display.primary}
            description={`${display.secondary ? `${display.secondary} · ` : ''}${kind === 'endpoint' ? `${t('distributions.byEndpoint')} · ` : ''}${t('table.requestsCount', { count: formatNumber(entry.requests) })}`}
            align="center"
          >
            <span className="openbitfun-usage-stats__metric-value">
              <strong>{formatTokens(entry.tokens, formatNumber)}</strong>
              <small>{t('table.shareValue', { share: formatNumber(share, { style: 'percent', maximumFractionDigits: 1 }) })}</small>
            </span>
          </ConfigPageRow>
        );
      })}
    </>
  );
}

function UsageDistribution({ stats }: { stats: UsageStatistics }) {
  const { t } = useI18n('settings/usage');
  const [kind, setKind] = useState<(typeof DISTRIBUTION_KINDS)[number]>('model');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const entries = kind === 'model' ? stats.byModel : stats.byGroup;
  const query = search.trim().toLocaleLowerCase();
  const filteredEntries = query
    ? entries.filter(entry => {
      const display = entryDisplay(entry, kind, t);
      return `${display.primary} ${display.secondary ?? ''}`.toLocaleLowerCase().includes(query);
    })
    : entries;
  const visibleEntries = expanded ? filteredEntries : filteredEntries.slice(0, 5);

  return (
    <ConfigPageSection
      title={t('distributions.title')}
      extra={(
        <TabGroup
          size="sm"
          value={kind}
          onValueChange={value => {
            setKind(value as typeof kind);
            setSearch('');
            setExpanded(false);
          }}
          aria-label={t('distributions.title')}
          items={DISTRIBUTION_KINDS.map(value => ({
            value,
            label: t(`table.${value}`),
            id: `${id}-${value}-tab`,
            panelId: `${id}-${value}-panel`,
          }))}
        />
      )}
      data-openbitfun-component="usage-statistics-config"
      data-openbitfun-part="distributions"
    >
      <ConfigPageRow label={t('filter.inputLabel')} align="center">
        <Input
          size="sm"
          value={search}
          onChange={event => { setSearch(event.target.value); setExpanded(false); }}
          placeholder={t('filter.placeholder')}
          aria-label={t('filter.inputLabel')}
          data-testid="usage-filter-input"
          maxLength={100}
          leading={<Icon name="search" size="sm" aria-hidden />}
          trailing={search ? (
            <Tooltip content={t('filter.clear')}>
              <IconButton
                type="button"
                size="sm"
                aria-label={t('filter.clear')}
                onClick={() => setSearch('')}
                icon={<Icon name="xmark" size="xs" aria-hidden />}
              />
            </Tooltip>
          ) : undefined}
        />
      </ConfigPageRow>
      {DISTRIBUTION_KINDS.map(value => (
        <div
          key={value}
          id={`${id}-${value}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${value}-tab`}
          hidden={kind !== value}
          tabIndex={0}
        >
          {kind === value && (
            filteredEntries.length === 0 ? (
              <Empty
                icon={<BarChart3 aria-hidden />}
                title={t('filter.empty.title')}
                description={t('filter.empty.description')}
              />
            ) : (
              <>
                <DistributionRows kind={kind} entries={visibleEntries} totalTokens={stats.totalTokens} />
                {filteredEntries.length > 5 && (
                  <ConfigPageRow label={t('distributions.more')} align="center">
                    <Button
                      size="sm"
                      variant="text"
                      onClick={() => setExpanded(value => !value)}
                      aria-expanded={expanded}
                    >
                      {t(expanded ? 'distributions.showLess' : 'distributions.showAll')}
                    </Button>
                  </ConfigPageRow>
                )}
              </>
            )
          )}
        </div>
      ))}
    </ConfigPageSection>
  );
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function TrendChart({ stats, timeZone }: { stats: UsageStatistics; timeZone: string }) {
  const { t, formatDate, formatNumber } = useI18n('settings/usage');
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const titleId = useId();
  const points = useMemo(() => stats.trend.slice(-TREND_MAX_VISIBLE_BUCKETS), [stats.trend]);

  useEffect(() => {
    if (!chartRef.current || points.length === 0) return;
    return observeElementResize(chartRef.current, entry => {
      if (entry.contentRect.width > 0) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
  }, [points.length]);

  if (points.length === 0) return null;

  const plotWidth = width - TREND_PAD_LEFT - TREND_PAD_RIGHT;
  const plotHeight = TREND_HEIGHT - TREND_PAD_TOP - TREND_PAD_BOTTOM;
  const maxTokens = niceMax(Math.max(...points.map(point => point.inputTokens + point.outputTokens)));
  const slotWidth = plotWidth / points.length;
  const barWidth = Math.max(1, Math.min(14, slotWidth * 0.72));
  const baseY = TREND_PAD_TOP + plotHeight;
  const visibleTotal = points.reduce((sum, point) => sum + point.inputTokens + point.outputTokens, 0);
  const partial = points.length < stats.trend.length || visibleTotal < stats.totalTokens;
  const labelFor = (bucket: string) => {
    const date = new Date(bucket);
    return formatDate(date, {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      ...(stats.granularity === 'hour' ? { hour: '2-digit', hourCycle: 'h23' as const } : {}),
    });
  };
  const firstLabel = labelFor(points[0].bucket);
  const lastLabel = labelFor(points[points.length - 1].bucket);
  const tickIndexes = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));

  return (
    <div ref={chartRef} className="openbitfun-usage-stats__trend">
      <p className="openbitfun-usage-stats__trend-range">
        {t('trend.range', { start: firstLabel, end: lastLabel })}
        {partial && ` · ${t('trend.partial')}`}
      </p>
      <svg
        className="openbitfun-usage-stats__trend-svg"
        viewBox={`0 0 ${width} ${TREND_HEIGHT}`}
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>{t('trend.description')}</title>
        {[0, 0.5, 1].map(fraction => {
          const y = baseY - fraction * plotHeight;
          return (
            <g key={fraction}>
              <line x1={TREND_PAD_LEFT} y1={y} x2={width - TREND_PAD_RIGHT} y2={y} className="openbitfun-usage-stats__trend-grid" />
              <text x={TREND_PAD_LEFT - 8} y={y + 4} textAnchor="end" className="openbitfun-usage-stats__trend-axis">
                {formatTokens(maxTokens * fraction, formatNumber)}
              </text>
            </g>
          );
        })}
        {points.map((point, index) => {
          const inputHeight = (point.inputTokens / maxTokens) * plotHeight;
          const outputHeight = (point.outputTokens / maxTokens) * plotHeight;
          const x = TREND_PAD_LEFT + index * slotWidth + (slotWidth - barWidth) / 2;
          return (
            <g key={point.bucket}>
              <title>{`${labelFor(point.bucket)} · ${t('trend.legend.input')} ${formatTokens(point.inputTokens, formatNumber)} · ${t('trend.legend.output')} ${formatTokens(point.outputTokens, formatNumber)}`}</title>
              <rect x={x} y={baseY - inputHeight} width={barWidth} height={inputHeight} className="openbitfun-usage-stats__trend-input" />
              <rect x={x} y={baseY - inputHeight - outputHeight} width={barWidth} height={outputHeight} className="openbitfun-usage-stats__trend-output" />
            </g>
          );
        })}
        {tickIndexes.map(index => (
          <text key={index} x={TREND_PAD_LEFT + (index + 0.5) * slotWidth} y={TREND_HEIGHT - 8} textAnchor="middle" className="openbitfun-usage-stats__trend-axis">
            {labelFor(points[index].bucket)}
          </text>
        ))}
      </svg>
      <div className="openbitfun-usage-stats__trend-legend" aria-hidden="true">
        <span><i className="openbitfun-usage-stats__trend-key openbitfun-usage-stats__trend-key--input" />{t('trend.legend.input')}</span>
        <span><i className="openbitfun-usage-stats__trend-key openbitfun-usage-stats__trend-key--output" />{t('trend.legend.output')}</span>
      </div>
      <table className="openbitfun-sr-only">
        <caption>{t('trend.dataTableCaption')}</caption>
        <thead><tr><th scope="col">{t('trend.time')}</th><th scope="col">{t('trend.legend.input')}</th><th scope="col">{t('trend.legend.output')}</th></tr></thead>
        <tbody>{points.map(point => (
          <tr key={point.bucket}>
            <th scope="row">{labelFor(point.bucket)}</th>
            <td>{formatTokens(point.inputTokens, formatNumber)}</td>
            <td>{formatTokens(point.outputTokens, formatNumber)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function UsageDetails({ stats, timeZone }: { stats: UsageStatistics; timeZone: string }) {
  const { t, formatNumber } = useI18n('settings/usage');
  const cacheHitRate = stats.totalCacheReportedInputTokens > 0
    ? stats.totalCachedTokens / stats.totalCacheReportedInputTokens
    : null;

  return (
    <ConfigPageSection
      title={t('details.title')}
      data-openbitfun-component="usage-statistics-config"
      data-openbitfun-part="details"
    >
      {stats.trend.length > 0 && (
        <ConfigPageRow label={t('trend.title')} description={t('trend.summary')} multiline>
          <div data-openbitfun-component="usage-statistics-config" data-openbitfun-part="trendPanel">
            <TrendChart stats={stats} timeZone={timeZone} />
          </div>
        </ConfigPageRow>
      )}
      <ConfigPageRow label={t('summary.cacheHitRate')} description={t('cache.note')} align="center">
        <span className="openbitfun-usage-stats__metric-value">
          <strong>{cacheHitRate === null ? t('cache.unavailable') : formatHitRate(cacheHitRate, formatNumber)}</strong>
        </span>
      </ConfigPageRow>
      <ConfigPageRow label={t('summary.cachedTokens')} align="center">
        <span className="openbitfun-usage-stats__metric-value">
          <strong>{formatTokens(stats.totalCachedTokens, formatNumber)}</strong>
        </span>
      </ConfigPageRow>
      {stats.byEndpoint.length > 0 && (
        <DistributionRows kind="endpoint" entries={stats.byEndpoint} totalTokens={stats.totalTokens} />
      )}
    </ConfigPageSection>
  );
}

const UsageStatisticsSettingsPage: React.FC = () => {
  const { t, resolvedTimeZone: timeZone, formatNumber } = useI18n('settings/usage');
  const [timeRange, setTimeRange] = useState<UsageTimeRange>('thisMonth');
  const [stats, setStats] = useState<UsageStatistics | null>(null);
  const [statsRange, setStatsRange] = useState<UsageTimeRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string } | null>(null);
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async (background = false) => {
    const requestId = ++requestIdRef.current;
    if (background) setRefreshing(true);
    else {
      setLoading(true);
      setStats(null);
    }
    setMessage(null);
    try {
      const result = await tokenUsageStatisticsApi.getStatistics({
        timeRange,
        granularity: granularityForRange(timeRange),
        timeZone,
        includeSubagent: true,
      });
      if (requestId !== requestIdRef.current) return;
      setStats(result);
      setStatsRange(timeRange);
      hasLoadedRef.current = true;
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setStats(null);
      setMessage(error instanceof TokenUsageStatisticsUnavailableError
        ? { type: 'info', text: t('unsupported') }
        : { type: 'error', text: t('loadFailed') });
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [timeRange, timeZone, t]);

  useEffect(() => { void load(); }, [load]);

  const visibleStats = statsRange === timeRange ? stats : null;
  const empty = visibleStats !== null && visibleStats.totalRequests === 0;

  return (
    <ConfigPageLayout
      className="openbitfun-usage-stats"
      data-openbitfun-component="usage-statistics-config"
      data-openbitfun-part="root"
    >
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        extra={(
          <ConfigRefreshButton
            tooltip={t('refresh')}
            onClick={() => { void load(true); setActivityRefreshKey(key => key + 1); }}
            loading={refreshing}
            disabled={loading}
          />
        )}
      />
      <ConfigPageContent>
        <ConfigPageSectionStack>
          {(hasLoadedRef.current || loading) && <UsageActivityHeatmap refreshKey={activityRefreshKey} />}

          <ConfigPageSection
            title={t('overview.title')}
            description={t('overview.description', { timeZone })}
            data-openbitfun-component="usage-statistics-config"
            data-openbitfun-part="overview"
          >
            <ConfigPageRow label={t('timeRange.label')} align="center">
              <Select
                size="sm"
                value={timeRange}
                options={TIME_RANGE_OPTIONS.map(option => ({ value: option.value, label: t(option.key) }))}
                onValueChange={value => setTimeRange(value as UsageTimeRange)}
                aria-label={t('timeRange.label')}
                disabled={loading}
              />
            </ConfigPageRow>
            <ConfigMessage className="openbitfun-usage-stats__message" message={message} />
            {loading ? (
              <ConfigLoadingState label={t('loading')} />
            ) : empty ? (
              <div data-openbitfun-component="usage-statistics-config" data-openbitfun-part="empty">
                <Empty
                  icon={<BarChart3 aria-hidden />}
                  title={t(timeRange === 'all' ? 'empty.title' : 'empty.periodTitle')}
                  description={t(timeRange === 'all' ? 'empty.description' : 'empty.periodDescription')}
                />
              </div>
            ) : visibleStats ? (
              <>
                <ConfigPageRow label={t('summary.tokens')} align="center">
                  <span
                    className="openbitfun-usage-stats__metric-value"
                    data-openbitfun-component="usage-statistics-config"
                    data-openbitfun-part="summary"
                  >
                    <strong>{formatTokens(visibleStats.totalTokens, formatNumber)}</strong>
                  </span>
                </ConfigPageRow>
                <ConfigPageRow label={t('summary.inputTokens')} align="center">
                  <span className="openbitfun-usage-stats__metric-value"><strong>{formatTokens(visibleStats.totalInputTokens, formatNumber)}</strong></span>
                </ConfigPageRow>
                <ConfigPageRow label={t('summary.outputTokens')} align="center">
                  <span className="openbitfun-usage-stats__metric-value"><strong>{formatTokens(visibleStats.totalOutputTokens, formatNumber)}</strong></span>
                </ConfigPageRow>
                <ConfigPageRow label={t('summary.requests')} align="center">
                  <span className="openbitfun-usage-stats__metric-value"><strong>{formatNumber(visibleStats.totalRequests)}</strong></span>
                </ConfigPageRow>
              </>
            ) : null}
          </ConfigPageSection>

          {!loading && !empty && visibleStats && (
            <>
              <UsageDistribution stats={visibleStats} />
              <UsageDetails stats={visibleStats} timeZone={timeZone} />
            </>
          )}
        </ConfigPageSectionStack>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default UsageStatisticsSettingsPage;
