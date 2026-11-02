/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { OverviewAccountButton } from './OverviewAccountButton';

const mocks = vi.hoisted(() => ({
  identity: { resolved: true, status: 'signed-out', me: null } as AccountIdentitySnapshot,
  signIn: vi.fn(), reopenSignIn: vi.fn(), cancelSignIn: vi.fn(), logout: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}));
vi.mock('@/infrastructure/account-identity', () => ({
  AccountIdentityError: class extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
  accountIdentityService: {
    signIn: mocks.signIn, reopenSignIn: mocks.reopenSignIn, cancelSignIn: mocks.cancelSignIn, logout: mocks.logout,
  },
  useAccountIdentity: () => mocks.identity,
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ error: mocks.error, success: mocks.success }),
}));

let root: Root;
let container: HTMLDivElement;
const signedOut: AccountIdentitySnapshot = { resolved: true, status: 'signed-out', me: null };
const me = { email: 'alice@example.com', user: { githubId: 42, login: 'alice', avatarUrl: '' }, isAdmin: false };
const render = (identity = signedOut) => act(async () => {
  mocks.identity = identity;
  root.render(<OverviewAccountButton identity={identity} />);
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.identity = signedOut;
  vi.clearAllMocks();
  mocks.logout.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
});

describe('overview signed-in account', () => {
  it.each(['signed-out', 'loading', 'authorizing'] as const)('omits the top-right entry while %s, including cached identity data', async status => {
    await render({ resolved: status !== 'loading', status, me });
    expect(container.childElementCount).toBe(0);
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.reopenSignIn).not.toHaveBeenCalled();
  });

  it('shows the email account menu only after sign-in and hides it again after sign-out', async () => {
    await render({ resolved: true, status: 'signed-in', me });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(trigger.textContent).toContain('alice@example.com');
    expect(container.textContent).not.toContain('market.signIn');
    await act(async () => trigger.click());
    const logout = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(logout.textContent).toContain('market.signOut');
    await act(async () => logout.click());
    expect(mocks.logout).toHaveBeenCalledOnce();
    await render();
    expect(container.childElementCount).toBe(0);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('continues to display a legacy username without optional email metadata', async () => {
    await render({ resolved: true, status: 'signed-in', me: { user: me.user, isAdmin: false } });
    expect(container.querySelector('[aria-haspopup="menu"]')?.textContent).toContain('@alice');
  });
});
