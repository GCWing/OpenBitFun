// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionHealth } from '../../../../../mobile-web/src/hooks/useConnectionHealth';
import { AccountIdentityChangedError } from '../../../../../mobile-web/src/services/RelayHttpClient';
import {
  RemoteControlTargetChangedError,
  type RemoteSessionManager,
} from '../../../../../mobile-web/src/services/RemoteSessionManager';
import { useMobileStore } from '../../../../../mobile-web/src/services/store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ manager }: { manager: RemoteSessionManager }) {
  useConnectionHealth(manager);
  return null;
}

describe('mobile connection health target generations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useMobileStore.getState().setConnectionHealth('unpaired');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('drops an in-flight A ping and immediately probes B after a target switch', async () => {
    const pingA = deferred<void>();
    let onTargetChange: (() => void) | undefined;
    const ping = vi.fn()
      .mockImplementationOnce(() => pingA.promise)
      .mockResolvedValueOnce(undefined);
    const manager = {
      ping,
      relayStatus: 'connected',
      controlTargetPresence: () => ({ online: true, lastSeenAt: null }),
      onRecoverySignal: () => () => {},
      onRelayStatus: () => () => {},
      onControlTargetPresenceChange: () => () => {},
      onControlTargetChange: (listener: () => void) => {
        onTargetChange = listener;
        return () => { onTargetChange = undefined; };
      },
    } as unknown as RemoteSessionManager;

    await act(async () => {
      root.render(<Harness manager={manager} />);
    });
    expect(ping).toHaveBeenCalledTimes(1);

    await act(async () => {
      onTargetChange?.();
      await Promise.resolve();
    });
    expect(ping).toHaveBeenCalledTimes(2);
    expect(useMobileStore.getState().connectionHealth).toBe('connected');

    await act(async () => {
      pingA.reject(new RemoteControlTargetChangedError());
      await Promise.resolve();
    });
    expect(useMobileStore.getState().connectionHealth).toBe('connected');
  });

  it('retries a account identity transition without publishing unreachable', async () => {
    vi.useFakeTimers();
    const ping = vi.fn()
      .mockRejectedValueOnce(new AccountIdentityChangedError())
      .mockResolvedValueOnce(undefined);
    const manager = {
      ping,
      relayStatus: 'connected',
      controlTargetPresence: () => ({ online: true, lastSeenAt: null }),
      onRecoverySignal: () => () => {},
      onRelayStatus: () => () => {},
      onControlTargetPresenceChange: () => () => {},
      onControlTargetChange: () => () => {},
    } as unknown as RemoteSessionManager;

    await act(async () => {
      root.render(<Harness manager={manager} />);
      await Promise.resolve();
    });
    expect(useMobileStore.getState().connectionHealth).toBe('checking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(ping).toHaveBeenCalledTimes(2);
    expect(useMobileStore.getState().connectionHealth).toBe('connected');
  });
});
