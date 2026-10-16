// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
const mocks = vi.hoisted(() => ({ loadPage: vi.fn(), completed: vi.fn(), epoch: 0, host: 'local', configListeners: new Set<(path: string) => void>() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { loadSessionMetadataPage: mocks.loadPage } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  onConfigChange: (callback: (path: string) => void) => {
    mocks.configListeners.add(callback);
    return () => mocks.configListeners.delete(callback);
  },
} }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceId: () => mocks.host,
  surfaceScopedKey: (...parts: string[]) => JSON.stringify(parts),
  getActiveSurfaceScope: () => { const epoch = mocks.epoch; return { isCurrent: () => epoch === mocks.epoch }; },
}));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { useWorkspaceSessionDiscovery } from './useWorkspaceSessionDiscovery';

const page = (pending?: boolean): SessionMetadataPage => ({
  sessions: [], totalTopLevelCount: 107, loadedTopLevelCount: 5, hasMore: true, nextCursor: '5', discoveryPending: pending,
});
let current: ReturnType<typeof useWorkspaceSessionDiscovery>;
function Harness({ visible = true }: { visible?: boolean }) {
  current = useWorkspaceSessionDiscovery(['workspace'], visible, mocks.completed);
  return null;
}

describe('workspace discovery observation', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.epoch = 0;
    mocks.host = 'local';
    mocks.configListeners.clear();
    mocks.loadPage.mockResolvedValue(page(false));
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = async (visible = true) => { await act(async () => root.render(<Harness visible={visible} />)); };
  const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); };

  it('does not poll legacy or idle hosts', async () => {
    await render();
    await act(async () => current.observe('workspace', page()));
    await tick();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it('starts discovery for an already loaded workspace when its source switch changes', async () => {
    await render();
    await act(async () => current.observe('workspace', page(false)));
    mocks.loadPage.mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(false));
    await act(async () => {
      mocks.configListeners.forEach(callback => callback('app.external_session_discovery.codex'));
    });
    expect(mocks.loadPage).toHaveBeenCalledWith('workspace', 5, undefined, 'sessions_nav_discovery_settings', { fresh: true });
    expect(current.pending).toBe(true);
    await tick();
    expect(current.pending).toBe(false);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
  });

  it('refreshes filtered totals even when a settings-triggered scan finishes before the first response', async () => {
    await render();
    await act(async () => current.observe('workspace', page(false)));
    await act(async () => mocks.configListeners.forEach(callback => callback('app.external_session_discovery.codex')));
    expect(mocks.completed).toHaveBeenCalledExactlyOnceWith('workspace', expect.objectContaining({ totalTopLevelCount: 107 }));
    await tick();
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
  });

  it('does not read hidden workspaces for unrelated settings and resumes a saved discovery change on reveal', async () => {
    await render(false);
    await act(async () => mocks.configListeners.forEach(callback => callback('app.language')));
    await render();
    expect(mocks.loadPage).not.toHaveBeenCalled();
    await render(false);
    await act(async () => mocks.configListeners.forEach(callback => callback('app.external_session_discovery.codex')));
    expect(mocks.loadPage).not.toHaveBeenCalled();
    await render();
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
  });

  it('refreshes native metadata while discovery runs and reports the final pagination totals', async () => {
    mocks.loadPage.mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(false));
    await render();
    await act(async () => current.observe('workspace', page(true)));
    await tick();
    expect(current.pending).toBe(true);
    expect(mocks.completed).not.toHaveBeenCalled();
    await tick();
    expect(current.pending).toBe(false);
    expect(mocks.completed).toHaveBeenCalledWith('workspace', expect.objectContaining({ totalTopLevelCount: 107, hasMore: true }));
    await tick();
    expect(mocks.loadPage).toHaveBeenCalledTimes(2);
  });

  it('pauses observation while hidden and resumes without cancelling host work', async () => {
    await render(false);
    await act(async () => current.observe('workspace', page(true)));
    await tick();
    expect(mocks.loadPage).not.toHaveBeenCalled();
    await render();
    await tick();
    expect(mocks.completed).toHaveBeenCalledTimes(1);
  });

  it('reconciles completion observed by normal pagination before a polling request', async () => {
    await render();
    await act(async () => {
      current.observe('workspace', page(true));
      current.observe('workspace', page(false));
      current.observe('workspace', page(false));
    });
    expect(mocks.completed).toHaveBeenCalledTimes(1);
    expect(current.pending).toBe(false);
    await tick();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it('clears the previous host failure when the device changes', async () => {
    mocks.loadPage.mockRejectedValueOnce(new Error('Disconnected'));
    await render();
    await act(async () => current.observe('workspace', page(true)));
    await tick();
    expect(current.failed).toBe(true);
    mocks.host = 'peer';
    mocks.epoch += 1;
    await render();
    expect(current.failed).toBe(false);
    expect(current.pending).toBe(false);
  });

  it('isolates pending state and late responses across device switches', async () => {
    let resolve!: (value: SessionMetadataPage) => void;
    mocks.loadPage.mockReturnValue(new Promise<SessionMetadataPage>(yes => { resolve = yes; }));
    await render();
    await act(async () => current.observe('workspace', { ...page(true), discoveryWarnings: ['local issue'] }));
    await tick();
    mocks.host = 'peer';
    mocks.epoch += 1;
    await render();
    await act(async () => resolve(page(false)));
    expect(current.pending).toBe(false);
    expect(current.warnings).toEqual([]);
    expect(mocks.completed).not.toHaveBeenCalled();
    await tick();
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
  });

  it('offers retry after a disconnect without an unbounded failing request loop', async () => {
    mocks.loadPage.mockRejectedValueOnce(new Error('Disconnected'));
    await render();
    await act(async () => current.observe('workspace', page(true)));
    await tick();
    expect(current.failed).toBe(true);
    await tick();
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    await act(async () => current.retry());
    await tick();
    expect(current.failed).toBe(false);
    expect(current.pending).toBe(false);
  });
});
