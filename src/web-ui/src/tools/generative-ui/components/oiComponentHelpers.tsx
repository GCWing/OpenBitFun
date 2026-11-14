import type { ReactNode } from 'react';
import { iconNames, type IconName } from 'lucide-react/dynamic';
import type { GenUIComponentImplementation, GenUIComponentProps } from '../genUILibrary';

export const str = (value: unknown) => value == null ? '' : String(value);
export const node = (value: unknown) => Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'element');
export const safeUrl = (value: unknown) => { try { const url = new URL(str(value)); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; } };
export const inlineText = (value: string): ReactNode => {
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
export const render = (value: unknown, renderNode: GenUIComponentProps['renderNode']): ReactNode => {
  if (node(value)) return renderNode(value);
  if (Array.isArray(value)) return value.flat().map((part, index) => <span key={index}>{render(part, renderNode)}</span>);
  return inlineText(str(value));
};
const inspect = () => true;
export const define = (renderFn: GenUIComponentImplementation['render'], exercise?: GenUIComponentImplementation['exercise']): GenUIComponentImplementation => ({ render: renderFn, inspect, ...(exercise ? { exercise } : {}) });
export const options = (value: unknown): Array<{ value: string; label: string; description?: string }> => Array.isArray(value) ? value.flat().filter(Boolean).map(item => typeof item === 'string' ? { value: item, label: item } : item as { value: string; label: string; description?: string }) : [];
export const controlOptions = (value: unknown, name: string) => {
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
export const color = (value: unknown) => typeof value === 'string' ? COLOR_TOKENS[value] ?? value : undefined;
export const length = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return `${Math.max(0, value)}px`;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d+(?:\.\d+)?(?:px|%|em|rem|vh|vw|fr)$|^auto$/.test(trimmed) ? trimmed : undefined;
};
export const radius = (value: unknown) => typeof value === 'string'
  ? ({ sm: '6px', md: '10px', lg: '14px', xl: '18px', full: '999px' }[value] ?? value)
  : length(value);
export const space = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? `${Math.max(0, value) * 4}px` : undefined;
export const paint = (view: GenUIComponentProps['view']) => ({ fill: color(view.props.fill), stroke: color(view.props.stroke), strokeWidth: typeof view.props.strokeWidth === 'number' ? view.props.strokeWidth : undefined, opacity: typeof view.props.opacity === 'number' ? Math.max(0, Math.min(1, view.props.opacity)) : undefined });

const lucideNames = new Set<string>(iconNames);
export function normalizedIconName(value: unknown): IconName | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
  return lucideNames.has(normalized) ? normalized as IconName : null;
}

const NUMERIC_TABLE_CELL = /^[-+−]?[$€£¥₹]?\s?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB]|bn)?$/;
export const isNumericTableCell = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && !/^(n\/a|—|–|-)$/i.test(value.trim()) && NUMERIC_TABLE_CELL.test(value.trim()));
const CHART_COLORS = [
  'var(--openbitfun-color-accent-default)',
  'var(--openbitfun-color-status-warning-content)',
  'var(--openbitfun-color-status-success-content)',
  'var(--openbitfun-color-status-info-content)',
  'var(--openbitfun-color-status-danger-content)',
  'var(--openbitfun-color-content-primary)',
] as const;
export const chartColor = (index: number) => CHART_COLORS[index % CHART_COLORS.length];
