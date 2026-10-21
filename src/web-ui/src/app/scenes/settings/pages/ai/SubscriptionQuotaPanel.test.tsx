// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionQuotaSnapshot } from '@/infrastructure/api/service-api/AIApi';
import { SubscriptionQuotaPanel } from './SubscriptionQuotaPanel';
import copy from '@/locales/en-US/settings/models.json';

const observation = vi.hoisted(() => ({ value: null as SubscriptionQuotaSnapshot | null, loading: false, failed: false, unsupportedHost: false, refresh: vi.fn() }));
vi.mock('@/infrastructure/config/hooks/useSubscriptionQuota', () => ({ useSubscriptionQuota: () => observation }));
vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => {
    let text = key.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], copy) as string || key;
    for (const [name, value] of Object.entries(values || {})) text = text.replace(`{{${name}}}`, String(value));
    return text;
  } }),
  i18nService: { formatNumber: (value: number, options?: { style?: string }) => options?.style === 'percent' ? `${Math.round(value * 1000) / 10}%` : String(value), formatDate: (value: Date) => value.toISOString() },
}));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
  IconButton: ({ icon, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; loading?: boolean }) => <button {...props}>{icon}</button>,
  Icon: () => <svg aria-hidden="true" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  StatusPill: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
let container: HTMLDivElement;
let root: Root;
const render = () => act(() => root.render(<SubscriptionQuotaPanel provider="zcode" identity="fixture" active supported />));
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observation.value = null; observation.loading = false; observation.failed = false; observation.unsupportedHost = false; observation.refresh.mockReset();
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

it('shows precise remaining credits with accessible progress, plan and reset time', () => {
  observation.value = { account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'Pro', valid_until: Date.now() / 1000 + 60, windows: [],
    display: { version: 1, meters: [{ id: 'credits', used: 125, limit: 1000, remaining: 875, unit: 'credits', used_percent: 12.5, resets_at: 1800000000 }] } };
  render();
  expect(container.textContent).toContain('875');
  expect(container.textContent).toContain('125 used of 1000');
  expect(container.textContent).toContain('Pro');
  expect(container.textContent).toContain('Resets');
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('87.5');
  act(() => container.querySelector('button')!.click());
  expect(observation.refresh).toHaveBeenCalledOnce();
});
it('keeps old values visibly stale after failure and distinguishes unknown from unlimited', () => {
  observation.failed = true;
  observation.value = { account_id: 'zcode', provider: 'zcode', state: 'query_failed', windows: [], observed_at: 1000,
    display: { version: 1, meters: [{ id: 'unknown' }, { id: 'unlimited', unlimited: true }] } };
  render();
  expect(container.textContent).toContain('The last observation');
  expect(container.textContent).toContain('Unlimited');
  expect(container.textContent).toContain('—');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});
it('provides an explicit unsupported-host state without a misleading refresh control', () => {
  observation.unsupportedHost = true;
  render();
  expect(container.textContent).toContain('This host does not support');
  expect(container.querySelector('button')).toBeNull();
});

it('shows a loading placeholder without inventing zero usage or an allowance', () => {
  observation.loading = true;
  render();
  expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Reading allowance');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.textContent).not.toContain('0%');
  expect(container.querySelector('button')?.disabled).toBe(true);
});

it('keeps model-specific Codex periods visible alongside the primary allowance', () => {
  observation.value = { account_id: 'codex', provider: 'codex', state: 'known', valid_until: Date.now() / 1000 + 60,
    windows: [{ id: 'primary', duration_seconds: 18000, used_percent: 20 }],
    details: { version: 1, buckets: [{ id: 'spark', display_name: 'Spark', windows: [
      { id: 'primary', duration_seconds: 18000, used_percent: 40 },
      { id: 'secondary', duration_seconds: 604800, used_percent: 60 },
    ] }] } };
  render();
  expect(container.textContent).toContain('Spark · 5h window');
  expect(container.textContent).toContain('Spark · Weekly');
  expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
  expect(container.querySelector('[data-openbitfun-part="subscriptionQuota"]')).not.toBeNull();
});

it('explains Console balance unavailability and keeps the console action available', () => {
  observation.value = { account_id: 'opencode', provider: 'opencode', state: 'unsupported', windows: [], error: 'opencode_balance_unavailable' };
  act(() => root.render(<SubscriptionQuotaPanel provider="opencode" identity="fixture" active supported />));
  expect(container.textContent).toContain('no public balance API');
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(container.querySelector('button')?.textContent).toBe('Open console');
});

it('shows a successful Grok period-only response without inventing zero usage or a network failure', () => {
  observation.value = { account_id: 'grok', provider: 'grok', state: 'known', plan: 'Grok', valid_until: Date.now() / 1000 + 60, windows: [],
    display: { version: 1, meters: [{ id: 'period', duration_seconds: 604800, resets_at: 1800000000 }] } };
  act(() => root.render(<SubscriptionQuotaPanel provider="grok" identity="fixture" active supported />));
  expect(container.querySelector('section')?.dataset.state).toBe('known');
  expect(container.textContent).toContain('has not reported a usage percentage');
  expect(container.textContent).toContain('Resets');
  expect(container.textContent).toContain('—');
  expect(container.textContent).not.toContain('0%');
  expect(container.textContent).not.toContain('Check account authorization');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});
