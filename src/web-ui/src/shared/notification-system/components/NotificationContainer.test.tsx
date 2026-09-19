import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '../types';
import { useActiveNotifications } from '../hooks/useNotificationState';
import { NotificationContainer } from './NotificationContainer';
import { Dialog } from '@openbitfun/ui';
import { notificationService } from '../services/NotificationService';

vi.mock('../hooks/useNotificationState', () => ({
  useActiveNotifications: vi.fn(),
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../services/NotificationService', () => ({
  notificationService: { dismiss: vi.fn() },
}));

vi.mock('./ProgressNotification', () => ({
  ProgressNotification: ({ notification }: { notification: Notification }) => (
    <div data-variant="progress">{notification.message}</div>
  ),
}));

vi.mock('./LoadingNotification', () => ({
  LoadingNotification: ({ notification }: { notification: Notification }) => (
    <div data-variant="loading">{notification.message}</div>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const notification = (variant: Notification['variant'], message: string): Notification => ({
  id: `${variant}-${message}`,
  type: 'info',
  variant,
  title: 'Test',
  message,
  timestamp: 1,
  status: 'active',
});

describe('NotificationContainer', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    container = document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.clearAllMocks();
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('keeps task notifications in the notification center instead of the toast stack', () => {
    vi.mocked(useActiveNotifications).mockReturnValue([
      notification('toast', 'Saved'),
      notification('progress', 'Indexing'),
      notification('loading', 'Connecting'),
    ]);

    act(() => root.render(<NotificationContainer />));

    expect(document.querySelector('.notification-item')?.textContent).toContain('Saved');
    expect(document.querySelector('[data-variant="progress"]')).toBeNull();
    expect(document.querySelector('[data-variant="loading"]')).toBeNull();
  });

  it('keeps silent notifications out of the toast stack', () => {
    vi.mocked(useActiveNotifications).mockReturnValue([notification('silent', 'Background')]);

    act(() => root.render(<NotificationContainer />));

    expect(document.querySelector('.notification-container')).toBeNull();
  });

  it('retains a dismissed toast until its exit motion completes', () => {
    vi.useFakeTimers();
    vi.mocked(useActiveNotifications).mockReturnValue([notification('toast', 'Saved')]);

    act(() => root.render(<NotificationContainer />));
    expect(document.querySelector('.notification-item')?.textContent).toContain('Saved');

    vi.mocked(useActiveNotifications).mockReturnValue([]);
    act(() => root.render(<NotificationContainer />));

    expect(document.querySelector('.notification-container__presence--exiting')).not.toBeNull();
    expect(document.querySelector('.notification-item')?.textContent).toContain('Saved');

    act(() => vi.advanceTimersByTime(140));
    expect(document.querySelector('.notification-container')).toBeNull();
  });

  it('removes focus before making an exiting real notification item inert', () => {
    vi.useFakeTimers();
    vi.mocked(useActiveNotifications).mockReturnValue([{
      ...notification('toast', 'Action required'),
      closable: true,
      actions: [{ label: 'Retry', onClick: vi.fn() }],
    }]);

    act(() => root.render(<NotificationContainer />));
    const action = document.querySelector('.notification-item__actions [data-openbitfun-component="button"]') as HTMLButtonElement;
    action.focus();
    expect(document.activeElement).toBe(action);

    vi.mocked(useActiveNotifications).mockReturnValue([]);
    act(() => root.render(<NotificationContainer />));

    const presence = document.querySelector('.notification-container__presence--exiting');
    expect(document.activeElement).not.toBe(action);
    expect(presence?.getAttribute('aria-hidden')).toBe('true');
    expect(presence?.hasAttribute('inert')).toBe(true);
    expect(presence?.querySelector('.notification-item')).not.toBeNull();
  });

  it('starts toast expiry only when a queued notification is actually presented', () => {
    vi.useFakeTimers();
    const toast = { ...notification('toast', 'Saved'), duration: 1000 };
    vi.mocked(useActiveNotifications).mockReturnValue([toast]);
    const render = (modal: boolean) => act(() => root.render(<>
      <NotificationContainer />
      <Dialog open={modal} onOpenChange={() => undefined}><button>Confirm</button></Dialog>
    </>));
    render(true);
    act(() => vi.advanceTimersByTime(5000));
    expect(document.querySelector('.notification-item')).toBeNull();
    expect(notificationService.dismiss).not.toHaveBeenCalled();
    render(false);
    act(() => vi.advanceTimersByTime(180));
    expect(document.querySelector('.notification-item')).not.toBeNull();
    act(() => vi.advanceTimersByTime(999));
    expect(notificationService.dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(notificationService.dismiss).toHaveBeenCalledWith(toast.id);
  });

  it('preserves remaining display time while a later modal covers the toast', () => {
    vi.useFakeTimers();
    const toast = { ...notification('toast', 'Saved'), duration: 1000 };
    vi.mocked(useActiveNotifications).mockReturnValue([toast]);
    const render = (modal: boolean) => act(() => root.render(<>
      <NotificationContainer />
      <Dialog open={modal} onOpenChange={() => undefined}><button>Confirm</button></Dialog>
    </>));
    render(false);
    act(() => vi.advanceTimersByTime(350));
    render(true);
    act(() => vi.advanceTimersByTime(5000));
    expect(notificationService.dismiss).not.toHaveBeenCalled();
    render(false);
    act(() => vi.advanceTimersByTime(180));
    act(() => vi.advanceTimersByTime(649));
    expect(notificationService.dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(notificationService.dismiss).toHaveBeenCalledWith(toast.id);
  });
});
