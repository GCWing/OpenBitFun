import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import type { GenUIComponentProps, GenUIImplementations } from '../genUILibrary';
import { formatGenUINumber } from '../genUIFormatting';
import { hmPlotKit } from './vendor/harmonyPlot';
import { HM_ICON_CODEPOINTS } from './vendor/hm-icons';
import { fluentEmoji3dUrl } from './vendor/fluentEmoji3d';
import { oiComponents } from './oiComponents';
const plot = hmPlotKit();

type Step = { id: string; title: string; detail?: string; status: 'pending' | 'current' | 'complete' };
const display = (value: unknown): string => value === null ? '' : typeof value === 'number' ? formatGenUINumber(value, Number.isInteger(value) ? 0 : 2) : String(value);
const text = (value: unknown): string => value == null ? '' : String(value);
const iconAliases: Record<string, string> = {
  home: 'house', settings: 'gearshape', setting: 'gearshape', gear: 'gearshape', search: 'magnifyingglass',
  user: 'person', profile: 'person', close: 'xmark', x: 'xmark', check: 'checkmark', done: 'checkmark_circle',
  add: 'plus', remove: 'minus', edit: 'pencil_line', pencil: 'pencil_line', delete: 'trash', bin: 'trash',
  info: 'info_circle', warning: 'exclamationmark_triangle', error: 'exclamationmark_circle', help: 'questionmark_circle',
  more: 'ellipsis_circle', menu: 'line_3_horizontal', filter: 'slider_horizontal_2', sliders: 'slider_horizontal_2',
  refresh: 'arrow_clockwise', reload: 'arrow_clockwise', reset: 'arrow_counterclockwise', sync: 'arrow_2_circlepath',
  next: 'forward_end_fill', previous: 'backward_end_fill', prev: 'backward_end_fill',
  location: 'location_up', pin: 'location_up', map_pin: 'location_up', time: 'clock', schedule: 'calendar', date: 'calendar',
  mail: 'envelope', chat: 'message', notification: 'bell', image: 'photo', picture: 'photo', file: 'doc', document: 'doc_text',
  task: 'doc_text', tasks: 'list_bullet', code: 'keyboard', develop: 'keyboard', test: 'checkmark_circle',
  progress: 'clock', pending: 'clock', complete: 'checkmark_circle_fill', finished: 'checkmark_circle_fill',
};
function harmonyIconName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').replace(/^(icon_|ic_|hm_)/, '').toLowerCase();
  const candidates = [raw, raw.replace(/_fill$/, ''), `${raw}_fill`, iconAliases[raw], iconAliases[raw.replace(/_fill$/, '')]];
  return candidates.find(name => Boolean(name && Object.prototype.hasOwnProperty.call(HM_ICON_CODEPOINTS, name)));
}
function HarmonyIcon({ name, size }: { name: unknown; size?: unknown }) {
  const resolved = harmonyIconName(name);
  const sizeClass = size === 'sm' ? ' small' : size === 'lg' || size === 'xl' ? ' large' : '';
  return <span className={`hm-icon${sizeClass}`} data-icon={resolved ?? text(name)} aria-hidden="true" />;
}

function HarmonyIcon3D({ view }: GenUIComponentProps) {
  const emoji = text(view.props.emoji).trim();
  const imageUrl = fluentEmoji3dUrl(emoji);
  const [failedUrl, setFailedUrl] = useState<string>();
  const showImage = imageUrl && failedUrl !== imageUrl;
  const sizeClass = view.props.size === 'large' ? ' large' : '';
  return <span className={`hm-icon3d${sizeClass}`} data-emoji={emoji} data-hm-icon3d={showImage ? 'external' : 'fallback'}>
    {showImage ? <img src={imageUrl} alt={emoji} loading="eager" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailedUrl(imageUrl)} /> : <span role="img" aria-label={emoji}>{emoji}</span>}
  </span>;
}

function HarmonyButton({ view, emit, disabled, isStreaming }: GenUIComponentProps) {
  const variant = text(view.props.variant ?? 'solid');
  const size = text(view.props.size);
  return <button type="button" className={`gen-ui-oi-button gen-ui-oi-button-${variant} ${view.props.color ? `gen-ui-oi-button-${text(view.props.color)}` : ''} ${size ? `gen-ui-oi-button-${size}` : ''} ${view.props.block ? 'is-block' : ''}`} disabled={disabled || Boolean(isStreaming) || Boolean(view.props.disabled)} onClick={() => emit('click')}>
    {view.props.icon ? <HarmonyIcon name={view.props.icon} size={size} /> : null}{text(view.props.label)}
  </button>;
}

function HarmonyIconButton({ view, emit, disabled, isStreaming }: GenUIComponentProps) {
  return <button type="button" className={`gen-ui-oi-icon-button gen-ui-oi-icon-button-${text(view.props.variant ?? 'outline')}`} aria-label={text(view.props.label || view.props.icon)} disabled={disabled || Boolean(isStreaming)} onClick={() => emit('click')}>
    <HarmonyIcon name={view.props.icon} size="md" />
  </button>;
}

function HarmonyBadge({ view }: GenUIComponentProps) {
  return <span className={`gen-ui-oi-badge gen-ui-oi-badge-${text(view.props.color ?? 'neutral')}`}>{view.props.icon ? <HarmonyIcon name={view.props.icon} size="sm" /> : null}{text(view.props.text)}</span>;
}
function unique(values: unknown[], name: string) {
  if (values.some(value => typeof value !== 'string' || !value) || new Set(values).size !== values.length) throw new Error(name + ' requires unique nonempty keys');
}

function Metric({ view }: GenUIComponentProps) {
  return <div className="gen-ui-metric"><span data-gen-ui-metric-label>{String(view.props.label)}</span><strong data-gen-ui-metric-value>{display(view.props.value)}{view.props.unit ? ' ' + view.props.unit : ''}</strong>{view.props.detail !== undefined && <span data-gen-ui-metric-detail>{String(view.props.detail)}</span>}</div>;
}

function Steps({ view }: GenUIComponentProps) {
  const { t } = useI18n('flow-chat');
  const status = {
    pending: t('toolCards.generativeUI.steps.pending'),
    current: t('toolCards.generativeUI.steps.current'),
    complete: t('toolCards.generativeUI.steps.complete'),
  };
  const items = view.props.items as Step[];
  unique(items.map(item => item.id), 'Steps');
  return <ol className="gen-ui-steps" aria-label={String(view.props.label)}>{items.map((item, index) => <li key={item.id} data-status={item.status} aria-current={item.status === 'current' ? 'step' : undefined}><span className="gen-ui-step-number" aria-hidden="true">{item.status === 'complete' ? <HarmonyIcon name="checkmark" size="sm" /> : index + 1}</span><div><strong>{item.title}</strong>{item.detail !== undefined && <p>{item.detail}</p>}<span className="gen-ui-step-status">{status[item.status]}</span></div></li>)}</ol>;
}

function Plot({ view }: GenUIComponentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [width, setWidth] = useState(328);
  useLayoutEffect(() => {
    const measure = () => { const measured = ref.current?.clientWidth; if (measured) setWidth(Math.max(240, Math.min(measured, 560))); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const result = useMemo(() => plot.render(plot.parse(String(view.props.spec)), width, String(view.props.label)), [view.props.spec, view.props.label, width]);
  if (result.issues.length || !result.svg) throw new Error('Plot: ' + result.issues.join('; '));
  // Only the trusted, escaping upstream renderer produces markup. Model HTML
  // never enters this sink; unique clip IDs isolate multiple mounted plots.
  return <figure className="gen-ui-plot"><figcaption>{String(view.props.label)}</figcaption><div ref={ref} dangerouslySetInnerHTML={{ __html: result.svg.split('hm-pl-clip').join('genui-plot-' + id) + result.table }} /></figure>;
}
export const harmonyComponents: GenUIImplementations['components'] = {
  Icon3D: { render: HarmonyIcon3D, inspect: (element, view) => element.querySelector('.hm-icon3d')?.getAttribute('data-emoji') === text(view.props.emoji).trim() },
  Button: { ...oiComponents.Button, render: HarmonyButton, inspect: (element, view) => element.querySelector('button')?.textContent?.trim() === text(view.props.label) },
  IconButton: { ...oiComponents.IconButton, render: HarmonyIconButton, inspect: (element, view) => element.querySelector('button')?.getAttribute('aria-label') === text(view.props.label || view.props.icon) },
  Badge: { render: HarmonyBadge, inspect: (element, view) => element.querySelector('.gen-ui-oi-badge')?.textContent?.trim() === text(view.props.text) },
  Icon: {
    render: ({ view }) => <HarmonyIcon name={view.props.name} size={view.props.size} />,
    inspect: (element, view) => {
      const requested = text(view.props.name);
      const resolved = harmonyIconName(requested);
      if (!resolved) throw new Error(`Unsupported Harmony icon name: ${requested}`);
      return element.querySelector('[data-icon]')?.getAttribute('data-icon') === resolved;
    },
  },
  Metric: {
    render: Metric,
    inspect: (element, view) => element.querySelector('[data-gen-ui-metric-label]')?.textContent === view.props.label && element.querySelector('[data-gen-ui-metric-value]')?.textContent === display(view.props.value) + (view.props.unit ? ' ' + view.props.unit : '') && (element.querySelector('[data-gen-ui-metric-detail]')?.textContent ?? '') === (view.props.detail ?? ''),
  },
  Steps: {
    render: Steps,
    inspect: (element, view) => {
      const items = view.props.items as Step[];
      const nodes = Array.from(element.querySelectorAll('li'));
      return element.querySelector('ol')?.getAttribute('aria-label') === view.props.label && nodes.length === items.length && nodes.every((node, i) => node.dataset.status === items[i].status && node.querySelector('strong')?.textContent === items[i].title && (node.querySelector('p')?.textContent ?? '') === (items[i].detail ?? ''));
    },
  },
  Plot: {
    render: Plot,
    inspect: (element, view) => element.querySelector('figcaption')?.textContent === view.props.label && Boolean(element.querySelector('svg path,svg circle,svg polyline')) && Boolean(element.querySelector('table')),
  },
};
