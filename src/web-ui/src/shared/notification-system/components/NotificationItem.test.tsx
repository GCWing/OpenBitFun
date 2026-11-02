import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '../types';
import { NotificationItem } from './NotificationItem';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('../services/NotificationService', () => ({
  notificationService: { dismiss: vi.fn() },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('NotificationItem accessibility', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    container = document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('announces an actionable error while focus remains in the composer', () => {
    const notification: Notification = {
      id: 'session-conflict',
      type: 'error',
      variant: 'toast',
      title: 'Session is in use',
      message: 'Close the other instance and retry.',
      timestamp: 1,
      duration: 0,
      closable: true,
      actions: [
        { label: 'Retry', onClick: vi.fn(), variant: 'primary' },
        { label: 'Delete', onClick: vi.fn(), variant: 'danger' },
      ],
      status: 'active',
    };

    act(() => root.render(<NotificationItem notification={notification} />));

    const item = container.querySelector('.notification-item');
    expect(item?.getAttribute('role')).toBe('alert');
    expect(item?.getAttribute('aria-live')).toBe('assertive');
    expect(item?.getAttribute('aria-atomic')).toBe('true');
    expect(container.querySelector('.notification-item__actions [data-openbitfun-component="button"]')?.textContent).toBe('Retry');
    const retryAction = container.querySelector<HTMLButtonElement>('.notification-item__actions [data-openbitfun-component="button"]')!;
    expect(retryAction.getAttribute('data-openbitfun-variant')).toBe('primary');
    act(() => retryAction.click());
    expect(notification.actions![0].onClick).toHaveBeenCalledOnce();
    const dangerAction = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.notification-item__actions [data-openbitfun-component="button"]'),
    ).find(button => button.textContent === 'Delete');
    expect(dangerAction?.getAttribute('data-openbitfun-variant')).toBe('fill');
    expect(dangerAction?.getAttribute('data-openbitfun-tone')).toBe('danger');
    expect(
      container.querySelector('[data-openbitfun-part="itemClose"] [data-openbitfun-component="icon-button"]')
        ?.getAttribute('aria-label'),
    ).toBe('actions.close');
    const closeButton = container.querySelector('[data-openbitfun-part="itemClose"] [data-openbitfun-component="icon-button"]');
    expect(closeButton?.getAttribute('data-openbitfun-shape')).toBe('circle');
    expect(closeButton?.getAttribute('data-openbitfun-variant')).toBe('fill');
    expect(closeButton?.getAttribute('data-size')).toBe('xs');
    expect(item?.classList.contains('notification-item--closable')).toBe(true);
  });

  it('uses shared catalog icons for supported notification semantics', () => {
    const notification: Notification = {
      id: 'saved',
      type: 'success',
      variant: 'toast',
      title: 'Saved',
      message: 'Your changes were saved.',
      timestamp: 1,
      duration: 0,
      closable: false,
      status: 'active',
    };

    act(() => root.render(<NotificationItem notification={notification} />));

    expect(
      container.querySelector('[data-openbitfun-part="itemIcon"] [data-openbitfun-component="icon"]')
        ?.getAttribute('data-openbitfun-name'),
    ).toBe('check-circle');
  });
});
