// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ loadPage: vi.fn(), onPage: vi.fn() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { loadSessionMetadataPage: mocks.loadPage } }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { useWorkspaceSessionCatalog } from './useWorkspaceSessionCatalog';

const page = (nextCursor?: string): SessionMetadataPage => ({
  sessions: [], totalTopLevelCount: 655, loadedTopLevelCount: 200, hasMore: Boolean(nextCursor), nextCursor,
});
const deferred = () => {
  let resolve!: (value: SessionMetadataPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionMetadataPage>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type Props = { workspaceId?: string; enabled?: boolean; refreshVersion?: number; agent?: string };
let current: ReturnType<typeof useWorkspaceSessionCatalog>;
const renders: Array<{ workspaceId: string; complete: boolean }> = [];
function Harness({ workspaceId = 'main', enabled = true, refreshVersion = 0, agent = 'all' }: Props) {
  current = useWorkspaceSessionCatalog({ workspaceId, enabled, refreshVersion, onPage: mocks.onPage });
  renders.push({ workspaceId, complete: current.complete });
  return <output data-agent={agent}>{current.complete ? 'complete' : current.failed ? 'failed' : 'pending'}</output>;
}

describe('workspace metadata catalog', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetDeviceSurfaceForTest();
    renders.length = 0;
    container = document.createElement('div');
    root = createRoot(container);
    mocks.loadPage.mockResolvedValue(page());
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  const render = async (props: Props = {}) => { await act(async () => root.render(<Harness {...props} />)); };

  it('waits for startup readiness, traverses legacy pages, and does not rescan when an Agent filter changes', async () => {
    await render({ enabled: false });
    expect(mocks.loadPage).not.toHaveBeenCalled();
    const last = deferred();
    mocks.loadPage.mockResolvedValueOnce(page('200')).mockImplementationOnce(() => last.promise);
    await render();
    expect(current.loading).toBe(true);
    expect(current.complete).toBe(false);
    expect(mocks.loadPage).toHaveBeenNthCalledWith(2, 'main', 200, '200', 'sessions_nav_catalog', { fresh: false });
    await act(async () => last.resolve(page()));
    expect(current.complete).toBe(true);
    await render({ agent: 'openbitfun' });
    await render({ agent: 'codex' });
    await render({ agent: 'all' });
    await render({ enabled: false });
    await render();
    expect(mocks.loadPage).toHaveBeenCalledTimes(2);
    expect(mocks.onPage).toHaveBeenCalledTimes(2);
  });

  it('keeps partial results incomplete on failure and retries the entire catalog with fresh pages', async () => {
    mocks.loadPage.mockResolvedValueOnce(page('200')).mockRejectedValueOnce(new Error('Disconnected'));
    await render();
    expect(current).toMatchObject({ complete: false, failed: true, loading: false });
    expect(mocks.onPage).toHaveBeenCalledTimes(1);
    mocks.loadPage.mockResolvedValueOnce(page());
    await render({ refreshVersion: 1 });
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 200, undefined, 'sessions_nav_catalog', { fresh: true });
    expect(current).toMatchObject({ complete: true, failed: false });
  });

  it('never carries a completed count into the first render of a different workspace', async () => {
    await render();
    const other = deferred();
    mocks.loadPage.mockImplementationOnce(() => other.promise);
    await render({ workspaceId: 'other' });
    expect(renders.filter(value => value.workspaceId === 'other').every(value => !value.complete)).toBe(true);
    await act(async () => other.resolve(page()));
    expect(current.complete).toBe(true);
  });

  it('stops a stale local traversal when the same workspace ID is shown on a peer', async () => {
    const local = deferred();
    const peer = deferred();
    mocks.loadPage.mockImplementationOnce(() => local.promise).mockImplementationOnce(() => peer.promise);
    await render();
    activateSurface('peer-device');
    await render();
    await act(async () => local.resolve(page('stale-cursor')));
    expect(mocks.onPage).not.toHaveBeenCalled();
    expect(mocks.loadPage).toHaveBeenCalledTimes(2);
    expect(current.complete).toBe(false);
    await act(async () => peer.resolve(page()));
    expect(current.complete).toBe(true);
    expect(mocks.onPage).toHaveBeenCalledTimes(1);
  });

  it('invalidates completion during discovery refresh even before another request finishes', async () => {
    await render();
    const refresh = deferred();
    mocks.loadPage.mockImplementationOnce(() => refresh.promise);
    await render({ refreshVersion: 1 });
    expect(current.complete).toBe(false);
    await act(async () => refresh.resolve(page()));
    expect(current.complete).toBe(true);
  });

  it('does not continue pagination after the section is hidden', async () => {
    const pending = deferred();
    mocks.loadPage.mockImplementationOnce(() => pending.promise);
    await render();
    await render({ enabled: false });
    await act(async () => pending.resolve(page('200')));
    expect(mocks.onPage).not.toHaveBeenCalled();
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(current.complete).toBe(false);
    await render();
    expect(current.complete).toBe(true);
  });
});
