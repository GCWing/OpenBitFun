/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useMiniAppAgentSurface } from './useMiniAppAgentSurface';

const mocks = vi.hoisted(() => ({
  handlers: new Set<(request: unknown) => void>(),
  markReady: vi.fn(async (_ready: boolean) => undefined),
  reportResult: vi.fn(async (_report: unknown) => undefined),
  handleRequest: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/infrastructure/api/service-api/MiniAppPresentationAPI', async () => {
  const { getActiveSurfaceId } = await import('@/infrastructure/peer-device/deviceSurface');
  return { hasLocalMiniAppPresentation: () => getActiveSurfaceId() === 'local' };
});
vi.mock('@/infrastructure/api/service-api/MiniAppAgentSurfaceAPI', () => ({
  miniAppAgentSurfaceAPI: {
    markReady: mocks.markReady,
    reportResult: mocks.reportResult,
    listenRequests: (handler: (request: unknown) => void) => {
      mocks.handlers.add(handler);
      return () => mocks.handlers.delete(handler);
    },
  },
}));
vi.mock('@/app/stores/sceneStore', () => ({ useSceneStore: { getState: () => ({ openScene: vi.fn() }) } }));
vi.mock('../miniAppPresentationStore', () => ({
  ensureMiniAppTab: vi.fn(),
  useMiniAppPresentationStore: { getState: () => ({ tabs: {} }) },
}));
vi.mock('./miniAppAgentSurfaceRegistry', () => ({ releaseMiniAppAgentSurfaces: mocks.release }));
vi.mock('./miniAppAgentRouter', () => ({
  MINIAPP_AGENT_OPEN_TIMEOUT_MS: 60_000,
  handleMiniAppAgentRequest: mocks.handleRequest,
}));

function Surface() {
  useMiniAppAgentSurface();
  return null;
}

describe('MiniApp Agent device surface lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetDeviceSurfaceForTest();
    mocks.handlers.clear();
    vi.clearAllMocks();
    mocks.handleRequest.mockResolvedValue({ ok: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetDeviceSurfaceForTest();
  });

  it('detaches locally on Peer activation and reattaches on return', async () => {
    await act(async () => root.render(<Surface />));
    expect(mocks.markReady).toHaveBeenLastCalledWith(true);
    expect(mocks.handlers.size).toBe(1);
    await act(async () => { activateSurface('peer-b'); });
    expect(mocks.markReady).toHaveBeenLastCalledWith(false);
    expect(mocks.handlers.size).toBe(0);
    expect(mocks.release).toHaveBeenCalled();
    await act(async () => { activateSurface('local'); });
    expect(mocks.markReady).toHaveBeenLastCalledWith(true);
    expect(mocks.handlers.size).toBe(1);
    await act(async () => {
      for (const handler of mocks.handlers) handler({ requestId: 'returned', action: 'open', appId: 'demo' });
    });
    expect(mocks.reportResult).toHaveBeenCalledWith({ requestId: 'returned', success: true, result: { ok: true } });
  });

  it('fences an in-flight local response after switching to a Peer', async () => {
    let finish!: (value: unknown) => void;
    mocks.handleRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<Surface />));
    const originalScope = getActiveSurfaceScope();
    await act(async () => {
      for (const handler of mocks.handlers) handler({ requestId: 'old', action: 'open', appId: 'demo' });
    });
    expect(mocks.handleRequest.mock.calls[0][1].signal).toBe(originalScope.signal);
    await act(async () => { activateSurface('peer-b'); });
    expect(originalScope.signal.aborted).toBe(true);
    await act(async () => { finish({ wrongDevice: true }); });
    expect(mocks.reportResult).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'old', success: false, error: expect.stringContaining('SURFACE_UNAVAILABLE:'),
    }));
    expect(mocks.reportResult).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('keeps mounted local frames when only the activation epoch changes', async () => {
    await act(async () => root.render(<Surface />));
    await act(async () => { activateSurface('local'); });
    expect(mocks.markReady).toHaveBeenLastCalledWith(true);
    expect(mocks.handlers.size).toBe(1);
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
