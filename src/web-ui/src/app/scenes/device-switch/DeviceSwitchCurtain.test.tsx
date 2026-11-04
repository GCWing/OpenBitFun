// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { beginDeviceOpen, endDeviceOpen } from '@/infrastructure/peer-device/deviceOpenIntent';
import { DEVICE_SWITCH_CURTAIN_LEAVE_MS, DeviceSwitchCurtain } from './DeviceSwitchCurtain';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('DeviceSwitchCurtain', () => {
  let host: HTMLDivElement;
  let root: Root;
  const curtain = () => host.querySelector('[data-testid="device-switch-curtain"]');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<DeviceSwitchCurtain />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

  it('covers the workbench for the whole open and fades out after the target painted', () => {
    expect(curtain()).toBeNull();
    let intent!: ReturnType<typeof beginDeviceOpen>;
    act(() => { intent = beginDeviceOpen({ surfaceId: 'peer', key: 'new:w' }); });
    expect(curtain()?.getAttribute('data-phase')).toBe('covering');
    act(() => endDeviceOpen(intent));
    // Still covering until two frames passed.
    expect(curtain()?.getAttribute('data-phase')).toBe('covering');
    act(() => { vi.advanceTimersByTime(40); });
    expect(curtain()?.getAttribute('data-phase')).toBe('leaving');
    act(() => { vi.advanceTimersByTime(DEVICE_SWITCH_CURTAIN_LEAVE_MS); });
    expect(curtain()).toBeNull();
  });

  it('leaves existing-session opens to the held session tab and its own skeleton', () => {
    let intent!: ReturnType<typeof beginDeviceOpen>;
    act(() => { intent = beginDeviceOpen({ surfaceId: 'peer', key: 'session:s', sessionId: 's' }); });
    expect(curtain()).toBeNull();
    act(() => endDeviceOpen(intent));
  });
});
