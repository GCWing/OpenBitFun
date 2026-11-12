/**
 * @vitest-environment jsdom
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerHostInvokeBridge } from './PeerHostInvokeBridge';

interface BridgeEvent {
  payload: {
    id: string;
    command: string;
    args: unknown;
  };
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  unlisten: vi.fn(),
  listener: null as null | ((event: BridgeEvent) => Promise<void>),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (
    _event: string,
    listener: (event: BridgeEvent) => Promise<void>,
  ) => {
    mocks.listener = listener;
    return mocks.unlisten;
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PeerHostInvokeBridge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.invoke.mockReset();
    mocks.unlisten.mockReset();
    mocks.listener = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PeerHostInvokeBridge />);
    });
    await vi.waitFor(() => expect(mocks.listener).not.toBeNull());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reports bridge readiness after the listener registers and withdraws it on unmount', async () => {
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'peer_host_bridge_ready',
      { request: { ready: true } },
    ));
    act(() => root.unmount());
    expect(mocks.unlisten).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenLastCalledWith('peer_host_bridge_ready', { request: { ready: false } });
    root = createRoot(container);
  });

  it('executes duplicate dialog submissions once and completes every RPC', async () => {
    const startResult = deferred<{ success: boolean }>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'start_dialog_turn') {
        return startResult.promise;
      }
      if (command === 'peer_host_invoke_complete') {
        return Promise.resolve();
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const args = {
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        userInput: 'hello',
      },
    };

    const first = mocks.listener?.({
      payload: {
        id: 'rpc-1',
        command: 'start_dialog_turn',
        args,
      },
    });
    const retry = mocks.listener?.({
      payload: {
        id: 'rpc-2',
        command: 'start_dialog_turn',
        args,
      },
    });
    await Promise.resolve();

    expect(mocks.invoke.mock.calls.filter(
      ([command]) => command === 'start_dialog_turn',
    )).toHaveLength(1);

    startResult.resolve({ success: true });
    await Promise.all([first, retry]);

    const completions = mocks.invoke.mock.calls.filter(
      ([command]) => command === 'peer_host_invoke_complete',
    );
    expect(completions).toHaveLength(2);
    expect(completions.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ id: 'rpc-1', ok: true }),
      expect.objectContaining({ id: 'rpc-2', ok: true }),
    ]);
  });
});
