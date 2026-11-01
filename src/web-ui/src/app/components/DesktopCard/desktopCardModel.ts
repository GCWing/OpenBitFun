import type {
  DesktopCardChartStyle,
  DesktopCardChartTemplate,
  DesktopCardMetricItem,
  DesktopCardRecord,
  DesktopCardTemplate,
  DesktopCardTone,
} from '@/infrastructure/api/service-api/DesktopCardAPI';

export const DESKTOP_CARD_TONES: readonly DesktopCardTone[] = ['neutral', 'accent', 'info', 'success', 'warning', 'danger'];
const KNOWN_TEMPLATE_KINDS = new Set(['countdown', 'checklist', 'note', 'progress', 'metrics', 'chart', 'cronJob', 'custom']);

/** Most items each chart style draws; matches `DESKTOP_CARD_CHART_STYLES` in the core DesktopCard host contract. */
export const DESKTOP_CARD_CHART_LIMITS: Readonly<Record<DesktopCardChartStyle, number>> = {
  bar: 12,
  column: 24,
  line: 120,
  donut: 6,
  stacked: 6,
};

export interface DesktopCardFormatters {
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  formatRelativeTime: (value: Date | number) => string;
}

export function knownTemplate(card: DesktopCardRecord): DesktopCardTemplate | null {
  const kind = card.template?.kind;
  return typeof kind === 'string' && KNOWN_TEMPLATE_KINDS.has(kind) ? card.template as DesktopCardTemplate : null;
}

export function hasDataSource(card: DesktopCardRecord): boolean {
  return typeof card.dataSource?.kind === 'string';
}

/** Template paths read the latest fetched value when the card has a data source. */
export function effectiveCardData(card: DesktopCardRecord): unknown {
  if (hasDataSource(card)) return card.lastData?.value ?? null;
  return card.data ?? null;
}

/** RFC 6901 JSON Pointer lookup; returns undefined for missing paths. */
export function resolvePointer(root: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined) return undefined;
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** JSON Pointers a template reads from the card data, matching the host's `desktop_card_template_paths`. */
export function templateDataPaths(template: DesktopCardTemplate | null): string[] {
  switch (template?.kind) {
    case 'progress':
      return [template.valuePath, template.maxPath, template.statusPath].filter((path): path is string => path !== undefined);
    case 'metrics':
      return (Array.isArray(template.items) ? template.items : [])
        .flatMap(item => [item.path, item.hintPath])
        .filter((path): path is string => path !== undefined);
    case 'chart':
      return [template.itemsPath, template.labelsPath, template.totalPath]
        .filter((path): path is string => path !== undefined);
    default:
      return [];
  }
}

/** Whether the rendered data leaves a template path missing or null, so the card shows placeholders. */
export function hasUnresolvedTemplatePaths(card: DesktopCardRecord): boolean {
  const data = effectiveCardData(card);
  return templateDataPaths(knownTemplate(card)).some(path => {
    const value = resolvePointer(data, path);
    return value === undefined || value === null;
  });
}

export function normalizeTone(tone: unknown): DesktopCardTone | undefined {
  return typeof tone === 'string' && (DESKTOP_CARD_TONES as readonly string[]).includes(tone)
    ? tone as DesktopCardTone
    : undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTimestampMs(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric !== null) return Math.abs(numeric) < 1e11 ? numeric * 1000 : numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function metricRawValue(item: DesktopCardMetricItem, data: unknown): unknown {
  return item.path !== undefined ? resolvePointer(data, item.path) : item.value;
}

export function metricTone(item: DesktopCardMetricItem, raw: unknown): DesktopCardTone | undefined {
  if (item.toneMap && raw !== undefined && raw !== null) {
    const mapped = normalizeTone(item.toneMap[typeof raw === 'string' ? raw : JSON.stringify(raw)]);
    if (mapped) return mapped;
  }
  if (item.signTone) {
    const numeric = toFiniteNumber(raw);
    if (numeric !== null && numeric > 0) return 'success';
    if (numeric !== null && numeric < 0) return 'danger';
    if (numeric === 0) return 'neutral';
  }
  return normalizeTone(item.tone);
}

export function formatMetricValue(item: DesktopCardMetricItem, raw: unknown, formatters: DesktopCardFormatters): string {
  if (raw === undefined || raw === null || raw === '') return '—';
  const digits = typeof item.digits === 'number' ? Math.min(Math.max(Math.trunc(item.digits), 0), 8) : undefined;
  const digitOptions: Intl.NumberFormatOptions = digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  let text: string;
  const numeric = toFiniteNumber(raw);
  switch (item.format) {
    case 'number':
      text = numeric === null ? String(raw) : formatters.formatNumber(numeric, digitOptions);
      break;
    case 'percent':
      text = numeric === null ? String(raw) : formatters.formatNumber(numeric / 100, { style: 'percent', ...digitOptions });
      break;
    case 'currency':
      text = numeric === null
        ? String(raw)
        : formatters.formatNumber(numeric, { style: 'currency', currency: item.currency || 'USD', ...digitOptions });
      break;
    case 'datetime': {
      const ms = toTimestampMs(raw);
      text = ms === null ? String(raw) : formatters.formatDate(ms, { dateStyle: 'medium', timeStyle: 'short' });
      break;
    }
    case 'relativeTime': {
      const ms = toTimestampMs(raw);
      text = ms === null ? String(raw) : formatters.formatRelativeTime(ms);
      break;
    }
    default:
      text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  }
  return `${item.prefix ?? ''}${text}${item.suffix ?? ''}`;
}

export function metricHint(item: DesktopCardMetricItem, data: unknown): string | undefined {
  if (item.hintPath !== undefined) {
    const hint = resolvePointer(data, item.hintPath);
    if (hint !== undefined && hint !== null && hint !== '') return typeof hint === 'object' ? JSON.stringify(hint) : String(hint);
  }
  return item.hint || undefined;
}

export interface ProgressState {
  value: number | null;
  max: number;
  ratio: number | null;
  status?: string;
}

export function progressState(
  template: Extract<DesktopCardTemplate, { kind: 'progress' }>,
  data: unknown,
): ProgressState {
  const value = toFiniteNumber(template.valuePath !== undefined ? resolvePointer(data, template.valuePath) : template.value);
  const resolvedMax = toFiniteNumber(template.maxPath !== undefined ? resolvePointer(data, template.maxPath) : template.max);
  const max = resolvedMax !== null && resolvedMax > 0 ? resolvedMax : 100;
  const statusRaw = template.statusPath !== undefined ? resolvePointer(data, template.statusPath) : template.status;
  const status = statusRaw === undefined || statusRaw === null || statusRaw === '' ? undefined : String(statusRaw);
  return {
    value,
    max,
    ratio: value === null ? null : Math.min(Math.max(value / max, 0), 1),
    status,
  };
}

export interface CountdownParts {
  remainingMs: number;
  due: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  elapsedRatio: number | null;
}

export function countdownParts(targetAtMs: number, startedAtMs: number | undefined, nowMs: number): CountdownParts {
  const remainingMs = Math.max(targetAtMs - nowMs, 0);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const span = startedAtMs !== undefined ? targetAtMs - startedAtMs : 0;
  return {
    remainingMs,
    due: remainingMs === 0,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    elapsedRatio: span > 0 ? Math.min(Math.max((nowMs - (startedAtMs as number)) / span, 0), 1) : null,
  };
}

/** Clock part of the remaining time; whole days are rendered separately with localized copy. */
export function formatCountdownClock(parts: CountdownParts): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return parts.hours > 0 || parts.days > 0
    ? `${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`
    : `${pad(parts.minutes)}:${pad(parts.seconds)}`;
}

export function isKnownChartStyle(style: unknown): style is DesktopCardChartStyle {
  return typeof style === 'string' && Object.prototype.hasOwnProperty.call(DESKTOP_CARD_CHART_LIMITS, style);
}

export interface ChartPoint {
  /** Raw label; format it with `formatChartLabel`. */
  label: string;
  value: number;
  tone?: DesktopCardTone;
  hint?: string;
  /** Items past the donut/stacked limit, merged into one "Other" part. */
  merged?: boolean;
}

export interface ChartSeries {
  points: ChartPoint[];
  sum: number;
  /** Valid whole the items belong to; never set for line charts. */
  total: number | null;
  /** Part of the total the items do not cover. */
  remainder: number;
  /** Denominator for bar lengths and segment shares. */
  scale: number;
}

function labelText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function optionalText(raw: unknown): string | undefined {
  const text = labelText(raw);
  return text === undefined || text.trim() === '' ? undefined : text;
}

/** Reads static items, or the array at `itemsPath` (numbers, `[label, value]` pairs, or objects). */
function readChartPoints(template: DesktopCardChartTemplate, data: unknown): ChartPoint[] {
  if (template.itemsPath === undefined) {
    return (Array.isArray(template.items) ? template.items : []).flatMap(item => {
      const value = toFiniteNumber(item?.value);
      if (value === null) return [];
      return [{ label: labelText(item.label) ?? '', value, tone: normalizeTone(item.tone), hint: optionalText(item.hint) }];
    });
  }
  const rows = resolvePointer(data, template.itemsPath);
  if (!Array.isArray(rows)) return [];
  const labels = template.labelsPath !== undefined ? resolvePointer(data, template.labelsPath) : undefined;
  const labelAt = (index: number) => (Array.isArray(labels) ? labelText(labels[index]) : undefined) ?? String(index + 1);
  const labelKey = template.labelKey ?? 'label';
  const valueKey = template.valueKey ?? 'value';
  const hintKey = template.hintKey ?? 'hint';
  return rows.flatMap((row, index): ChartPoint[] => {
    if (Array.isArray(row)) {
      const value = toFiniteNumber(row[1]);
      return value === null ? [] : [{ label: labelText(row[0]) ?? labelAt(index), value }];
    }
    if (row !== null && typeof row === 'object') {
      const record = row as Record<string, unknown>;
      const value = toFiniteNumber(record[valueKey]);
      if (value === null) return [];
      return [{
        label: labelText(record[labelKey]) ?? labelAt(index),
        value,
        tone: normalizeTone(record.tone),
        hint: optionalText(record[hintKey]),
      }];
    }
    const value = toFiniteNumber(row);
    return value === null ? [] : [{ label: labelAt(index), value }];
  });
}

/**
 * Points to draw, trimmed to the style's limit: line charts keep the latest
 * points, donut and stacked charts merge the rest into one part, and the other
 * styles keep the first items.
 */
export function chartSeries(template: DesktopCardChartTemplate, data: unknown, otherLabel: string): ChartSeries {
  const style = isKnownChartStyle(template.chart) ? template.chart : 'bar';
  const limit = DESKTOP_CARD_CHART_LIMITS[style];
  let points = readChartPoints(template, data);
  if (style !== 'line') points = points.map(point => (point.value < 0 ? { ...point, value: 0 } : point));
  if (points.length > limit) {
    if (style === 'line') {
      points = points.slice(-limit);
    } else if (style === 'donut' || style === 'stacked') {
      const rest = points.slice(limit - 1);
      points = [
        ...points.slice(0, limit - 1),
        { label: otherLabel, value: rest.reduce((sum, point) => sum + point.value, 0), merged: true },
      ];
    } else {
      points = points.slice(0, limit);
    }
  }
  const sum = points.reduce((total, point) => total + point.value, 0);
  const rawTotal = toFiniteNumber(template.totalPath !== undefined ? resolvePointer(data, template.totalPath) : template.total);
  const total = style !== 'line' && rawTotal !== null && rawTotal > 0 ? rawTotal : null;
  const remainder = total !== null && total > sum ? total - sum : 0;
  const largest = points.reduce((max, point) => Math.max(max, point.value), 0);
  const scale = style === 'donut' || style === 'stacked'
    ? Math.max(total ?? 0, sum)
    : Math.max(total ?? 0, largest);
  return { points, sum, total, remainder, scale };
}

/** Share of `scale` in [0, 1]; 0 when there is nothing to scale against. */
export function chartShare(value: number, scale: number): number {
  return scale > 0 ? Math.min(Math.max(value / scale, 0), 1) : 0;
}

export function formatChartValue(template: DesktopCardChartTemplate, value: number, formatters: DesktopCardFormatters): string {
  return formatMetricValue({
    label: '',
    format: template.format ?? 'number',
    digits: template.digits,
    currency: template.currency,
    prefix: template.prefix,
    suffix: template.suffix,
  }, value, formatters);
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar dates such as `2026-03-17` are local days, not UTC midnight. */
function labelTimestampMs(label: string): number | null {
  const dateOnly = DATE_ONLY_PATTERN.exec(label.trim());
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
  return toTimestampMs(label);
}

const LABEL_DATE_OPTIONS: Record<string, Intl.DateTimeFormatOptions> = {
  date: { month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
  weekday: { weekday: 'short' },
  datetime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
};

export function formatChartLabel(template: DesktopCardChartTemplate, label: string, formatters: DesktopCardFormatters): string {
  const options = template.labelFormat ? LABEL_DATE_OPTIONS[template.labelFormat] : undefined;
  if (!options || label.trim() === '') return label;
  const ms = labelTimestampMs(label);
  return ms === null ? label : formatters.formatDate(ms, options);
}

export interface LineGeometry {
  /** SVG polyline points in a 100 x 40 view box. */
  line: string;
  /** Closed SVG path under the line. */
  area: string;
  min: number;
  max: number;
  first: number;
  last: number;
}

export function lineGeometry(points: readonly ChartPoint[]): LineGeometry | null {
  if (points.length < 2) return null;
  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const coordinates = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = span > 0 ? 38 - ((value - min) / span) * 36 : 20;
    return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
  });
  return {
    line: coordinates.join(' '),
    area: `M0,40 L${coordinates.join(' L')} L100,40 Z`,
    min,
    max,
    first: values[0],
    last: values[values.length - 1],
  };
}

export function isSafeWebLink(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
