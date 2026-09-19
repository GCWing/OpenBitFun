// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountIdentityControls } from './AccountIdentityControls';
import { calculateAccountIdentityMenuPosition } from './marketAccountMenuPosition';

const mocks = vi.hoisted(() => ({
  account: {
    resolved: true,
    status: 'signed-out',
    me: null as null | {
      user: { githubId: number; login: string; avatarUrl: string };
      isAdmin: boolean;
    },
    lastError: undefined,
  },
  signIn: vi.fn(),
  reopenSignIn: vi.fn(),
  cancelSignIn: vi.fn(),
  logout: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/infrastructure/account-identity', () => ({
  AccountIdentityError: class AccountIdentityError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  accountIdentityService: {
    signIn: mocks.signIn,
    reopenSignIn: mocks.reopenSignIn,
    cancelSignIn: mocks.cancelSignIn,
    logout: mocks.logout,
  },
  useAccountIdentity: () => mocks.account,
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ success: mocks.success, error: mocks.error }),
}));

vi.mock('@openbitfun/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Avatar: ({ src, alt }: any) => <img src={src} alt={alt} />,
  Icon: ({ name, ...props }: { name: string } & React.HTMLAttributes<HTMLSpanElement>) => <span data-icon={name} {...props} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Menu: ({ children, ...props }: any) => <div role="menu" {...props}>{children}</div>,
  MenuItem: ({ children, leading, ...props }: any) => (
    <button type="button" role="menuitem" {...props}>{leading}{children}</button>
  ),
  Dialog: ({ open, children }: any) => open ? (
    <section role="dialog">{children}</section>
  ) : null,
  DialogBody: ({ children }: any) => <div>{children}</div>,
  DialogClose: (props: any) => <button type="button" {...props} />,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogHeading: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

describe('AccountIdentityControls', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mocks.account.resolved = true;
    mocks.account.status = 'signed-out';
    mocks.account.me = null;
    mocks.account.lastError = undefined;
    mocks.signIn.mockReset().mockResolvedValue({
      user: { githubId: 42, login: 'octocat', avatarUrl: '' },
      isAdmin: false,
    });
    mocks.cancelSignIn.mockReset();
    mocks.reopenSignIn.mockReset().mockResolvedValue(undefined);
    mocks.logout.mockReset().mockResolvedValue(undefined);
    mocks.success.mockReset();
    mocks.error.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
  });

  it('opens the shared GitHub login dialog and starts the vault-backed flow', async () => {
    await act(async () => root.render(<AccountIdentityControls />));
    const signIn = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('market.signIn'));
    await act(async () => signIn?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const continueButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('market.account.continue'));
    await act(async () => continueButton?.click());
    expect(mocks.signIn).toHaveBeenCalledOnce();
  });

  it('keeps a reopen action available while an external authorization is pending', async () => {
    mocks.account.status = 'authorizing';
    await act(async () => root.render(<AccountIdentityControls />));
    const trigger = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('market.signIn'))!;
    expect(trigger.disabled).toBe(false);
    await act(async () => trigger.click());
    const reopen = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('market.account.reopen'))!;
    expect(reopen.disabled).toBe(false);
    await act(async () => reopen.click());
    expect(mocks.reopenSignIn).toHaveBeenCalledOnce();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('shows the shared avatar menu and logs out through the same account service', async () => {
    mocks.account.status = 'signed-in';
    mocks.account.me = {
      user: { githubId: 42, login: 'octocat', avatarUrl: 'https://example.com/avatar.png' },
      isAdmin: false,
    };
    await act(async () => root.render(<AccountIdentityControls />));

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    await act(async () => trigger?.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.closest('[data-openbitfun-overlay-host]')?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    const logout = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(logout?.textContent).toContain('market.signOut');
    await act(async () => logout?.click());
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it('keeps the portalled menu aligned to the trigger and inside the viewport', () => {
    const position = calculateAccountIdentityMenuPosition(
      { top: 16, right: 218, bottom: 46 },
      { width: 230, height: 112 },
      { width: 240, height: 180 },
    );

    expect(position).toEqual({ top: 52, left: 8 });
    expect(
      calculateAccountIdentityMenuPosition(
        { top: 150, right: 218, bottom: 180 },
        { width: 230, height: 112 },
        { width: 240, height: 200 },
      ),
    ).toEqual({ top: 32, left: 8 });
  });
});
