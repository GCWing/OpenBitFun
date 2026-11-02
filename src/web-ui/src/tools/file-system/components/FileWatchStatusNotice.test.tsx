// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileWatchStatusNotice } from './FileWatchStatusNotice';
import type { FileWatchStatus } from '@/infrastructure/api/service-api/tauri-commands';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderNotice(status: FileWatchStatus, onRetry = () => {}) {
  act(() => {
    root.render(<FileWatchStatusNotice status={status} retrying={false} onRetry={onRetry} />);
  });
}

const limitFailure = (hint: string | null): FileWatchStatus => ({
  healthy: false,
  watchedPaths: ['/repo'],
  failure: {
    code: 'watch_limit_exceeded',
    detail: 'OS file watch limit reached. (fs.inotify.max_user_watches=65536)',
    hint,
    path: '/repo',
  },
});

it('shows the platform hint verbatim when the host supplied one', () => {
  renderNotice(limitFailure('sudo sysctl -w fs.inotify.max_user_watches=524288'));

  expect(container.querySelector('.openbitfun-file-watch-notice__reason')?.textContent)
    .toBe('watch.reason.watchLimitExceeded');
  expect(container.querySelector('.openbitfun-file-watch-notice__hint')?.textContent)
    .toBe('sudo sysctl -w fs.inotify.max_user_watches=524288');
});

it('omits the hint block when the host has no remediation command', () => {
  renderNotice(limitFailure(null));

  expect(container.querySelector('.openbitfun-file-watch-notice__hint')).toBeNull();
  expect(container.querySelector('.openbitfun-file-watch-notice__reason')?.textContent)
    .toBe('watch.reason.watchLimitExceeded');
});

it('falls back to the generic reason for a backend failure', () => {
  renderNotice({
    healthy: false,
    watchedPaths: [],
    failure: { code: 'backend_unavailable', detail: 'denied', hint: null, path: null },
  });

  expect(container.querySelector('.openbitfun-file-watch-notice__reason')?.textContent)
    .toBe('watch.reason.backendUnavailable');
  expect(container.querySelector('[data-watch-failure-code]')?.getAttribute('data-watch-failure-code'))
    .toBe('backend_unavailable');
});

it('runs the retry callback from the notice action', () => {
  const onRetry = vi.fn();
  renderNotice(limitFailure(null), onRetry);

  act(() => {
    container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  expect(onRetry).toHaveBeenCalledTimes(1);
});
