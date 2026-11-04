import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Children, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic';
import { ImageIcon } from 'lucide-react';
import { i18nService } from '@/infrastructure/i18n';
import type { GenUIComponentImplementation, GenUIComponentProps, GenUIImplementations } from '../genUILibrary';
import { sanitizeGenUIHtmlSource } from '../GenUIHtmlDocument';
import type { GenUIAsyncRuntime, GenUIAsyncExecuteOptions } from '../genUIAsyncCapabilities';
import { isAbortError } from '../genUIAsyncCapabilities';
import MapView from './map/MapView';

const str = (value: unknown) => value == null ? '' : String(value);
const node = (value: unknown) => Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'element');
const safeUrl = (value: unknown) => { try { const url = new URL(str(value)); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; } };
const inlineText = (value: string): ReactNode => {
  const pieces: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^\s)]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push(value.slice(cursor, start));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) pieces.push(<strong key={`${start}-bold`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) pieces.push(<code key={`${start}-code`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('*') || token.startsWith('_')) pieces.push(<em key={`${start}-italic`}>{token.slice(1, -1)}</em>);
    else {
      const parts = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(token);
      const href = parts ? safeUrl(parts[2]) : '';
      pieces.push(href ? <a key={`${start}-link`} href={href} target="_blank" rel="noopener noreferrer">{parts?.[1]}</a> : token);
    }
    cursor = start + token.length;
  }
  if (cursor < value.length) pieces.push(value.slice(cursor));
  return pieces.length ? pieces : value;
};
const render = (value: unknown, renderNode: GenUIComponentProps['renderNode']): ReactNode => {
  if (node(value)) return renderNode(value);
  if (Array.isArray(value)) return value.flat().map((part, index) => <span key={index}>{render(part, renderNode)}</span>);
  return inlineText(str(value));
};
const inspect = () => true;
const define = (renderFn: GenUIComponentImplementation['render'], exercise?: GenUIComponentImplementation['exercise']): GenUIComponentImplementation => ({ render: renderFn, inspect, ...(exercise ? { exercise } : {}) });
const options = (value: unknown): Array<{ value: string; label: string; description?: string }> => Array.isArray(value) ? value.flat().filter(Boolean).map(item => typeof item === 'string' ? { value: item, label: item } : item as { value: string; label: string; description?: string }) : [];
const controlOptions = (value: unknown, name: string) => {
  const parsed = options(value);
  if (parsed.some(option => !option.value) || new Set(parsed.map(option => option.value)).size !== parsed.length) throw new Error(`${name} requires unique options`);
  return parsed;
};
const COLOR_TOKENS: Record<string, string> = {
  ink: 'var(--openbitfun-color-content-primary)',
  muted: 'var(--openbitfun-color-content-secondary)',
  faint: 'var(--openbitfun-color-content-secondary)',
  primary: 'var(--openbitfun-color-accent-default)',
  accent: 'var(--openbitfun-color-accent-default)',
  border: 'var(--openbitfun-color-border-default)',
  canvas: 'var(--openbitfun-color-surface-canvas)',
  surface: 'var(--openbitfun-color-surface-panel)',
  info: 'var(--openbitfun-color-status-info-content)',
  success: 'var(--openbitfun-color-status-success-content)',
  warning: 'var(--openbitfun-color-status-warning-content)',
  danger: 'var(--openbitfun-color-status-danger-content)',
  purple: 'var(--openbitfun-color-accent-default)',
  pink: 'var(--openbitfun-color-accent-default)',
};
const color = (value: unknown) => typeof value === 'string' ? COLOR_TOKENS[value] ?? value : undefined;
const length = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return `${Math.max(0, value)}px`;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d+(?:\.\d+)?(?:px|%|em|rem|vh|vw|fr)$|^auto$/.test(trimmed) ? trimmed : undefined;
};
const radius = (value: unknown) => typeof value === 'string'
  ? ({ sm: '6px', md: '10px', lg: '14px', xl: '18px', full: '999px' }[value] ?? value)
  : length(value);
const space = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? `${Math.max(0, value) * 4}px` : undefined;
const paint = (view: GenUIComponentProps['view']) => ({ fill: color(view.props.fill), stroke: color(view.props.stroke), strokeWidth: typeof view.props.strokeWidth === 'number' ? view.props.strokeWidth : undefined, opacity: typeof view.props.opacity === 'number' ? Math.max(0, Math.min(1, view.props.opacity)) : undefined });

const lucideNames = new Set<string>(iconNames);
function normalizedIconName(value: unknown): IconName | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
  return lucideNames.has(normalized) ? normalized as IconName : null;
}

function Layout({ view, slots }: GenUIComponentProps) {
  const props = view.props;
  const direction = props.direction === 'row' ? 'row' : 'column';
  const style: CSSProperties = { gap: space(props.gap), padding: space(props.padding), alignItems: props.align === 'start' ? 'flex-start' : props.align === 'end' ? 'flex-end' : props.align === 'center' ? 'center' : props.align === 'stretch' ? 'stretch' : undefined, justifyContent: props.justify === 'between' ? 'space-between' : props.justify === 'start' ? 'flex-start' : props.justify === 'end' ? 'flex-end' : props.justify === 'center' ? 'center' : undefined, flexWrap: props.wrap ? 'wrap' : undefined, background: color(props.background), borderRadius: radius(props.radius), overflow: props.radius !== undefined ? 'clip' : undefined, border: props.border ? '1px solid var(--openbitfun-color-border-default)' : undefined, width: length(props.width), height: length(props.height), flex: typeof props.flex === 'number' ? `${Math.max(0, props.flex)} 1 0%` : typeof props.width === 'number' ? '0 0 auto' : undefined };
  return <div className={`gen-ui-oi-box ${direction === 'row' ? 'gen-ui-oi-row' : 'gen-ui-oi-col'} ${direction === 'column' && props.gap == null ? 'gen-ui-oi-flow' : ''}`} data-openbitfun-component="gen-ui-components" data-openbitfun-part="layout" style={style}>{slots.children}</div>;
}

function imageUrls(value: unknown): string[] {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const nested = record && Array.isArray(record.results) ? record.results : [];
  const providerBuckets = record
    ? ['wiki', 'imageSearch', 'image_search', 'search'].flatMap(key => {
      const bucket = record[key];
      if (!bucket || typeof bucket !== 'object') return [];
      const nestedRecord = bucket as Record<string, unknown>;
      return [
        ...(Array.isArray(nestedRecord.photos) ? nestedRecord.photos : []),
        ...(Array.isArray(nestedRecord.images) ? nestedRecord.images : []),
        ...(Array.isArray(nestedRecord.results) ? nestedRecord.results : []),
      ];
    })
    : [];
  const values = Array.isArray(value) ? value : record
    ? [
      ...(Array.isArray(record.images) ? record.images : []),
      ...(Array.isArray(record.photos) ? record.photos : []),
      ...(Array.isArray(record.urls) ? record.urls : []),
      ...nested,
      ...providerBuckets,
      record.src,
      record.url,
      record.image_url,
    ]
    : [value];
  const normalized = values.flatMap(item => item && typeof item === 'object' ? [
    (item as Record<string, unknown>).src,
    (item as Record<string, unknown>).url,
    (item as Record<string, unknown>).image_url,
    (item as Record<string, unknown>).imageUrl,
    (item as Record<string, unknown>).thumbnail,
    (item as Record<string, unknown>).thumbnailUrl,
    (item as Record<string, unknown>).original,
    (item as Record<string, unknown>).originalUrl,
  ] : [item]);
  return [...new Set(normalized.filter((item): item is string => typeof item === 'string' && Boolean(safeUrl(item))))];
}
// Provider results can be host- or target-specific, so cache only within the
// owning async runtime rather than sharing URLs between sessions or peers.
const imageResultCaches = new WeakMap<object, Map<string, string[]>>();
function imageResultCacheFor(runtime: GenUIAsyncRuntime): Map<string, string[]> {
  const owner = runtime as object;
  let cache = imageResultCaches.get(owner);
  if (!cache) {
    cache = new Map<string, string[]>();
    imageResultCaches.set(owner, cache);
  }
  return cache;
}
function useSearchImage(query: string, explicit: string | undefined, asyncRuntime?: GenUIAsyncRuntime) {
  const [fallbackQuery, setFallbackQuery] = useState('');
  const [state, setState] = useState<{ query: string; candidates: string[]; failed: string[]; loading?: boolean; error?: string }>({ query: '', candidates: [], failed: [] });
  useEffect(() => {
    const candidate = safeUrl(explicit);
    if (!query.trim()) { setState({ query, candidates: [], failed: [] }); return undefined; }
    const shouldSearch = !candidate || fallbackQuery === query;
    if (!shouldSearch) {
      setState({ query, candidates: [candidate], failed: [] });
      return undefined;
    }
    const controller = new AbortController();
    const runtime = asyncRuntime;
    const imageCapability = runtime?.can('image.search') ? 'image.search' : runtime?.can('SearchImage') ? 'SearchImage' : undefined;
    if (!runtime || !imageCapability) {
      setState({ query, candidates: candidate ? [candidate] : [], failed: [], error: 'Image search is unavailable on this host' });
      return () => controller.abort('Image search effect was replaced');
    }
    const imageResultCache = imageResultCacheFor(runtime);
    const cached = imageResultCache.get(query);
    if (cached?.length) {
      setState({ query, candidates: cached, failed: [] });
      return undefined;
    }
    setState({ query, candidates: candidate ? [candidate] : [], failed: [], loading: true });
    const timer = window.setTimeout(() => {
      const options: GenUIAsyncExecuteOptions = { kind: 'image-search', signal: controller.signal };
      void runtime.execute(imageCapability, { query }, options).then(result => {
        if (!controller.signal.aborted) {
          const candidates = imageUrls(result);
          if (candidates.length) {
            if (imageResultCache.size >= 200) imageResultCache.delete(imageResultCache.keys().next().value!);
            imageResultCache.set(query, candidates);
          }
          setState({ query, candidates, failed: [], error: candidates.length ? undefined : 'No image found' });
        }
      }).catch(error => {
        if (!controller.signal.aborted && !isAbortError(error)) setState({ query, candidates: [], failed: [], error: error instanceof Error ? error.message : String(error) });
      });
    }, 500);
    return () => { controller.abort('Image query was replaced'); window.clearTimeout(timer); };
  }, [asyncRuntime, explicit, fallbackQuery, query]);
  const current = state.query === query ? state.candidates.find(src => !state.failed.includes(src)) : undefined;
  const onError = current ? () => {
    const shouldFallback = state.query === query
      && state.candidates.filter(src => !state.failed.includes(src)).length <= 1
      && Boolean(safeUrl(explicit))
      && fallbackQuery !== query;
    if (shouldFallback) setFallbackQuery(query);
    setState(previous => {
      if (previous.query !== query || previous.failed.includes(current)) return previous;
      const failed = [...previous.failed, current];
      if (previous.candidates.some(src => !failed.includes(src))) return { ...previous, failed };
      if (shouldFallback) return { ...previous, failed, loading: true, error: undefined };
      return { ...previous, failed, error: 'Image could not be loaded' };
    });
  } : undefined;
  return { src: current, onError, loading: state.query === query && state.loading === true, error: state.query === query ? state.error : undefined };
}
function ImageView({ view, asyncRuntime }: Pick<GenUIComponentProps, 'view' | 'asyncRuntime'>) {
  const alt = str(view.props.alt ?? view.props.query);
  const image = useSearchImage(str(view.props.query ?? alt), str(view.props.src), asyncRuntime);
  const aspectRatio = typeof view.props.aspectRatio === 'number' && view.props.aspectRatio > 0.2 && view.props.aspectRatio < 5 ? view.props.aspectRatio : 1.5;
  return <figure className="gen-ui-oi-image" data-openbitfun-component="gen-ui-components" data-openbitfun-part="media" data-gen-ui-loading={image.loading || undefined} data-gen-ui-error={image.error || undefined} style={{ aspectRatio, borderRadius: radius(view.props.radius ?? 'lg') }}>
    {image.src ? <img src={image.src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={image.onError} style={{ objectFit: view.props.fit === 'contain' ? 'contain' : 'cover' }} /> : image.loading ? null : <div className="gen-ui-oi-image-empty" role="img" aria-label={alt}><ImageIcon aria-hidden strokeWidth={1.5} /></div>}
    <figcaption>{view.props.caption ? inlineText(str(view.props.caption)) : image.error ? image.error : null}</figcaption>
  </figure>;
}

type ChartRow = Record<string, unknown>;
const NUMERIC_TABLE_CELL = /^[-+−]?[$€£¥₹]?\s?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB]|bn)?$/;
const isNumericTableCell = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && !/^(n\/a|—|–|-)$/i.test(value.trim()) && NUMERIC_TABLE_CELL.test(value.trim()));
const chartNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
const CHART_COLORS = [
  'var(--openbitfun-color-accent-default)',
  'var(--openbitfun-color-status-warning-content)',
  'var(--openbitfun-color-status-success-content)',
  'var(--openbitfun-color-status-info-content)',
  'var(--openbitfun-color-status-danger-content)',
  'var(--openbitfun-color-content-primary)',
] as const;
const chartColor = (index: number) => CHART_COLORS[index % CHART_COLORS.length];
function chartFormat(value: number, kind: unknown, currency: unknown, compact = false) {
  if (kind === 'percent') return `${Number(value.toFixed(compact ? 1 : 2))}%`;
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD';
  const options: Intl.NumberFormatOptions = { maximumFractionDigits: compact ? 1 : 2, notation: compact && Math.abs(value) >= 1000 ? 'compact' : 'standard' };
  return i18nService.formatNumber(value, kind === 'currency' ? { ...options, style: 'currency', currency: code } : options);
}
function chartAxis(values: number[]) {
  const min = Math.min(0, ...values), max = Math.max(1, ...values), step = (max - min || 1) / 4;
  return { min, max, step };
}
function ChartView({ view }: Pick<GenUIComponentProps, 'view'>) {
  const containerRef = useRef<HTMLElement>(null);
  const [containerWidth, setContainerWidth] = useState(640);
  useLayoutEffect(() => {
    const measure = () => {
      const measured = containerRef.current?.clientWidth;
      if (measured) setContainerWidth(Math.max(280, Math.min(720, measured)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined' || !containerRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  const data = Array.isArray(view.props.data) ? view.props.data.filter((row): row is ChartRow => Boolean(row && typeof row === 'object' && !Array.isArray(row))) : [];
  const type = ['bar', 'line', 'area', 'pie', 'donut', 'scatter'].includes(str(view.props.type)) ? str(view.props.type) : 'bar';
  const first = data[0] ?? {};
  const keys = Object.keys(first);
  const x = typeof view.props.x === 'string' && keys.includes(view.props.x) ? view.props.x : keys[0] ?? 'x';
  const series = Array.isArray(view.props.series) && view.props.series.length ? view.props.series.map(String) : keys.filter(key => key !== x && data.some(row => typeof row[key] === 'number'));
  const stacked = view.props.stacked === true && type !== 'line';
  const width = containerWidth;
  const height = typeof view.props.height === 'number' ? Math.min(480, Math.max(150, view.props.height)) : 240;
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length || !series.length) return <figure ref={containerRef} className="gen-ui-oi-chart" data-chart-type={type}><div style={{ minHeight: height }} /></figure>;
  if (type === 'pie' || type === 'donut') {
    const valueKey = series[0];
    const values = data.map(row => Math.max(0, chartNumber(row[valueKey])));
    const total = values.reduce((sum, value) => sum + value, 0) || 1;
    const cx = 130, cy = 120, radius = 92, inner = type === 'donut' ? 54 : 0;
    let angle = -Math.PI / 2;
    const point = (r: number, a: number) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
    return <figure ref={containerRef} className="gen-ui-oi-chart" data-chart-type={type}><svg viewBox="0 0 260 240" role="img" aria-label={`${type} chart`}>{values.map((value, index) => { const sweep = value / total * Math.PI * 2; const start = angle; angle += sweep; const end = angle; if (sweep > Math.PI * 2 - 0.001) return <circle key={index} cx={cx} cy={cy} r={inner ? (radius + inner) / 2 : radius} fill={inner ? 'none' : chartColor(index)} stroke={inner ? chartColor(index) : undefined} strokeWidth={inner ? radius - inner : undefined} />; const large = sweep > Math.PI ? 1 : 0; const path = inner ? `M${point(radius, start)}A${radius},${radius} 0 ${large} 1 ${point(radius, end)}L${point(inner, end)}A${inner},${inner} 0 ${large} 0 ${point(inner, start)}Z` : `M${cx},${cy}L${point(radius, start)}A${radius},${radius} 0 ${large} 1 ${point(radius, end)}Z`; return <path key={index} d={path} fill={chartColor(index)} stroke="var(--openbitfun-color-surface-panel)" strokeWidth="2"><title>{`${str(data[index][x])}: ${chartFormat(value, view.props.format, view.props.currency)}`}</title></path>; })}</svg><div className="gen-ui-oi-chart-legend">{data.map((row, index) => <span key={index}><i style={{ background: chartColor(index) }} />{str(row[x])} <b>{Math.round(values[index] / total * 1000) / 10}%</b></span>)}</div></figure>;
  }
  const tops = data.map(row => {
    let total = 0;
    return series.map(key => total += Math.max(0, chartNumber(row[key])));
  });
  const allValues = stacked ? tops.map(values => values.at(-1) ?? 0) : data.flatMap(row => series.map(key => chartNumber(row[key])));
  const axis = chartAxis(allValues);
  const pad = { top: 14, right: 12, bottom: 34, left: 58 };
  const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
  const xAt = (index: number) => pad.left + plotW * (data.length === 1 ? 0.5 : index / (data.length - 1));
  const yAt = (value: number) => pad.top + plotH - ((value - axis.min) / (axis.max - axis.min || 1)) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  const scatterX = (row: ChartRow, index: number) => typeof row[x] === 'number' ? chartNumber(row[x]) : index;
  const scatterValues = data.map(scatterX);
  const scatterAxis = type === 'scatter' ? chartAxis(scatterValues) : axis;
  const scatterXAt = (value: number) => pad.left + ((value - scatterAxis.min) / (scatterAxis.max - scatterAxis.min || 1)) * plotW;
  return <figure ref={containerRef} className="gen-ui-oi-chart" data-chart-type={type}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${type} chart`} onMouseLeave={() => setHover(null)}>{[0, 1, 2, 3, 4].map(tick => { const value = axis.min + (axis.max - axis.min) * tick / 4; return <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={yAt(value)} y2={yAt(value)} className="gen-ui-oi-chart-grid" /><text x={pad.left - 8} y={yAt(value) + 4} textAnchor="end">{chartFormat(value, view.props.format, view.props.currency, true)}</text></g>; })}{data.map((row, index) => index % labelEvery === 0 ? <text key={`label-${index}`} x={type === 'scatter' ? scatterXAt(scatterX(row, index)) : xAt(index)} y={height - 10} textAnchor="middle">{str(row[x])}</text> : null)}{type === 'bar' && data.map((row, index) => { const groupW = plotW / Math.max(1, data.length); const inner = Math.min(groupW * 0.7, 72 * Math.max(1, stacked ? 1 : series.length)); if (stacked) return series.map((key, seriesIndex) => { const top = yAt(tops[index][seriesIndex]); const base = yAt(tops[index][seriesIndex - 1] ?? 0); return <rect key={`${index}-${key}`} x={xAt(index) - inner / 2} y={top} width={inner} height={Math.max(0, base - top)} rx={seriesIndex === series.length - 1 ? 4 : 0} fill={chartColor(seriesIndex)} onMouseEnter={() => setHover(index)} />; }); const barW = Math.max(4, inner / series.length); return series.map((key, seriesIndex) => { const value = chartNumber(row[key]); const xPos = xAt(index) - inner / 2 + seriesIndex * barW; return <rect key={`${index}-${key}`} x={xPos + 1} y={Math.min(yAt(value), yAt(0))} width={Math.max(1, barW - 2)} height={Math.abs(yAt(0) - yAt(value))} rx="4" fill={chartColor(seriesIndex)} onMouseEnter={() => setHover(index)} />; }); })}{(type === 'line' || type === 'area') && series.map((key, seriesIndex) => { const top = (index: number) => stacked ? tops[index][seriesIndex] : chartNumber(data[index][key]); const base = (index: number) => stacked ? (tops[index][seriesIndex - 1] ?? 0) : 0; const points = data.map((_, index) => `${xAt(index)},${yAt(top(index))}`).join(' '); const under = data.map((_, index) => `${xAt(index)},${yAt(base(index))}`).reverse().join(' '); return <g key={key}>{type === 'area' ? <path d={`M${points} L${under} Z`} fill={chartColor(seriesIndex)} opacity={stacked ? '.24' : '.18'} /> : null}<polyline points={points} fill="none" stroke={chartColor(seriesIndex)} strokeWidth="2.5" onMouseEnter={() => setHover(null)} />{data.map((_, index) => <circle key={index} cx={xAt(index)} cy={yAt(top(index))} r={hover === index ? 5 : 3} fill={chartColor(seriesIndex)} onMouseEnter={() => setHover(index)} />)}</g>; })}{type === 'scatter' && series.map((key, seriesIndex) => data.map((row, index) => <circle key={`${key}-${index}`} cx={scatterXAt(scatterX(row, index))} cy={yAt(chartNumber(row[key]))} r={hover === index ? 6 : 4} fill={chartColor(seriesIndex)} onMouseEnter={() => setHover(index)} />))}</svg>{hover !== null ? <div className="gen-ui-oi-chart-tooltip"><strong>{str(data[hover]?.[x])}</strong>{series.map(key => <span key={key}>{key}: {chartFormat(chartNumber(data[hover]?.[key]), view.props.format, view.props.currency)}</span>)}</div> : null}<div className="gen-ui-oi-chart-legend">{series.length > 1 ? series.map((key, index) => <span key={key}><i style={{ background: chartColor(index) }} />{key}</span>) : null}</div></figure>;
}

const inputExercise = (selector: string, event: string, value: unknown, element: HTMLElement) => { const input = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector); if (event !== 'change' || !input || input.disabled) throw new Error('OpenUI input is unavailable'); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set; setter?.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };

export const oiComponents: GenUIImplementations['components'] = {
  Col: define(({ slots, view }) => <div className={`gen-ui-oi-col ${view.props.gap == null ? 'gen-ui-oi-flow' : ''}`} data-openbitfun-component="gen-ui-components" data-openbitfun-part="root" style={{ gap: space(view.props.gap), alignItems: view.props.align === 'start' ? 'flex-start' : view.props.align === 'end' ? 'flex-end' : view.props.align === 'center' ? 'center' : view.props.align === 'stretch' ? 'stretch' : undefined }}>{slots.children}</div>),
  Row: define(({ slots, view }) => <div className="gen-ui-oi-row" style={{ gap: space(view.props.gap), justifyContent: view.props.justify === 'between' ? 'space-between' : view.props.justify === 'start' ? 'flex-start' : view.props.justify === 'end' ? 'flex-end' : view.props.justify === 'center' ? 'center' : undefined, alignItems: view.props.align === 'start' ? 'flex-start' : view.props.align === 'end' ? 'flex-end' : view.props.align === 'center' ? 'center' : view.props.align === 'stretch' ? 'stretch' : undefined, flexWrap: view.props.wrap ? 'wrap' : undefined }}>{slots.children}</div>),
  Box: define(Layout),
  Grid: define(({ slots, view }) => { const columns = Math.max(1, Math.min(12, Math.round(Number(view.props.columns ?? 2)))); const gap = space(view.props.gap) ?? '12px'; const min = typeof view.props.minChildWidth === 'number' ? `minmax(min(100%, ${Math.max(0, view.props.minChildWidth)}px), 1fr)` : 'minmax(0, 1fr)'; return <div className="gen-ui-oi-grid" style={{ gridTemplateColumns: `repeat(${view.props.minChildWidth ? 'auto-fit' : columns}, ${min})`, gap }}>{slots.children}</div>; }),
  Card: define(({ slots, view }) => <section className={`gen-ui-oi-card ${view.props.variant === 'soft' ? 'is-soft' : ''} ${view.props.gap == null ? 'gen-ui-oi-flow' : ''}`} data-openbitfun-component="gen-ui-components" data-openbitfun-part="content" style={{ padding: space(view.props.padding), gap: space(view.props.gap) }}>{slots.children}</section>),
  Carousel: define(({ slots, view }) => { const itemWidth = typeof view.props.itemWidth === 'number' ? Math.min(640, Math.max(80, view.props.itemWidth)) : 240; return <div className="gen-ui-oi-carousel" style={{ gap: typeof view.props.gap === 'number' ? view.props.gap * 4 : undefined }}>{Children.toArray(slots.children).map((child, index) => <div key={index} className="gen-ui-oi-carousel-item" style={{ flex: `0 0 ${itemWidth}px`, width: itemWidth }}>{child}</div>)}</div>; }),
  Popover: define(({ view, renderNode }) => {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number; up: boolean } | null>(null);
    useLayoutEffect(() => {
      if (!open || !trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const up = rect.bottom + 240 > window.innerHeight && rect.top > 240;
      setPosition({ left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - 312)), top: up ? rect.top - 8 : rect.bottom + 8, up });
    }, [open]);
    useEffect(() => {
      if (!open) return;
      const close = (event: Event) => {
        const target = event.target as Node;
        if (event.type === 'keydown' ? (event as KeyboardEvent).key === 'Escape' : !trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
      };
      const onScroll = () => setOpen(false);
      document.addEventListener('pointerdown', close);
      document.addEventListener('keydown', close);
      window.addEventListener('scroll', onScroll, true);
      return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('scroll', onScroll, true); };
    }, [open]);
    return <><button ref={trigger} type="button" className="gen-ui-oi-popover-trigger" aria-expanded={open} onClick={() => setOpen(value => !value)}>{render(view.props.trigger, renderNode)}</button>{open && position && typeof document !== 'undefined' ? createPortal(<div ref={panel} role="dialog" className="gen-ui-oi-popover-content" style={{ left: position.left, top: position.top, transform: position.up ? 'translateY(-100%)' : undefined }}>{render(view.props.content, renderNode)}</div>, getAppearanceOverlayHost()) : null}</>;
  }),
  Divider: define(() => <hr className="gen-ui-oi-divider" />),
  Spacer: define(() => <div className="gen-ui-oi-spacer" aria-hidden="true" />),
  Title: define(({ view, renderNode }) => { const sizeName = String(view.props.size ?? 'md'); const level = ({ '3xl': 1, '2xl': 2, xl: 2, lg: 2, md: 3, sm: 4 } as Record<string, number>)[sizeName] ?? 3; return <div role="heading" aria-level={level} className={`gen-ui-oi-title gen-ui-oi-title-${sizeName}`} style={{ color: color(view.props.color) }}>{render(view.props.text, renderNode)}</div>; }),
  Text: define(({ view, renderNode }) => <p className={`gen-ui-oi-text gen-ui-oi-text-${view.props.size ?? 'md'} ${view.props.maxLines ? 'gen-ui-oi-clamp' : ''}`} style={{ color: color(view.props.color), fontWeight: view.props.weight === 'semibold' ? 650 : view.props.weight === 'medium' ? 560 : undefined, fontStyle: view.props.italic ? 'italic' : undefined, textDecoration: view.props.lineThrough ? 'line-through' : undefined, fontVariantNumeric: view.props.tabularNums ? 'tabular-nums' : undefined, WebkitLineClamp: typeof view.props.maxLines === 'number' && view.props.maxLines > 0 ? Math.round(view.props.maxLines) : undefined }}>{render(view.props.text, renderNode)}</p>),
  Caption: define(({ view }) => <p className="gen-ui-oi-caption" style={{ color: color(view.props.color) }}>{str(view.props.text)}</p>),
  Label: define(({ view }) => <span className="gen-ui-oi-label">{str(view.props.text)}</span>),
  Badge: define(({ view }) => <span className={`gen-ui-oi-badge gen-ui-oi-badge-${view.props.color ?? 'neutral'}`}>{view.props.icon ? `${str(view.props.icon)} ` : ''}{str(view.props.text)}</span>),
  Link: define(({ view }) => { const href = safeUrl(view.props.url); return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="gen-ui-oi-link">{str(view.props.text) || href}</a> : <span>{str(view.props.text)}</span>; }),
  List: define(({ view, renderNode }) => { const marker = view.props.marker === 'number' ? 'number' : view.props.marker === 'none' ? 'none' : 'bullet'; const Tag = marker === 'number' ? 'ol' : 'ul'; const items = Array.isArray(view.props.items) ? view.props.items.flat() : []; const textMarkers = items.some(item => node(item) && typeof (item as { props?: Record<string, unknown> }).props?.marker === 'string' && String((item as { props: Record<string, unknown> }).props.marker).length > 2); return <Tag className={`gen-ui-oi-list gen-ui-oi-list-${marker} ${view.props.timeline ? 'is-timeline' : ''} ${textMarkers ? 'is-wide' : ''}`}>{items.map((item, index) => { const props = node(item) ? (item as { props: Record<string, unknown> }).props : undefined; const custom = typeof props?.marker === 'string' && props.marker ? props.marker : ''; const step = Boolean(custom && /^[0-9A-Za-z]{1,2}$/.test(custom)); const rich = Boolean(props?.description || props?.children); return <li key={index} className={rich ? 'is-rich' : undefined}><span className={`gen-ui-oi-list-marker ${step ? 'is-chip' : custom ? 'is-text' : ''}`} aria-hidden={custom ? undefined : true}>{step ? <span>{custom}</span> : custom || (marker === 'number' ? index + 1 : marker === 'bullet' ? '' : '')}</span>{node(item) ? renderNode(item) : <div className="gen-ui-oi-list-body">{inlineText(str(item))}</div>}</li>; })}</Tag>; }),
  ListItem: define(({ view, renderNode }) => <div className="gen-ui-oi-list-item"><div className="gen-ui-oi-list-title">{inlineText(str(view.props.title))}</div>{view.props.description ? <div className="gen-ui-oi-list-description">{inlineText(str(view.props.description))}</div> : null}{view.props.children ? <div className="gen-ui-oi-list-children">{render(view.props.children, renderNode)}</div> : null}</div>),
  Markdown: define(({ view }) => <div className="gen-ui-oi-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{str(view.props.text)}</ReactMarkdown></div>),
  Quote: define(({ view }) => <blockquote className="gen-ui-oi-quote"><p>{str(view.props.text)}</p>{view.props.cite ? <cite>{str(view.props.cite)}</cite> : null}</blockquote>),
  Code: define(({ view }) => {
    const [copied, setCopied] = useState(false);
    const code = str(view.props.code);
    const copy = () => { const pending = navigator.clipboard?.writeText(code); if (pending) void pending.then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); };
    return <div className="gen-ui-oi-code-block"><div className="gen-ui-oi-code-head"><span>{str(view.props.language) || 'code'}</span><button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div><pre className="gen-ui-oi-code"><code>{code}</code></pre></div>;
  }),
  Math: define(({ view }) => {
    const html = katex.renderToString(str(view.props.tex), { displayMode: !view.props.inline, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
    return view.props.inline ? <span className="gen-ui-oi-math-inline" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="gen-ui-oi-math" dangerouslySetInnerHTML={{ __html: html }} />;
  }),
  Button: define(({ view, emit, disabled, isStreaming }) => <button type="button" className={`gen-ui-oi-button gen-ui-oi-button-${view.props.variant ?? 'solid'} ${view.props.color ? `gen-ui-oi-button-${view.props.color}` : ''} ${view.props.size ? `gen-ui-oi-button-${view.props.size}` : ''} ${view.props.block ? 'is-block' : ''}`} data-openbitfun-component="gen-ui-components" data-openbitfun-part="control" disabled={disabled || Boolean(isStreaming) || Boolean(view.props.disabled)} onClick={() => emit('click')}>{view.props.icon ? `${str(view.props.icon)} ` : ''}{str(view.props.label)}</button>, (element, event) => { if (event !== 'click') throw new Error('Button event is unavailable'); element.querySelector('button')?.click(); }),
  IconButton: define(({ view, emit, disabled, isStreaming }) => <button type="button" className={`gen-ui-oi-icon-button gen-ui-oi-icon-button-${view.props.variant ?? 'outline'}`} aria-label={str(view.props.label || view.props.icon)} disabled={disabled || Boolean(isStreaming)} onClick={() => emit('click')}>{str(view.props.icon)}</button>, (element, event) => { if (event !== 'click') throw new Error('IconButton event is unavailable'); element.querySelector('button')?.click(); }),
  Pressable: define(({ view, slots, emit, disabled, isStreaming }) => <button type="button" className={`gen-ui-oi-pressable ${view.props.selected ? 'is-selected' : ''}`} style={{ padding: space(view.props.padding), background: color(view.props.background), borderRadius: radius(view.props.radius) }} disabled={disabled || Boolean(isStreaming)} aria-disabled={disabled || Boolean(isStreaming) || undefined} onClick={() => emit('click')}>{slots.children}</button>, (element, event) => { if (event !== 'click') throw new Error('Pressable event is unavailable'); element.querySelector('button')?.click(); }),
  Input: define(({ view, emit, disabled }) => { const numeric = view.props.type === 'number'; const [draft, setDraft] = useState<string | null>(null); const shown = draft ?? (view.props.value == null ? '' : String(view.props.value)); return <label className="gen-ui-oi-field"><span>{view.props.label ? str(view.props.label) : null}</span><input aria-label={view.props.label ? str(view.props.label) : undefined} type="text" inputMode={numeric ? 'decimal' : undefined} value={shown} placeholder={view.props.placeholder ? str(view.props.placeholder) : undefined} disabled={disabled} onChange={event => { const text = event.currentTarget.value; if (!numeric) { emit('change', text); return; } setDraft(text); const parsed = Number(text.replace(/,/g, '')); if (!text.trim()) emit('change', null); else if (Number.isFinite(parsed)) emit('change', parsed); }} onBlur={() => setDraft(null)} /></label>; }, (element, event, value) => inputExercise('input', event, value, element)),
  TextArea: define(({ view, emit, disabled }) => <label className="gen-ui-oi-field"><span>{view.props.label ? str(view.props.label) : null}</span><textarea aria-label={view.props.label ? str(view.props.label) : undefined} value={view.props.value == null ? '' : String(view.props.value)} placeholder={view.props.placeholder ? str(view.props.placeholder) : undefined} rows={typeof view.props.rows === 'number' ? view.props.rows : undefined} disabled={disabled} onChange={event => emit('change', event.currentTarget.value)} /></label>, (element, event, value) => inputExercise('textarea', event, value, element)),
  Select: define(({ view, emit, disabled }) => <label className="gen-ui-oi-field"><span>{view.props.label ? str(view.props.label) : null}</span><select aria-label={view.props.label ? str(view.props.label) : undefined} value={view.props.value == null ? '' : String(view.props.value)} disabled={disabled} onChange={event => emit('change', event.currentTarget.value)}>{view.props.placeholder ? <option value="">{str(view.props.placeholder)}</option> : null}{options(view.props.options).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>, (element, event, value) => { if (event !== 'change') throw new Error('Select event is unavailable'); const input = element.querySelector('select'); if (!input) throw new Error('Select is unavailable'); input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true })); }),
  SegmentedControl: define(({ view, emit, disabled }) => { const choices = controlOptions(view.props.options, 'SegmentedControl'); return <div className={`gen-ui-oi-segmented ${view.props.block ? 'is-block' : ''}`} role="radiogroup">{choices.map(option => <button type="button" role="radio" key={option.value} className={String(view.props.value) === option.value ? 'is-selected' : ''} aria-checked={String(view.props.value) === option.value} disabled={disabled} onClick={() => emit('change', option.value)}>{option.label}</button>)}</div>; }, (element, event, value) => { if (event !== 'change') throw new Error('SegmentedControl event is unavailable'); const button = Array.from(element.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(candidate => candidate.textContent === String(value)); button?.click(); }),
  Slider: define(({ view, emit, disabled }) => { const min = Number.isFinite(view.props.min as number) ? view.props.min as number : 0; const max = Number.isFinite(view.props.max as number) && (view.props.max as number) > min ? view.props.max as number : min + 100; const step = Number.isFinite(view.props.step as number) && (view.props.step as number) > 0 ? view.props.step as number : 1; const value = Number.isFinite(view.props.value as number) ? Math.min(max, Math.max(min, view.props.value as number)) : min; const unit = str(view.props.unit); const readout = /^[\p{Sc}]/u.test(unit) ? `${unit}${value}` : `${value}${unit}`; const marks = Array.isArray(view.props.marks) ? view.props.marks : []; return <div className="gen-ui-oi-slider">{view.props.label || unit ? <div className="gen-ui-oi-slider-head"><label>{view.props.label ? str(view.props.label) : 'Value'}</label><output>{readout}</output></div> : null}<input type="range" aria-label={view.props.label ? str(view.props.label) : 'Value'} min={min} max={max} step={step} value={value} disabled={disabled} onChange={event => emit('change', event.currentTarget.valueAsNumber)} />{marks.length ? <div className="gen-ui-oi-slider-marks" aria-hidden="true">{marks.map((mark, index) => { const raw = mark as Record<string, unknown>; const markValue = Number(raw.value); const left = Number.isFinite(markValue) ? `${Math.max(0, Math.min(100, (markValue - min) / (max - min) * 100))}%` : `${index / Math.max(1, marks.length - 1) * 100}%`; return <span key={index} style={{ left }}>{str(raw.label)}</span>; })}</div> : null}</div>; }, (element, event, value) => { if (event !== 'change') throw new Error('Slider event is unavailable'); const input = element.querySelector<HTMLInputElement>('input[type="range"]'); if (!input) throw new Error('Slider is unavailable'); input.value = String(value); input.dispatchEvent(new Event('change', { bubbles: true })); }),
  Checkbox: define(({ view, emit, disabled }) => <label className="gen-ui-oi-check"><input type="checkbox" checked={view.props.checked === true} disabled={disabled} onChange={event => emit('change', event.currentTarget.checked)} /><span style={{ textDecoration: view.props.checked && view.props.lineThrough ? 'line-through' : undefined }}>{str(view.props.label)}</span></label>, (element, event, value) => { if (event !== 'change') throw new Error('Checkbox event is unavailable'); const input = element.querySelector<HTMLInputElement>('input'); if (!input) throw new Error('Checkbox is unavailable'); input.checked = Boolean(value); input.dispatchEvent(new Event('change', { bubbles: true })); }),
  RadioGroup: define(({ view, emit, disabled }) => { const name = `radio-${view.key}`; return <fieldset className="gen-ui-oi-radio"><legend>{view.props.label ? str(view.props.label) : null}</legend>{options(view.props.options).map(option => <label key={option.value}><input type="radio" name={name} value={option.value} checked={String(view.props.value) === option.value} disabled={disabled} onChange={() => emit('change', option.value)} /><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</label>)}</fieldset>; }, (element, event, value) => { if (event !== 'change') throw new Error('RadioGroup event is unavailable'); const input = Array.from(element.querySelectorAll<HTMLInputElement>('input')).find(candidate => candidate.value === String(value)); input?.click(); }),
  DatePicker: define(({ view, emit, disabled }) => <label className="gen-ui-oi-field"><span>{view.props.label ? str(view.props.label) : null}</span><input type="date" value={str(view.props.value)} min={view.props.min ? str(view.props.min) : undefined} max={view.props.max ? str(view.props.max) : undefined} disabled={disabled} onChange={event => emit('change', event.currentTarget.value)} /></label>, (element, event, value) => inputExercise('input[type="date"]', event, value, element)),
  Timer: define(({ view, emit, disabled, isStreaming }) => { const initial = useRef<number | null>(null); const [running, setRunning] = useState(false); const [started, setStarted] = useState<number | null>(null); const left = Math.max(0, Math.floor(Number(view.props.seconds) || 0)); if (initial.current === null) initial.current = left; useEffect(() => { if (!running || disabled || isStreaming) return; const id = window.setInterval(() => { const next = Math.max(0, Math.floor(Number(view.props.seconds) || 0) - 1); emit('change', next); if (next <= 0) setRunning(false); }, 1000); return () => window.clearInterval(id); }, [running, disabled, isStreaming, view.props.seconds, emit]); const toggle = () => { if (isStreaming) return; if (!running && started === null) setStarted(left); setRunning(value => !value); }; const reset = () => { if (isStreaming) return; setRunning(false); emit('change', started ?? initial.current ?? left); setStarted(null); }; const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; return <div className={`gen-ui-oi-timer ${running ? 'is-running' : ''}`} role="timer" aria-label={str(view.props.label || 'Timer')}><div className="gen-ui-oi-timer-read"><span>{view.props.label ? str(view.props.label) : null}</span><strong>{clock}</strong></div><div className="gen-ui-oi-timer-actions"><button type="button" disabled={disabled || Boolean(isStreaming) || left === 0} onClick={toggle}>{running ? 'Pause' : started === null ? 'Start' : 'Resume'}</button><button type="button" disabled={disabled || Boolean(isStreaming) || started === null} onClick={reset}>Reset</button></div></div>; }, (_element, event) => { if (event !== 'change') throw new Error('Timer event is unavailable'); }),
  Form: define(({ slots }) => <form className="gen-ui-oi-form" onSubmit={event => event.preventDefault()}>{slots.children}</form>),
  SearchImage: define(({ view, asyncRuntime }) => <ImageView asyncRuntime={asyncRuntime} view={{ ...view, props: { ...view.props, src: '' , alt: view.props.query, caption: undefined } }} />),
  Image: define(ImageView),
  Icon: define(({ view }) => {
    const name = normalizedIconName(view.props.name);
    return <span className="gen-ui-oi-icon" aria-label={str(view.props.name)}>{name ? <DynamicIcon name={name} size={({ sm: 14, md: 18, lg: 24, xl: 32 } as Record<string, number>)[str(view.props.size)] ?? 18} strokeWidth={1.8} aria-hidden /> : null}</span>;
  }),
  Table: define(({ view, renderNode }) => { const columns = Array.isArray(view.props.columns) ? view.props.columns as unknown[] : []; const rows = Array.isArray(view.props.rows) ? view.props.rows.filter((row): row is unknown[] => Array.isArray(row)) : []; const numeric = columns.map((_, index) => { const cells = rows.map(row => row[index]).filter(value => value != null && value !== ''); return cells.length > 0 && cells.every(isNumericTableCell); }); const tableCell = (value: unknown) => node(value) ? renderNode(value) : typeof value === 'number' ? i18nService.formatNumber(value, { maximumFractionDigits: 2 }) : Array.isArray(value) ? render(value, renderNode) : inlineText(str(value ?? '')); return <div className="gen-ui-oi-table"><table><thead><tr>{columns.map((column, index) => <th key={index} className={numeric[index] ? 'is-numeric' : undefined}>{str(column)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((_, column) => <td key={column} className={numeric[column] ? 'is-numeric' : undefined}>{tableCell(row[column])}</td>)}</tr>)}</tbody></table></div>; }),
  Chart: define(ChartView),
  Map: define(({ view, emit, asyncRuntime }) => <MapView view={view} emit={emit} asyncRuntime={asyncRuntime} />, (element, event, value) => { if (event !== 'change') throw new Error('Map event is unavailable'); const marker = Array.from(element.querySelectorAll<HTMLElement>('[role="button"][aria-label]')).find(item => item.getAttribute('aria-label') === String(value)); if (!marker) throw new Error('Map marker is unavailable'); marker.dispatchEvent(new MouseEvent('click', { bubbles: true })); }),
  MapMarker: define(() => null),
  YouTube: define(({ view }) => { const id = str(view.props.video).match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/)([\w-]{11})|^([\w-]{11})$/)?.[1] ?? str(view.props.video); return <div className="gen-ui-oi-video"><iframe title={str(view.props.title || 'YouTube video')} src={`https://www.youtube-nocookie.com/embed/${id}`} sandbox="allow-scripts allow-same-origin allow-presentation" loading="lazy" /></div>; }),
  Flashcard: define(({ view, renderNode }) => { const [flipped, setFlipped] = useState(false); const face = (value: unknown) => typeof value === 'string' ? <span>{inlineText(value)}</span> : render(value, renderNode); return <button type="button" className={`gen-ui-oi-flashcard ${flipped ? 'is-flipped' : ''}`} aria-pressed={flipped} onClick={() => setFlipped(value => !value)}><span className="gen-ui-oi-flashcard-inner"><span className="gen-ui-oi-flashcard-face is-front" aria-hidden={flipped}>{face(view.props.front)}{view.props.hint && !flipped ? <small>{str(view.props.hint)}</small> : null}</span><span className="gen-ui-oi-flashcard-face is-back" aria-hidden={!flipped}>{face(view.props.back)}</span></span></button>; }),
  Celebration: define(({ view }) => {
    const [burst, setBurst] = useState(0);
    const previous = useRef<boolean | null>(null);
    useEffect(() => { const next = view.props.when === true; if (previous.current === false && next) setBurst(value => value + 1); previous.current = next; }, [view.props.when]);
    useEffect(() => { if (!burst) return; const timer = window.setTimeout(() => setBurst(0), 2200); return () => window.clearTimeout(timer); }, [burst]);
    if (!burst || typeof document === 'undefined') return null;
    return createPortal(<div className="gen-ui-oi-confetti" role="status" aria-label="Celebration">{Array.from({ length: 48 }, (_, index) => <i key={index} style={{ left: `${(index * 37) % 100}%`, background: chartColor(index), animationDelay: `${(index % 10) * 40}ms`, rotate: `${(index * 97) % 720}deg` }} />)}</div>, getAppearanceOverlayHost());
  }),
  Svg: define(({ view, slots }) => {
    const width = view.props.width as string | number | undefined;
    const height = view.props.height as string | number | undefined;
    // An explicit OpenUI height is part of the component's layout contract.
    // The stylesheet keeps the responsive auto-height behavior only when the
    // source omits height; an inline value prevents a wide FlowChat card from
    // scaling a fixed drawing to the full viewport height.
    return <svg className="gen-ui-oi-svg" viewBox={str(view.props.viewBox)} width={width} height={height} style={{ height: height == null ? undefined : length(height), width: width == null ? undefined : length(width) }} role="img">{slots.children}</svg>;
  }),
  G: define(({ view, slots }) => <g transform={view.props.transform ? str(view.props.transform) : undefined} opacity={view.props.opacity as number | undefined}>{slots.children}</g>),
  Circle: define(({ view }) => <circle cx={view.props.cx as number} cy={view.props.cy as number} r={Math.max(0, Number(view.props.r))} {...paint(view)} />),
  Ellipse: define(({ view }) => <ellipse cx={view.props.cx as number} cy={view.props.cy as number} rx={Math.max(0, Number(view.props.rx))} ry={Math.max(0, Number(view.props.ry))} {...paint(view)} />),
  Rect: define(({ view }) => <rect x={view.props.x as number} y={view.props.y as number} width={Math.max(0, Number(view.props.width))} height={Math.max(0, Number(view.props.height))} rx={view.props.rx as number | undefined} {...paint(view)} />),
  Line: define(({ view }) => <line x1={view.props.x1 as number} y1={view.props.y1 as number} x2={view.props.x2 as number} y2={view.props.y2 as number} stroke={view.props.stroke ? color(view.props.stroke) : 'currentColor'} strokeWidth={view.props.strokeWidth as number | undefined} opacity={view.props.opacity as number | undefined} />),
  Path: define(({ view }) => <path d={str(view.props.d)} {...paint(view)} />),
  Polyline: define(({ view }) => <polyline points={str(view.props.points)} {...paint(view)} />),
  Polygon: define(({ view }) => <polygon points={str(view.props.points)} {...paint(view)} />),
  SvgText: define(({ view }) => <text x={view.props.x as number} y={view.props.y as number} fontSize={view.props.size as number | undefined} fill={view.props.fill ? color(view.props.fill) : 'currentColor'} textAnchor={view.props.anchor as 'start' | 'middle' | 'end' | undefined} fontWeight={view.props.weight === 'semibold' ? 650 : view.props.weight === 'medium' ? 560 : 440}>{str(view.props.text)}</text>),
  HtmlView: define(({ view, isStreaming, htmlScriptEnabled }) => {
    const height = typeof view.props.height === 'number' ? view.props.height : 360;
    if (isStreaming) return <div className="gen-ui-oi-html-slot" style={{ height }} role="status">Preparing the interactive view…</div>;
    const source = sanitizeGenUIHtmlSource({ kind: 'html-document', html: str(view.props.html) }, undefined, '', htmlScriptEnabled === true, false, true).document;
    return <iframe className="gen-ui-oi-html" title={str(view.props.title || 'Interactive view')} style={{ height }} sandbox="allow-scripts" srcDoc={source} />;
  }),
};
