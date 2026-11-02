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
  Card: ({ children }: React.PropsWithChildren) => <div data-openbitfun-component="card">{children}</div>,
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
  IconButton: ({ icon, loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; loading?: boolean }) => <button {...props}>{icon}</button>,
  Icon: () => <svg aria-hidden="true" />,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  StatusPill: ({ children }: { children: React.ReactNode }) => <span data-openbitfun-component="status-pill">{children}</span>,
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
  observation.value = { account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'Pro', observed_at: 1700000000, valid_until: Date.now() / 1000 + 60, windows: [],
    display: { version: 1, expires_at: 1800000000, meters: [{ id: 'credits', used: 125, limit: 1000, remaining: 875, unit: 'credits', used_percent: 12.5, resets_at: 1800000000 }] } };
  render();
  expect(container.textContent).toContain('875');
  expect(container.textContent).toContain('125 used of 1000');
  expect(container.textContent).toContain('Pro');
  expect(container.textContent).toContain('Resets');
  const card = container.querySelector('[data-openbitfun-component="card"]')!;
  expect(container.querySelectorAll('[data-openbitfun-component="card"]')).toHaveLength(1);
  expect(card.querySelector('[data-openbitfun-part="quotaHeader"] [data-openbitfun-component="status-pill"]')?.textContent).toBe('Pro');
  expect(card.querySelector('[data-openbitfun-part="quotaMeter"]')).not.toBeNull();
  expect(card.querySelector('[data-openbitfun-part="quotaFooter"] time')).not.toBeNull();
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('87.5');
  act(() => container.querySelector('button')!.click());
  expect(observation.refresh).toHaveBeenCalledOnce();
});
it('keeps the editor summary concise without losing quota meaning or refresh', () => {
  observation.value = { account_id: 'codex', provider: 'codex', state: 'known', plan: 'Pro', windows: [], observed_at: 1700000000, valid_until: Date.now() / 1000 + 60,
    display: { version: 1, meters: [{ id: 'weekly', duration_seconds: 604800, used_percent: 25, resets_at: 1800000000 }] } };
  act(() => root.render(<SubscriptionQuotaPanel provider="codex" accountId="slot-a" identity="fixture" active supported compact inline />));
  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(copy.quota.title);
  expect(container.querySelector('[data-openbitfun-component="card"]')).toBeNull();
  expect(container.querySelector('[data-openbitfun-part="quotaHeader"]')?.textContent).toBe('Pro');
  expect(container.querySelector('[data-openbitfun-part="quotaValue"]')?.textContent).toBe('75%');
  expect(container.querySelector('[data-openbitfun-part="quotaValue"]')?.getAttribute('aria-label')).toContain('Weekly');
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('75');
  expect(container.querySelectorAll('[data-filled]')).toHaveLength(24);
  expect(container.querySelectorAll('[data-filled="true"]')).toHaveLength(18);
  expect(container.textContent).not.toContain('Resets');
  expect(container.querySelector('[data-openbitfun-part="quotaFooter"]')).toBeNull();
  act(() => container.querySelector('button')!.click());
  expect(observation.refresh).toHaveBeenCalledOnce();
  render();
  expect(container.querySelector('[data-openbitfun-part="quotaHeader"]')?.textContent).toContain(copy.quota.title);
  expect(container.querySelector('[data-openbitfun-part="quotaFooter"]')).toBeNull();
  expect(container.textContent).not.toContain('Updated');
});

it('combines the account, plan badge and account-scoped refresh in one header', () => {
  observation.value = { account_id: 'slot-a', provider: 'codex', state: 'known', plan: 'Pro', windows: [], valid_until: Date.now() / 1000 + 60,
    display: { version: 1, meters: [{ id: 'weekly', duration_seconds: 604800, used_percent: 25 }] } };
  act(() => root.render(<SubscriptionQuotaPanel provider="codex" accountId="slot-a" identity="fixture" active supported compact inline
    accountLabel={<span>account@example.invalid</span>} headerLeading={<input type="checkbox" aria-label="Select account" />}
    headerActions={<button>Move up</button>} />));
  const header = container.querySelector('[data-openbitfun-part="quotaHeader"]')!;
  expect(header.textContent).toContain('account@example.invalid');
  expect(header.querySelector('input[type="checkbox"]')?.parentElement).toBe(header);
  expect(header.querySelector('[data-openbitfun-part="quotaMeter"]')).toBeNull();
  expect(header.querySelector('[data-openbitfun-component="status-pill"]')?.textContent).toBe('Pro');
  expect(header.textContent).not.toContain(copy.quota.title);
  expect(header.querySelectorAll('button')).toHaveLength(2);
  act(() => (header.querySelector(`button[aria-label="${copy.quota.refresh}"]`) as HTMLButtonElement).click());
  expect(observation.refresh).toHaveBeenCalledOnce();
  observation.unsupportedHost = true;
  act(() => root.render(<SubscriptionQuotaPanel provider="codex" accountId="slot-a" identity="fixture" active supported compact inline accountLabel="account@example.invalid" />));
  expect(container.textContent).toContain('account@example.invalid');
  expect(container.textContent).toContain('This host does not support');
  expect(container.querySelector('button')).toBeNull();
});

it.each([
  [0, 100, 24, 'normal'],
  [25, 75, 18, 'normal'],
  [80, 20, 5, 'warning'],
  [100, 0, 0, 'danger'],
] as const)('renders inline allowance as vertical segments (used: %s%%)', (used, remaining, filled, tone) => {
  observation.value = { account_id: 'slot-a', provider: 'codex', state: 'known', plan: 'Pro', windows: [], valid_until: Date.now() / 1000 + 60,
    display: { version: 1, meters: [{ id: 'weekly', duration_seconds: 604800, used_percent: used, resets_at: 1800000000 }] } };
  act(() => root.render(<SubscriptionQuotaPanel provider="codex" accountId="slot-a" identity="fixture" active supported inline />));
  expect(container.querySelector('[data-openbitfun-component="card"]')).toBeNull();
  expect(container.textContent).toContain('Weekly');
  expect(container.querySelector('[data-openbitfun-part="quotaValue"]')?.textContent).toBe(`${remaining}%`);
  const track = container.querySelector('[role="progressbar"]')!;
  expect(track.getAttribute('aria-valuenow')).toBe(String(remaining));
  expect(track.getAttribute('aria-label')).toContain('Weekly');
  expect(track.closest('[data-openbitfun-part="quotaMeter"]')?.getAttribute('data-tone')).toBe(tone);
  expect(track.querySelectorAll('[data-filled]')).toHaveLength(24);
  expect(track.querySelectorAll('[data-filled="true"]')).toHaveLength(filled);
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.quota.refresh}"]`)!.click());
  expect(observation.refresh).toHaveBeenCalledOnce();
});

it('omits the inline stale badge while retaining refresh failures, unknown and unlimited allowances', () => {
  observation.failed = true;
  observation.value = { account_id: 'zcode', provider: 'zcode', state: 'query_failed', windows: [], observed_at: 1000,
    display: { version: 1, meters: [{ id: 'unknown' }, { id: 'unlimited', unlimited: true }, { id: 'weekly', duration_seconds: 604800, used_percent: 25 }] } };
  act(() => root.render(<SubscriptionQuotaPanel provider="zcode" identity="fixture" active supported inline />));
  expect(container.textContent).not.toContain(copy.quota.stale);
  expect(container.textContent).toContain(copy.quota.refreshFailedRetained);
  expect([...container.querySelectorAll('[data-openbitfun-part="quotaValue"]')].map(value => value.textContent)).toEqual(['—', 'Unlimited', '75%']);
  expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  observation.unsupportedHost = true;
  act(() => root.render(<SubscriptionQuotaPanel provider="zcode" identity="fixture" active supported inline />));
  expect(container.textContent).toContain(copy.quota.hostUnsupported);
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
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

it('replaces the inline loading message with a decorative skeleton and reveals failures explicitly', () => {
  observation.loading = true;
  const renderInline = () => act(() => root.render(<SubscriptionQuotaPanel provider="codex" identity="fixture" active supported inline />));
  renderInline();
  const skeleton = container.querySelector('[data-testid="subscription-quota-skeleton"]')!;
  expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  expect(skeleton.getAttribute('aria-hidden')).toBe('true');
  expect(skeleton.querySelectorAll('[style*="animation-delay"]')).toHaveLength(24);
  expect(container.querySelector('[role="status"]')?.classList.contains('sr-only')).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(copy.quota.loading);
  expect(container.querySelector('[data-openbitfun-part="quotaHeader"]')?.textContent).toBe('');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.querySelector('[aria-valuenow]')).toBeNull();
  expect(container.querySelector('button')?.disabled).toBe(true);

  observation.loading = false;
  observation.failed = true;
  renderInline();
  expect(container.querySelector('[data-testid="subscription-quota-skeleton"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(copy.quota.queryFailed);
  expect(container.querySelector('[role="status"]')?.classList.contains('sr-only')).toBe(false);
  expect(container.querySelector('button')?.disabled).toBe(false);
});

it('keeps the inline allowance visible during a background refresh', () => {
  observation.loading = true;
  observation.value = { provider: 'codex', account_id: 'codex', state: 'known', plan: 'Pro', valid_until: Date.now() / 1000 + 60,
    windows: [{ id: 'weekly', duration_seconds: 604800, used_percent: 25 }] };
  act(() => root.render(<SubscriptionQuotaPanel provider="codex" identity="fixture" active supported inline />));
  expect(container.querySelector('[data-testid="subscription-quota-skeleton"]')).toBeNull();
  expect(container.querySelector('[data-openbitfun-part="quotaValue"]')?.textContent).toBe('75%');
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('75');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
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
