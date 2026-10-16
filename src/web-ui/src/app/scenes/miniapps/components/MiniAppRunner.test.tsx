/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MiniApp } from '@/infrastructure/api/service-api/MiniAppAPI';
import MiniAppRunner from './MiniAppRunner';

const bridgeMock = vi.hoisted(() => ({
  ready: false,
  useMiniAppBridge: vi.fn(),
}));

vi.mock('../hooks/useMiniAppBridge', () => ({
  useMiniAppBridge: (...args: unknown[]) => {
    bridgeMock.useMiniAppBridge(...args);
    return bridgeMock.ready;
  },
}));

const app = {
  id: 'market-lens',
  name: 'Market Lens',
  compiled_html: '<!doctype html><html><body>Market Lens</body></html>',
  permissions: {},
  source: {},
} as unknown as MiniApp;

describe('MiniAppRunner strict bridge startup', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridgeMock.ready = false;
    createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:market-lens-1')
      .mockReturnValueOnce('blob:market-lens-2');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads strict HTML from a sandboxed blob only after the bridge is listening', async () => {
    await act(async () => {
      root?.render(<MiniAppRunner app={app} strictRuntime />);
    });

    let iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(iframe.getAttribute('srcdoc')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();

    bridgeMock.ready = true;
    await act(async () => {
      root?.render(<MiniAppRunner app={app} strictRuntime />);
    });

    iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(iframe.getAttribute('src')).toBe('blob:market-lens-1');
    expect(iframe.getAttribute('srcdoc')).toBeNull();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-downloads');

    const updatedApp = {
      ...app,
      compiled_html: '<!doctype html><html><body>Updated</body></html>',
    };
    await act(async () => {
      root?.render(<MiniAppRunner app={updatedApp} strictRuntime />);
    });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:market-lens-1');
    iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('blob:market-lens-2');

    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:market-lens-2');
  });
  it('delivers only declared enabled chrome actions to its own iframe and releases the binding', async () => {
    const ref = { current: null as ((actionId: string) => void) | null };
    const customApp = { ...app, chrome: { titlebar: { actions: [
      { id: 'export', icon: 'download' as const, label: 'Export' },
      { id: 'disabled', icon: 'save' as const, label: 'Save', enabled: false },
    ] } } };
    await act(async () => { root?.render(<MiniAppRunner app={customApp} strictRuntime chromeActionRef={ref} />); });
    const target = container.querySelector('iframe')!.contentWindow!;
    const send = vi.spyOn(target, 'postMessage');
    ref.current?.('export');
    ref.current?.('disabled');
    ref.current?.('unknown');
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'openbitfun:event', event: 'chrome:action', payload: { actionId: 'export' } }, '*');
    act(() => { root?.unmount(); }); root = null;
    expect(ref.current).toBeNull();
  });

  it('acknowledges a loaded document once, never the initial blank frame', async () => {
    const ready = vi.fn();
    await act(async () => { root?.render(<MiniAppRunner app={app} strictRuntime onReady={ready} />); });
    await act(async () => { container.querySelector('iframe')?.dispatchEvent(new Event('load')); });
    expect(ready).not.toHaveBeenCalled();
    bridgeMock.ready = true;
    await act(async () => { root?.render(<MiniAppRunner app={app} strictRuntime onReady={ready} />); });
    expect(ready).not.toHaveBeenCalled();
    await act(async () => { container.querySelector('iframe')?.dispatchEvent(new Event('load')); });
    await act(async () => { container.querySelector('iframe')?.dispatchEvent(new Event('load')); });
    expect(ready).toHaveBeenCalledTimes(1);
  });

});
