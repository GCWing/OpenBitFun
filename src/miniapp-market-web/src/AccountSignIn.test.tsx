// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountSignIn } from './AccountSignIn';

const api = vi.hoisted(() => ({ config: vi.fn(), sendEmailCode: vi.fn(), verifyEmailCode: vi.fn() }));
vi.mock('./api', () => ({ marketApi: api }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/sign-in?locale=en-US#ticket=device-ticket');
  api.config.mockResolvedValue({ emailAuthConfigured: true, githubAuthConfigured: true });
  api.sendEmailCode.mockResolvedValue({ challengeId: 'challenge', retryAfterSeconds: 60 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<AccountSignIn />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
});
async function input(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
it('sends the selected locale and preserves all eight digits including leading zeroes', async () => {
  await input('sign-in-email', 'alice@example.com');
  await submit();
  expect(api.sendEmailCode).toHaveBeenCalledWith('device-ticket', 'alice@example.com', 'en-US');
  const code = container.querySelector<HTMLInputElement>('#sign-in-code')!;
  expect(code.minLength).toBe(8);
  expect(code.maxLength).toBe(8);
  code.value = '123456';
  expect(code.checkValidity()).toBe(false);
  await input('sign-in-code', '00123456');
  expect(code.checkValidity()).toBe(true);
  api.verifyEmailCode.mockRejectedValue({ code: 'invalid_email_code' });
  await submit();
  expect(api.verifyEmailCode).toHaveBeenCalledWith('device-ticket', 'challenge', '00123456');
  expect(container.querySelector('form')).not.toBeNull();
});
it('stops retrying an expired device ticket and tells the user to return to the originating app', async () => {
  api.sendEmailCode.mockRejectedValue({ code: 'login_flow_expired' });
  await input('sign-in-email', 'alice@example.com');
  await submit();
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('start sign-in again from the app or website');
  expect(window.location.hash).toBe('#ticket=device-ticket');
});
it('distinguishes mail delivery failures from invalid verification codes', async () => {
  api.sendEmailCode.mockRejectedValue({ code: 'email_delivery_failed' });
  await input('sign-in-email', 'alice@example.com');
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't send the email");
  expect(container.querySelector('form')).not.toBeNull();
});

it('remembers only the exact native app callback target', async () => {
  window.history.replaceState(null, '', '/sign-in?returnTo=openbitfun%3A%2F%2Fauth%2Fcallback#ticket=device-ticket');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<AccountSignIn />));
  expect(sessionStorage.getItem('openbitfun.auth.returnTo')).toBe('openbitfun://auth/callback');

  window.history.replaceState(null, '', '/sign-in?returnTo=https%3A%2F%2Fevil.example%2F#ticket=device-ticket');
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<AccountSignIn />));
  expect(sessionStorage.getItem('openbitfun.auth.returnTo')).toBeNull();
});
