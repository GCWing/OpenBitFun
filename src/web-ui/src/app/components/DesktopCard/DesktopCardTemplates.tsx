import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, StatusPill, type StatusPillTone } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { cronAPI, type CronJob } from '@/infrastructure/api/service-api/CronAPI';
import type {
  DesktopCardRecord,
  DesktopCardTemplate,
} from '@/infrastructure/api/service-api/DesktopCardAPI';
import { createLogger } from '@/shared/utils/logger';
import DesktopCardCustomFrame from './DesktopCardCustomFrame';
import {
  chartSeries,
  chartShare,
  countdownParts,
  formatChartLabel,
  formatChartValue,
  formatCountdownClock,
  formatMetricValue,
  isKnownChartStyle,
  lineGeometry,
  metricHint,
  metricRawValue,
  metricTone,
  progressState,
  type ChartPoint,
  type ChartSeries,
  type DesktopCardFormatters,
} from './desktopCardModel';
import { useNow } from './useNow';

const log = createLogger('DesktopCardTemplates');

type TemplateOf<K extends DesktopCardTemplate['kind']> = Extract<DesktopCardTemplate, { kind: K }>;

export function CountdownTemplate({ template, onDismiss }: {
  template: TemplateOf<'countdown'>;
  onDismiss: () => void;
}) {
  const { t } = useI18n('components');
  const now = useNow(1000, Date.now() < template.targetAtMs);
  const parts = countdownParts(template.targetAtMs, template.startedAtMs, now);
  return (
    <div className="openbitfun-desktop-card__countdown" data-state={parts.due ? 'due' : 'running'}
      data-openbitfun-component="desktop-card" data-openbitfun-part="countdown">
      <div className="openbitfun-desktop-card__countdown-clock" role="timer" aria-live={parts.due ? 'assertive' : 'off'}>
        {parts.due ? t('desktopCard.countdown.due') : (
          <>
            {parts.days > 0 && <span className="openbitfun-desktop-card__countdown-days">{t('desktopCard.countdown.days', { count: parts.days })}</span>}
            {formatCountdownClock(parts)}
          </>
        )}
      </div>
      {template.message && <p className="openbitfun-desktop-card__countdown-message">{template.message}</p>}
      {parts.due ? (
        <Button size="sm" variant="secondary" onClick={onDismiss}>{t('desktopCard.countdown.dismiss')}</Button>
      ) : parts.elapsedRatio !== null && (
        <div className="openbitfun-desktop-card__bar" aria-hidden="true">
          <span style={{ inlineSize: `${(parts.elapsedRatio * 100).toFixed(2)}%` }} />
        </div>
      )}
    </div>
  );
}

export function ChecklistTemplate({ template, onToggle }: {
  template: TemplateOf<'checklist'>;
  onToggle: (itemId: string, done: boolean) => void;
}) {
  const { t } = useI18n('components');
  if (template.items.length === 0) {
    return <p className="openbitfun-desktop-card__empty">{t('desktopCard.checklist.empty')}</p>;
  }
  return (
    <ul className="openbitfun-desktop-card__checklist" data-openbitfun-component="desktop-card" data-openbitfun-part="checklist">
      {template.items.map(item => (
        <li key={item.id} data-done={item.done ? 'true' : undefined}>
          <Checkbox size="sm" checked={item.done === true} label={item.text}
            onCheckedChange={checked => onToggle(item.id, checked)} />
        </li>
      ))}
    </ul>
  );
}

export function NoteTemplate({ template }: { template: TemplateOf<'note'> }) {
  return <p className="openbitfun-desktop-card__note" data-openbitfun-component="desktop-card" data-openbitfun-part="note">{template.text}</p>;
}

export function ProgressTemplate({ template, data, formatters }: {
  template: TemplateOf<'progress'>;
  data: unknown;
  formatters: DesktopCardFormatters;
}) {
  const state = progressState(template, data);
  return (
    <div className="openbitfun-desktop-card__progress" data-openbitfun-component="desktop-card" data-openbitfun-part="progress">
      <div className="openbitfun-desktop-card__progress-head">
        <span className="openbitfun-desktop-card__progress-value">
          {state.ratio === null ? '—' : formatters.formatNumber(state.ratio, { style: 'percent', maximumFractionDigits: 0 })}
        </span>
        {state.value !== null && (
          <span className="openbitfun-desktop-card__muted">
            {formatters.formatNumber(state.value)} / {formatters.formatNumber(state.max)}
          </span>
        )}
      </div>
      <div className="openbitfun-desktop-card__bar" role="progressbar" aria-valuemin={0} aria-valuemax={state.max}
        aria-valuenow={state.value ?? undefined}>
        <span style={{ inlineSize: `${((state.ratio ?? 0) * 100).toFixed(2)}%` }} />
      </div>
      {state.status && <p className="openbitfun-desktop-card__muted openbitfun-desktop-card__progress-status">{state.status}</p>}
    </div>
  );
}

export function MetricsTemplate({ template, data, formatters }: {
  template: TemplateOf<'metrics'>;
  data: unknown;
  formatters: DesktopCardFormatters;
}) {
  const layout = template.layout === 'grid' ? 'grid' : 'list';
  return (
    <dl className="openbitfun-desktop-card__metrics" data-layout={layout}
      data-openbitfun-component="desktop-card" data-openbitfun-part="metrics">
      {template.items.map((item, index) => {
        const raw = metricRawValue(item, data);
        const hint = metricHint(item, data);
        return (
          <div key={`${item.label}-${index}`} className="openbitfun-desktop-card__metric"
            data-emphasis={item.emphasis ? 'true' : undefined} data-tone={metricTone(item, raw)} title={hint}>
            <dt>{item.label}</dt>
            <dd>{formatMetricValue(item, raw, formatters)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

interface ChartViewProps {
  series: ChartSeries;
  value: (value: number) => string;
  label: (point: ChartPoint) => string;
  percent: (share: number) => string;
}

/** Untoned parts step through shades of the card tone so neighbors stay distinguishable. */
function markShade(point: ChartPoint, index: number): number | undefined {
  return point.tone ? undefined : index % 6;
}

function ChartBars({ series, value, label, percent }: ChartViewProps) {
  return (
    <ol className="openbitfun-desktop-card__chart-bars">
      {series.points.map((point, index) => {
        const share = chartShare(point.value, series.scale);
        const text = label(point);
        return (
          <li key={`${point.label}-${index}`} className="openbitfun-desktop-card__chart-bar"
            title={point.hint ? `${text}: ${value(point.value)}\n${point.hint}` : `${text}: ${value(point.value)}`}>
            <div className="openbitfun-desktop-card__chart-row">
              <span className="openbitfun-desktop-card__chart-label">{text}</span>
              <span className="openbitfun-desktop-card__chart-value">
                {value(point.value)}
                {series.total !== null && (
                  <span className="openbitfun-desktop-card__muted"> · {percent(chartShare(point.value, series.total))}</span>
                )}
              </span>
            </div>
            <div className="openbitfun-desktop-card__chart-track" aria-hidden="true">
              <span className="openbitfun-desktop-card__chart-mark" data-tone={point.tone}
                style={{ inlineSize: `${(share * 100).toFixed(2)}%` }} />
            </div>
            {point.hint && <span className="openbitfun-desktop-card__chart-hint">{point.hint}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function ChartLegend({ series, value, label, percent, remainderLabel }: ChartViewProps & { remainderLabel: string }) {
  return (
    <ul className="openbitfun-desktop-card__chart-legend">
      {series.points.map((point, index) => (
        <li key={`${point.label}-${index}`} title={point.hint}>
          <div className="openbitfun-desktop-card__chart-row">
            <span className="openbitfun-desktop-card__chart-mark openbitfun-desktop-card__chart-swatch" aria-hidden="true"
              data-tone={point.tone} data-shade={markShade(point, index)} />
            <span className="openbitfun-desktop-card__chart-label">{label(point)}</span>
            <span className="openbitfun-desktop-card__chart-value">{value(point.value)}</span>
            <span className="openbitfun-desktop-card__muted openbitfun-desktop-card__chart-share">
              {percent(chartShare(point.value, series.scale))}
            </span>
          </div>
          {point.hint && <span className="openbitfun-desktop-card__chart-hint">{point.hint}</span>}
        </li>
      ))}
      {series.remainder > 0 && (
        <li data-remainder="true">
          <div className="openbitfun-desktop-card__chart-row">
            <span className="openbitfun-desktop-card__chart-mark openbitfun-desktop-card__chart-swatch" aria-hidden="true"
              data-remainder="true" />
            <span className="openbitfun-desktop-card__chart-label">{remainderLabel}</span>
            <span className="openbitfun-desktop-card__chart-value">{value(series.remainder)}</span>
            <span className="openbitfun-desktop-card__muted openbitfun-desktop-card__chart-share">
              {percent(chartShare(series.remainder, series.scale))}
            </span>
          </div>
        </li>
      )}
    </ul>
  );
}

function ChartTotal({ series, value, percent }: ChartViewProps) {
  const { t } = useI18n('components');
  return (
    <div className="openbitfun-desktop-card__chart-summary">
      <span className="openbitfun-desktop-card__chart-total">{value(series.sum)}</span>
      {series.total !== null && (
        <span className="openbitfun-desktop-card__muted">
          {t('desktopCard.chart.ofTotal', { total: value(series.total) })} · {percent(chartShare(series.sum, series.total))}
        </span>
      )}
    </div>
  );
}

function ChartStacked(props: ChartViewProps & { remainderLabel: string }) {
  const { series } = props;
  return (
    <>
      <ChartTotal {...props} />
      <div className="openbitfun-desktop-card__chart-stack" aria-hidden="true">
        {series.points.map((point, index) => (
          <span key={`${point.label}-${index}`} className="openbitfun-desktop-card__chart-mark"
            data-tone={point.tone} data-shade={markShade(point, index)}
            style={{ inlineSize: `${(chartShare(point.value, series.scale) * 100).toFixed(2)}%` }} />
        ))}
      </div>
      <ChartLegend {...props} />
    </>
  );
}

const DONUT_RADIUS = 15.9155;

function ChartDonut(props: ChartViewProps & { remainderLabel: string }) {
  const { series, value, percent } = props;
  let offset = 0;
  const segments = series.points.map((point, index) => {
    const length = chartShare(point.value, series.scale) * 100;
    const segment = { point, index, length, start: offset };
    offset += length;
    return segment;
  });
  return (
    <div className="openbitfun-desktop-card__chart-donut-layout">
      <div className="openbitfun-desktop-card__chart-donut">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle className="openbitfun-desktop-card__chart-mark" data-remainder="true"
            cx="18" cy="18" r={DONUT_RADIUS} fill="none" strokeWidth="4" />
          {segments.filter(segment => segment.length > 0).map(({ point, index, length, start }) => (
            <circle key={`${point.label}-${index}`} className="openbitfun-desktop-card__chart-mark"
              data-tone={point.tone} data-shade={markShade(point, index)}
              cx="18" cy="18" r={DONUT_RADIUS} fill="none" strokeWidth="4"
              strokeDasharray={`${length.toFixed(3)} ${(100 - length).toFixed(3)}`}
              strokeDashoffset={(25 - start).toFixed(3)} />
          ))}
        </svg>
        <span className="openbitfun-desktop-card__chart-donut-center">
          {series.total !== null ? percent(chartShare(series.sum, series.total)) : value(series.sum)}
        </span>
      </div>
      <ChartLegend {...props} />
    </div>
  );
}

function ChartColumns({ series, value, label }: ChartViewProps) {
  const count = series.points.length;
  const showValues = count <= 8;
  const labelStep = Math.ceil(count / 8);
  return (
    <div className="openbitfun-desktop-card__chart-columns" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {series.points.map((point, index) => {
        const text = label(point);
        const showLabel = index % labelStep === 0 || index === count - 1;
        return (
          <div key={`${point.label}-${index}`} className="openbitfun-desktop-card__chart-column"
            title={point.hint ? `${text}: ${value(point.value)}\n${point.hint}` : `${text}: ${value(point.value)}`}>
            {showValues && <span className="openbitfun-desktop-card__chart-column-value">{value(point.value)}</span>}
            <div className="openbitfun-desktop-card__chart-column-track" aria-hidden="true">
              <span className="openbitfun-desktop-card__chart-mark" data-tone={point.tone}
                style={{ blockSize: `${(chartShare(point.value, series.scale) * 100).toFixed(2)}%` }} />
            </div>
            <span className="openbitfun-desktop-card__chart-column-label">{showLabel ? text : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

function ChartLine({ series, value, label }: ChartViewProps) {
  const { t } = useI18n('components');
  const geometry = lineGeometry(series.points);
  if (!geometry) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.chart.empty')}</p>;
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  const change = geometry.last - geometry.first;
  const changeText = `${change > 0 ? '+' : change < 0 ? '−' : '±'}${value(Math.abs(change))}`;
  return (
    <>
      <div className="openbitfun-desktop-card__chart-summary">
        <span className="openbitfun-desktop-card__chart-total">{value(geometry.last)}</span>
        <span className="openbitfun-desktop-card__muted">
          {t('desktopCard.chart.changeSince', { change: changeText, label: label(first) })}
        </span>
      </div>
      <svg className="openbitfun-desktop-card__chart-line" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path className="openbitfun-desktop-card__chart-area" d={geometry.area} />
        <polyline className="openbitfun-desktop-card__chart-stroke" points={geometry.line} fill="none"
          vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="openbitfun-desktop-card__chart-axis openbitfun-desktop-card__muted">
        <span>{label(first)}</span>
        <span>{t('desktopCard.chart.range', { min: value(geometry.min), max: value(geometry.max) })}</span>
        <span>{label(last)}</span>
      </div>
    </>
  );
}

export function ChartTemplate({ template, data, formatters }: {
  template: TemplateOf<'chart'>;
  data: unknown;
  formatters: DesktopCardFormatters;
}) {
  const { t } = useI18n('components');
  if (!isKnownChartStyle(template.chart)) {
    return <p className="openbitfun-desktop-card__empty">{t('desktopCard.unsupportedTemplate')}</p>;
  }
  const series = chartSeries(template, data, t('desktopCard.chart.other'));
  if (series.points.length === 0) {
    return <p className="openbitfun-desktop-card__empty">{t('desktopCard.chart.empty')}</p>;
  }
  const props: ChartViewProps = {
    series,
    value: amount => formatChartValue(template, amount, formatters),
    label: point => formatChartLabel(template, point.label, formatters),
    percent: share => formatters.formatNumber(share, { style: 'percent', maximumFractionDigits: share > 0 && share < 0.01 ? 1 : 0 }),
  };
  const remainderLabel = template.remainderLabel || t('desktopCard.chart.remaining');
  const summary = series.points.map(point => `${props.label(point)} ${props.value(point.value)}`).join(', ');
  return (
    <figure className="openbitfun-desktop-card__chart" data-chart={template.chart} role="group" aria-label={summary}
      data-openbitfun-component="desktop-card" data-openbitfun-part="chart">
      {template.chart === 'bar' && <ChartBars {...props} />}
      {template.chart === 'column' && <ChartColumns {...props} />}
      {template.chart === 'line' && <ChartLine {...props} />}
      {template.chart === 'stacked' && <ChartStacked {...props} remainderLabel={remainderLabel} />}
      {template.chart === 'donut' && <ChartDonut {...props} remainderLabel={remainderLabel} />}
      {template.caption && <figcaption className="openbitfun-desktop-card__chart-caption">{template.caption}</figcaption>}
    </figure>
  );
}

const CRON_STATUS_TONE: Record<string, StatusPillTone> = {
  ok: 'success',
  error: 'danger',
  running: 'info',
  queued: 'info',
  cancelled: 'neutral',
};

function cronStatusLabel(t: (key: string) => string, status: string): string {
  switch (status) {
    case 'ok': return t('desktopCard.cron.status.ok');
    case 'error': return t('desktopCard.cron.status.error');
    case 'running': return t('desktopCard.cron.status.running');
    case 'queued': return t('desktopCard.cron.status.queued');
    case 'cancelled': return t('desktopCard.cron.status.cancelled');
    default: return status;
  }
}

export function CronJobTemplate({ template, formatters }: {
  template: TemplateOf<'cronJob'>;
  formatters: DesktopCardFormatters;
}) {
  const { t } = useI18n('components');
  const [job, setJob] = useState<CronJob | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useNow(30_000);

  const load = useCallback(async () => {
    try {
      const jobs = await cronAPI.listJobs();
      setJob(jobs.find(candidate => candidate.id === template.jobId) ?? null);
      setFailed(false);
    } catch (error) {
      log.warn('Failed to load scheduled job for desktop card', { jobId: template.jobId, error });
      setFailed(true);
    }
  }, [template.jobId]);

  useEffect(() => {
    void load();
    const unlisten = cronAPI.onJobsChanged(() => { void load(); });
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      unlisten();
      window.clearInterval(timer);
    };
  }, [load]);

  if (failed && job === undefined) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.cron.failed')}</p>;
  if (job === undefined) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.loading')}</p>;
  if (job === null) return <p className="openbitfun-desktop-card__empty">{t('desktopCard.cron.missing')}</p>;

  const nextRun = job.state.nextRunAtMs ?? job.state.retryAtMs ?? null;
  const lastRun = job.state.lastRunFinishedAtMs ?? job.state.lastRunStartedAtMs ?? null;
  const lastStatus = job.state.lastRunStatus ?? null;
  return (
    <div className="openbitfun-desktop-card__cron" data-openbitfun-component="desktop-card" data-openbitfun-part="cron">
      <div className="openbitfun-desktop-card__cron-head">
        <span className="openbitfun-desktop-card__cron-name">{job.name}</span>
        <StatusPill tone={job.enabled ? 'success' : 'neutral'}>
          {t(job.enabled ? 'desktopCard.cron.enabled' : 'desktopCard.cron.paused')}
        </StatusPill>
      </div>
      <dl className="openbitfun-desktop-card__metrics" data-layout="list">
        <div className="openbitfun-desktop-card__metric">
          <dt>{t('desktopCard.cron.nextRun')}</dt>
          <dd title={nextRun ? formatters.formatDate(nextRun, { dateStyle: 'medium', timeStyle: 'short' }) : undefined}>
            {job.enabled && nextRun ? formatters.formatRelativeTime(nextRun) : '—'}
          </dd>
        </div>
        <div className="openbitfun-desktop-card__metric" data-tone={lastStatus ? CRON_STATUS_TONE[lastStatus] : undefined}>
          <dt>{t('desktopCard.cron.lastRun')}</dt>
          <dd title={job.state.lastError ?? undefined}>
            {lastStatus ? cronStatusLabel(t, lastStatus) : t('desktopCard.cron.neverRun')}
            {lastRun ? ` · ${formatters.formatRelativeTime(lastRun)}` : ''}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function CustomTemplate({ template, card, data, onOpenLink }: {
  template: TemplateOf<'custom'>;
  card: DesktopCardRecord;
  data: unknown;
  onOpenLink: (url: string) => void;
}) {
  const payload = React.useMemo(() => ({
    data,
    card: { id: card.id, title: card.title, subtitle: card.subtitle },
    error: card.lastData?.error,
  }), [data, card.id, card.title, card.subtitle, card.lastData?.error]);
  return <DesktopCardCustomFrame html={template.html} title={card.title} payload={payload} onOpenLink={onOpenLink} />;
}
