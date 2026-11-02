// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';
import { ZcodeSubscriptionGroup } from './ZcodeSubscriptionGroup';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => (({
    'subscriptionAuth.pool.addAccount': 'Add account',
    'subscriptionAuth.login': 'Sign in', 'subscriptionAuth.cancel': 'Cancel',
    'subscriptionAuth.regions.zai': 'Z.ai', 'subscriptionAuth.regions.bigmodel': 'BigModel',
  } as Record<string, string>)[key] || key) }),
}));
vi.mock('@/infrastructure/config/components/common', () => ({
  ConfigPageRow: ({ label, description, children }: { label: string; description: string; children: React.ReactNode }) => (
    <section><h2>{label}</h2><p>{description}</p>{children}</section>
  ),
}));

const accounts: SubscriptionAccount[] = ['zcode', 'zcode_cn'].map(provider => ({
  provider: provider as SubscriptionAccount['provider'], connected: false, display_label: provider,
  suggested_format: 'anthropic', suggested_base_url: 'https://example.invalid', suggested_model: '', api_offerings: [],
}));

describe('ZCode subscription entry', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onLogin = vi.fn();
  const renderAccount = (account: SubscriptionAccount) => <div key={account.provider} data-account={account.provider}>{account.account || account.provider}</div>;
  const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onLogin.mockReset();
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('opens the region choice at sign-in and authorizes only the chosen region', () => {
    act(() => root.render(<ZcodeSubscriptionGroup accounts={accounts} busy={false} onLogin={onLogin} renderAccount={renderAccount} />));
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(button('BigModel')).toBeUndefined();
    act(() => button('Sign in').click());
    expect(button('Z.ai')).toBeDefined();
    act(() => button('BigModel').click());
    expect(onLogin).toHaveBeenCalledExactlyOnceWith('zcode_cn');
    expect(button('BigModel')).toBeUndefined();
  });

  it('keeps both connected accounts visible and preserves the pending regional login', () => {
    act(() => root.render(<ZcodeSubscriptionGroup
      accounts={accounts.map(account => ({ ...account, connected: true, account: `${account.provider}@example.invalid` }))}
      busy onLogin={onLogin} renderAccount={renderAccount} />));
    expect([...container.querySelectorAll('[data-account]')].map(row => row.getAttribute('data-account'))).toEqual(['zcode', 'zcode_cn']);
    expect(button('Sign in').disabled).toBe(true);
    act(() => root.render(<ZcodeSubscriptionGroup accounts={accounts} busy activeProvider="zcode_cn" onLogin={onLogin} renderAccount={renderAccount} />));
    expect(container.querySelectorAll('[data-account]')).toHaveLength(1);
    expect(container.querySelector('[data-account]')?.getAttribute('data-account')).toBe('zcode_cn');
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('keeps named regional accounts visible even when the provider default is signed out', () => {
    act(() => root.render(<ZcodeSubscriptionGroup accounts={accounts} accountCount={2} visibleProviders={['zcode_cn']}
      busy={false} onLogin={onLogin} renderAccount={renderAccount} />));
    expect(container.querySelectorAll('[data-account]')).toHaveLength(1);
    expect(container.querySelector('[data-account]')?.getAttribute('data-account')).toBe('zcode_cn');
    act(() => button('Add account').click());
    act(() => button('BigModel').click());
    expect(onLogin).toHaveBeenCalledExactlyOnceWith('zcode_cn');
  });

  it('does not offer unavailable regions and blocks region choice during another authorization', () => {
    act(() => root.render(<ZcodeSubscriptionGroup accounts={[accounts[1]]} busy={false} onLogin={onLogin} renderAccount={renderAccount} />));
    act(() => button('Sign in').click());
    expect(button('Z.ai')).toBeUndefined();
    act(() => root.render(<ZcodeSubscriptionGroup accounts={[accounts[1]]} busy onLogin={onLogin} renderAccount={renderAccount} />));
    expect(button('BigModel').disabled).toBe(true);
    act(() => button('BigModel').click());
    expect(onLogin).not.toHaveBeenCalled();
  });
});
