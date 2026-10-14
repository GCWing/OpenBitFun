/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountIdentityError, type AccountIdentitySnapshot } from '@/infrastructure/account-identity';
import { OverviewAccountButton } from './OverviewAccountButton';

const mocks = vi.hoisted(() => ({
  status: 'signed-out',
  signIn: vi.fn(),
  reopenSignIn: vi.fn(),
  logout: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/infrastructure/account-identity', () => ({
  AccountIdentityError: class extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
  accountIdentityService: {
    getSnapshot: () => ({ status: mocks.status }),
    signIn: mocks.signIn,
    reopenSignIn: mocks.reopenSignIn,
    logout: mocks.logout,
  },
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ error: mocks.error }),
}));

let root: Root;
let container: HTMLDivElement;
const signedOut: AccountIdentitySnapshot = { resolved: true, status: 'signed-out', me: null };
const render = (identity = signedOut) => act(async () => { root.render(<OverviewAccountButton identity={identity} />); });
const click = () => act(async () => { container.querySelector('button')?.click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.status = 'signed-out';
  mocks.signIn.mockReset().mockResolvedValue(undefined);
  mocks.reopenSignIn.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('overview account sign-in', () => {
  it('starts the shared account flow from the sign-in button', async () => {
    await render();
    expect(container.textContent).toBe('account.signIn');
    await click();
    expect(mocks.signIn).toHaveBeenCalledOnce();
  });

  it('reopens a pending authorization even before the next identity render', async () => {
    await render();
    mocks.status = 'authorizing';
    await click();
    expect(mocks.reopenSignIn).toHaveBeenCalledOnce();
    expect(mocks.signIn).not.toHaveBeenCalled();
    await render({ ...signedOut, status: 'authorizing' });
    expect(container.textContent).toBe('account.continue');
    expect(container.querySelector('button')?.disabled).toBe(false);
  });

  it('waits for identity resolution and switches to sign-out after sign-in', async () => {
    await render({ ...signedOut, resolved: false, status: 'loading' });
    expect(container.querySelector('button')?.disabled).toBe(true);
    await click();
    expect(mocks.signIn).not.toHaveBeenCalled();
    await render({ ...signedOut, status: 'signed-in' });
    expect(container.textContent).toBe('account.signOut');
    await click();
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it('keeps sign-out retryable after a failed logout', async () => {
    mocks.logout.mockRejectedValue(new Error('Host unavailable'));
    await render({ ...signedOut, status: 'signed-in' });
    await click();
    expect(mocks.error).toHaveBeenCalledWith('account.signOutFailed');
    expect(container.textContent).toBe('account.signOut');
    expect(container.querySelector('button')?.disabled).toBe(false);
  });

  it.each([
    ['cancelled', null],
    ['expired', 'account.expired'],
    ['failed', 'account.failed'],
  ] as const)('handles %s authorization without an unhandled rejection', async (code, message) => {
    mocks.signIn.mockRejectedValue(new AccountIdentityError(code, 'Authorization ended'));
    await render();
    await click();
    if (message) expect(mocks.error).toHaveBeenCalledWith(message);
    else expect(mocks.error).not.toHaveBeenCalled();
  });
});
