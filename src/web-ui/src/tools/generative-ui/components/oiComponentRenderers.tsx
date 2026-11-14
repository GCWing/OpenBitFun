import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ImageIcon } from 'lucide-react';
import { i18nService } from '@/infrastructure/i18n';
import type { GenUIComponentProps } from '../genUILibrary';
import type { GenUIAsyncRuntime, GenUIAsyncExecuteOptions } from '../genUIAsyncCapabilities';
import { isAbortError } from '../genUIAsyncCapabilities';
import { str, safeUrl, inlineText, color, length, radius, space, chartColor } from './oiComponentHelpers';

export function Layout({ view, slots }: GenUIComponentProps) {
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
export function ImageView({ view, asyncRuntime }: Pick<GenUIComponentProps, 'view' | 'asyncRuntime'>) {
  const alt = str(view.props.alt ?? view.props.query);
  const image = useSearchImage(str(view.props.query ?? alt), str(view.props.src), asyncRuntime);
  const aspectRatio = typeof view.props.aspectRatio === 'number' && view.props.aspectRatio > 0.2 && view.props.aspectRatio < 5 ? view.props.aspectRatio : 1.5;
  return <figure className="gen-ui-oi-image" data-openbitfun-component="gen-ui-components" data-openbitfun-part="media" data-gen-ui-loading={image.loading || undefined} data-gen-ui-error={image.error || undefined} style={{ aspectRatio, borderRadius: radius(view.props.radius ?? 'lg') }}>
    {image.src ? <img src={image.src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={image.onError} style={{ objectFit: view.props.fit === 'contain' ? 'contain' : 'cover' }} /> : image.loading ? null : <div className="gen-ui-oi-image-empty" role="img" aria-label={alt}><ImageIcon aria-hidden strokeWidth={1.5} /></div>}
    <figcaption>{view.props.caption ? inlineText(str(view.props.caption)) : image.error ? image.error : null}</figcaption>
  </figure>;
}

type ChartRow = Record<string, unknown>;
const chartNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
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
export function ChartView({ view }: Pick<GenUIComponentProps, 'view'>) {
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
