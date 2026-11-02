// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { i18nService } from '@/infrastructure/i18n';
import { SubscriptionAuthorizationExpiry } from './SubscriptionAuthorizationExpiry';

vi.mock('@openbitfun/ui', () => ({
  Tooltip: ({ children, content }: { children: React.ReactNode; content: string }) => <span data-tooltip={content}>{children}</span>,
}));

let root: Root;
let container: HTMLDivElement;
const now = Date.parse('2026-10-28T00:00:00Z');
const copy = (key: string, values?: Record<string, unknown>) => String(i18nService.getI18nInstance().t(key, { ns: 'settings/models', ...values }));
const render = (expiresAt: number, active = true) => act(() => root.render(<SubscriptionAuthorizationExpiry expiresAt={expiresAt} active={active} />));

beforeAll(async () => { await i18nService.loadNamespace('settings/models'); });
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(i18nService, 'formatNumber').mockImplementation((value, options) => new Intl.NumberFormat('en-US', options).format(value));
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });

it('counts down authorization to expiry and retains the full deadline in its tooltip', () => {
  const deadline = now + 61000;
  render(deadline / 1000);
  const time = container.querySelector('time')!;
  expect(time.textContent).toBe(copy('subscriptionAuth.expiresIn', { time: '1 min 1 sec' }));
  expect(time.dateTime).toBe(new Date(deadline).toISOString());
  expect(time.parentElement?.dataset.tooltip).toBe(copy('subscriptionAuth.expiresAt', {
    time: i18nService.formatDate(new Date(deadline), { dateStyle: 'medium', timeStyle: 'short' }),
  }));
  act(() => { vi.advanceTimersByTime(2000); });
  expect(time.textContent).toBe(copy('subscriptionAuth.expiresIn', { time: '59 sec' }));
  act(() => { vi.advanceTimersByTime(59000); });
  expect(time.textContent).toBe(copy('subscriptionAuth.authorizationExpired'));
  expect(time.dataset.expired).toBe('true');
  expect(vi.getTimerCount()).toBe(0);
});

it('updates only while active and catches up after the page becomes visible', () => {
  const deadline = now + 120000;
  render(deadline / 1000, false);
  expect(vi.getTimerCount()).toBe(0);
  act(() => { vi.advanceTimersByTime(60000); });
  render(deadline / 1000);
  expect(container.querySelector('time')?.textContent).toBe(copy('subscriptionAuth.expiresIn', { time: '1 min' }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => { vi.advanceTimersByTime(30000); });
  expect(container.querySelector('time')?.textContent).toBe(copy('subscriptionAuth.expiresIn', { time: '1 min' }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(container.querySelector('time')?.textContent).toBe(copy('subscriptionAuth.expiresIn', { time: '30 sec' }));
  render(deadline / 1000, false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([NaN, Infinity, Number.MAX_VALUE])('omits an invalid deadline without starting a timer (%s)', expiresAt => {
  render(expiresAt);
  expect(container.querySelector('time')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
