// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SSHAuthPromptDialog } from './SSHAuthPromptDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./pickSshPrivateKeyPath', () => ({ pickSshPrivateKeyPath: vi.fn(), pickSshCertificatePath: vi.fn() }));

it('retains the SSH prompt during exit and clears credentials before reopening', () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (open: boolean) => act(() => root.render(
    <SSHAuthPromptDialog open={open} targetDescription={open ? 'user@remote:22' : ''}
      defaultAuthMethod="password" initialUsername={open ? 'user' : ''} lockUsername
      onSubmit={() => undefined} onCancel={() => undefined} />,
  ));
  try {
    render(true);
    const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(surface.querySelector('h2')?.textContent).toBe('ssh.remote.authPromptTitle · user@remote:22');
    expect(surface.querySelector('[data-openbitfun-part="authDialog"] [data-openbitfun-part="authDescription"]')).toBeNull();
    const password = surface.querySelector<HTMLInputElement>('input[type="password"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(password, 'test-password');
      password.dispatchEvent(new Event('input', { bubbles: true }));
    });
    render(false);
    expect(surface.dataset.state).toBe('exiting');
    expect(surface.textContent).toContain('user@remote:22');
    expect(password.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(180));
    expect(surface.isConnected).toBe(false);
    render(true);
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});

it.each(['password', 'privateKey'] as const)('only requests missing %s credentials for a saved connection', async method => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const submit = vi.fn();
  try {
    await act(async () => root.render(
      <SSHAuthPromptDialog open credentialsOnly lockUsername targetDescription="dev@host.test:22"
        defaultAuthMethod={method} initialUsername="dev" defaultKeyPath="/keys/dev" defaultCertificatePath="/keys/dev-cert.pub"
        onSubmit={submit} onCancel={vi.fn()} />,
    ));
    expect(document.querySelector('[data-openbitfun-component="select"]')).toBeNull();
    expect([...document.querySelectorAll('label')].map(label => label.textContent))
      .toEqual([method === 'password' ? 'ssh.remote.password' : 'ssh.remote.passphrase']);
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'credential');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'ssh.remote.connect')!.click());
    expect(submit).toHaveBeenCalledWith({ username: 'dev', auth: method === 'password'
      ? { type: 'Password', password: 'credential' }
      : { type: 'PrivateKey', keyPath: '/keys/dev', certificatePath: '/keys/dev-cert.pub', passphrase: 'credential' } });
    await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]')!.click());
    expect(document.querySelector('[data-openbitfun-component="select"]')).not.toBeNull();
    if (method === 'privateKey') {
      const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === 'ssh.remote.privateKeyPath')!;
      expect((document.getElementById(label.htmlFor) as HTMLInputElement).value).toBe('/keys/dev');
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
