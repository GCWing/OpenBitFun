// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

import { useDeviceDirectory } from '@/infrastructure/account/deviceDirectory';
import { PeerUpdatesPausedNotice } from './PeerUpdatesPausedNotice';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('PeerUpdatesPausedNotice', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('names the device whose updates are paused and re-reads on retry', () => {
    useDeviceDirectory.setState({ devices: [] });
    const onRetry = vi.fn();
    act(() => root.render(<PeerUpdatesPausedNotice surfaceId="device-a" onRetry={onRetry} />));
    const notice = host.querySelector('[data-testid="peer-updates-paused-notice"]');
    expect(notice?.textContent).toContain('historyState.updatesPaused:{"device":"device-a"}');
    act(() => host.querySelector('button')?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('never appears for the local runtime', () => {
    act(() => root.render(<PeerUpdatesPausedNotice surfaceId="local" onRetry={vi.fn()} />));
    expect(host.querySelector('[data-testid="peer-updates-paused-notice"]')).toBeNull();
  });
});
