// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
const mocks = vi.hoisted(() => ({
  read: vi.fn(), config: vi.fn(), completed: vi.fn(), host: 'local', epoch: 0,
  listeners: new Set<(path: string, oldValue?: unknown, newValue?: unknown) => void>(),
}));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: { listSessionsPage: mocks.read } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  getOptionalConfig: mocks.config,
  onConfigChange: (callback: (path: string, oldValue?: unknown, newValue?: unknown) => void) => {
    mocks.listeners.add(callback);
    return () => mocks.listeners.delete(callback);
  },
} }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceId: () => mocks.host,
  surfaceScopedKey: (...parts: Array<string | number>) => JSON.stringify(parts),
  getActiveSurfaceScope: () => { const epoch = mocks.epoch; return { epoch, isCurrent: () => epoch === mocks.epoch }; },
}));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { useWorkspaceSessionDiscovery } from './useWorkspaceSessionDiscovery';
const page = (revision = 'original', overrides: Partial<SessionMetadataPage> = {}): SessionMetadataPage => ({
  sessions: [], totalTopLevelCount: 107, loadedTopLevelCount: 1, hasMore: true,
  catalogQuery: { workspaceId: 'workspace', ordering: 'updated', source: 'all' },
  catalogRevision: revision, discoveryRefreshed: true, ...overrides,
});
let current: ReturnType<typeof useWorkspaceSessionDiscovery>;
function Harness({ visible, ids }: { visible: boolean; ids: string[] }) {
  current = useWorkspaceSessionDiscovery(ids, visible, mocks.completed);
  return null;
}
describe('workspace discovery on reveal', () => {
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.host = 'local'; mocks.epoch = 0; mocks.listeners.clear();
    mocks.config.mockResolvedValue({ codex: true, zcode: false });
    mocks.read.mockResolvedValue(page());
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers(); vi.unstubAllGlobals();
  });
  const render = async (visible = true, ids = ['workspace']) => {
    await act(async () => root.render(<Harness visible={visible} ids={ids} />));
  };
  const observe = async (value = page(), id = 'workspace') => {
    await act(async () => current.observe(id, value));
  };
  const save = async (source = 'codex', enabled = false) => {
    await act(async () => mocks.listeners.forEach(callback => callback(
      `app.external_session_discovery.${source}`, !enabled, enabled,
    )));
  };
  const wait = () => {
    let resolve!: (value: SessionMetadataPage) => void;
    const promise = new Promise<SessionMetadataPage>(yes => { resolve = yes; });
    return { promise, resolve };
  };
  const advance = async () => { await act(async () => vi.advanceTimersByTimeAsync(3600000)); };

  it('waits for initial metadata, checks once, and never checks on a timer or window focus', async () => {
    await render(); await advance();
    expect(mocks.read).not.toHaveBeenCalled();
    await observe();
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'workspace', limit: 1, query: page().catalogQuery, refreshExternalDiscovery: true,
    });
    await advance();
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await render();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.completed).not.toHaveBeenCalled();
  });
  it('checks once on every reveal and publishes new sessions without toggling switches', async () => {
    await render(); await observe(); await render(false);
    mocks.read.mockResolvedValue(page('new-session'));
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await render();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.completed).toHaveBeenCalledExactlyOnceWith('workspace', page('new-session'));
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('keeps unchanged reveals quiet', async () => {
    await render(); await observe(); await render(false); await render();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(current.pending).toBe(false);
  });
  it('awaits a running scan with one request and no timed status reads', async () => {
    const scan = wait(); mocks.read.mockReturnValueOnce(scan.promise);
    await render(); await observe(page('original', { discoveryPending: true }));
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(current.pending).toBe(true);
    await act(async () => scan.resolve(page('new-session')));
    expect(current.pending).toBe(false);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it('does not check on reveal when all sources were already disabled', async () => {
    mocks.config.mockResolvedValue({ codex: false });
    await render(); await observe(); await render(false); await render(); await advance();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('applies disabling all sources once without replaying it on later reveals', async () => {
    await render(); await save();
    expect([...current.enabledSources ?? []]).toEqual([]);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
    await render(false); await render(); await render(false); await render(); await advance();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
  });
  it('coalesces hidden settings changes and applies the final all-disabled state', async () => {
    await render(false); await save(); await save('zcode', true); await save('zcode', false);
    expect(mocks.read).not.toHaveBeenCalled();
    await render();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await render(false); await render();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it('keeps failures recoverable without repeating successful workspace reads', async () => {
    await render(true, ['workspace', 'other']);
    mocks.read.mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('Disconnected'));
    await act(async () => { current.observe('workspace', page()); current.observe('other', page()); });
    expect(current.failed).toBe(true);
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => current.retry());
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(mocks.read.mock.calls[2][0].workspaceId).toBe('other');
    expect(current.failed).toBe(false);
  });
  it('does not consume a settings revision if the waiting request was cancelled by collapse', async () => {
    await render();
    const scan = wait(); mocks.read.mockReturnValueOnce(scan.promise);
    await save(); await render(false);
    await act(async () => scan.resolve(page()));
    expect(mocks.completed).not.toHaveBeenCalled();
    await render();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
  });
  it('does not let an older settings response overwrite a newer change', async () => {
    await render();
    const old = wait(); mocks.read.mockReturnValueOnce(old.promise);
    await save(); await save('zcode', true);
    await act(async () => old.resolve(page('old-settings')));
    expect([...current.enabledSources ?? []]).toEqual(['zcode']);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('isolates device activations and ignores departed-device responses', async () => {
    await render();
    const local = wait(); mocks.read.mockReturnValueOnce(local.promise);
    await observe();
    mocks.host = 'peer'; mocks.epoch += 1;
    await render();
    await act(async () => local.resolve(page('local-change')));
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await observe(page('peer-original'));
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('reports unsupported hosts instead of accepting a cached page as refreshed', async () => {
    mocks.read.mockResolvedValue(page('cached', { discoveryRefreshed: undefined }));
    await render(); await observe();
    expect(current.failed).toBe(true);
    expect(mocks.completed).not.toHaveBeenCalled();
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it('deduplicates structured diagnostics', async () => {
    await render(false);
    await observe(page('original', { discoveryDiagnostics: [
      { ecosystemId: 'cursor', code: 'workspace_unresolved' },
      { ecosystemId: 'cursor', code: 'workspace_unresolved' },
    ] }));
    expect(current.diagnostics).toEqual([{ ecosystemId: 'cursor', code: 'workspace_unresolved' }]);
  });

  it('waits for settings resolution so a pending initial scan starts only one refresh request', async () => {
    let resolveSettings!: (value: Record<string, boolean>) => void;
    mocks.config.mockReturnValueOnce(new Promise<Record<string, boolean>>(resolve => { resolveSettings = resolve; }));
    await render();
    await observe(page('original', { discoveryPending: true }));
    expect(mocks.read).not.toHaveBeenCalled();
    await act(async () => resolveSettings({ codex: true }));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(current.pending).toBe(false);
  });

  it('does not carry pending state into another activation of the same host', async () => {
    const scan = wait();
    mocks.read.mockReturnValueOnce(scan.promise);
    await render();
    await observe(page('original', { discoveryPending: true }));
    mocks.epoch += 1;
    await render();
    expect(current.pending).toBe(false);
    await act(async () => scan.resolve(page('obsolete')));
    expect(mocks.completed).not.toHaveBeenCalled();
    await observe();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await advance();
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
