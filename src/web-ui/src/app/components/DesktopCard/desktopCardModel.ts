import type {
  DesktopCardMetricItem,
  DesktopCardRecord,
  DesktopCardTemplate,
  DesktopCardTone,
} from '@/infrastructure/api/service-api/DesktopCardAPI';

export const DESKTOP_CARD_TONES: readonly DesktopCardTone[] = ['neutral', 'accent', 'info', 'success', 'warning', 'danger'];
const KNOWN_TEMPLATE_KINDS = new Set(['countdown', 'checklist', 'note', 'progress', 'metrics', 'cronJob', 'custom']);

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

export function isSafeWebLink(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
