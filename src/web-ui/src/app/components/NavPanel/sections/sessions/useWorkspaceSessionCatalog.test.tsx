// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCatalogQuery, SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ loadPage: vi.fn(), onPage: vi.fn() }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { loadSessionMetadataPage: mocks.loadPage } }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { useWorkspaceSessionCatalog } from './useWorkspaceSessionCatalog';
import { workspaceSessionCatalogTotal } from './workspaceSessionCatalogQuery';

const page = (nextCursor?: string): SessionMetadataPage => ({
  sessions: [], totalTopLevelCount: 655, loadedTopLevelCount: 200, hasMore: Boolean(nextCursor), nextCursor,
});
const deferred = () => {
  let resolve!: (value: SessionMetadataPage) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionMetadataPage>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type Props = { workspaceId?: string; enabled?: boolean; refreshVersion?: number; agent?: string; query?: SessionCatalogQuery; targetCount?: number; firstPage?: SessionMetadataPage; getKnownCount?: () => number; captureQuery?: (query: SessionCatalogQuery) => SessionCatalogQuery };
let current: ReturnType<typeof useWorkspaceSessionCatalog>;
const renders: Array<{ workspaceId: string; complete: boolean; paged: boolean; total?: number }> = [];
function Harness({ workspaceId = 'main', enabled = true, refreshVersion = 0, agent = 'all', query, targetCount, firstPage, getKnownCount, captureQuery }: Props) {
  current = useWorkspaceSessionCatalog({ workspaceId, enabled, refreshVersion, onPage: mocks.onPage, query, targetCount, firstPage, getKnownCount, captureQuery });
  renders.push({ workspaceId, complete: current.complete, paged: current.paged, total: current.total });
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

  const query: SessionCatalogQuery = { workspaceId: 'main', ordering: 'updated', source: 'all' };
  const queriedPage = (loaded: number, nextCursor?: string, applied = query): SessionMetadataPage => ({
    ...page(nextCursor), loadedTopLevelCount: loaded, catalogQuery: applied,
  });

  it('keeps the settled catalog visible throughout a multi-page ordering-pin refresh', async () => {
    let knownCount = 5;
    const getKnownCount = () => knownCount;
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'old-5'));
    await render({ query, getKnownCount });
    const pinned = { ...query, sortTimestamps: { running: 100 } };
    const first = deferred();
    const last = deferred();
    mocks.loadPage.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const beforeRefresh = renders.length;
    await render({ query: pinned, getKnownCount });
    expect(current).toMatchObject({ complete: true, paged: true, loading: true, total: 655, loaded: 5, knownCount: 5 });
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 5, undefined,
      'sessions_nav_catalog', { fresh: false, query: pinned });
    mocks.onPage.mockImplementationOnce(() => { knownCount = 8; });
    await act(async () => first.resolve({ ...queriedPage(3, 'new-3', pinned), totalTopLevelCount: 660 }));
    expect(current).toMatchObject({ complete: true, paged: true, loading: true, total: 655, loaded: 5, knownCount: 8 });
    expect(workspaceSessionCatalogTotal(knownCount, current)).toBe(655);
    expect(renders.slice(beforeRefresh).every(value => value.complete && value.paged && value.total === 655)).toBe(true);
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 2, 'new-3',
      'sessions_nav_catalog', { fresh: false, query: pinned });
    mocks.onPage.mockImplementationOnce(() => { knownCount = 10; });
    await act(async () => last.resolve({ ...queriedPage(2, 'new-5', pinned), totalTopLevelCount: 660 }));
    expect(current).toMatchObject({ complete: true, paged: true, loading: false, total: 660,
      loaded: 5, knownCount: 10, nextCursor: 'new-5', requestQuery: pinned });
  });

  it.each([false, true])('rejects stale pin refreshes when previous pins are restored: %s', async restorePrevious => {
    const firstPins = { ...query, sortTimestamps: { running: 100 } };
    const nextPins = { ...query, sortTimestamps: { running: 200 } };
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'old-5', firstPins));
    await render({ query: firstPins });
    const stale = deferred();
    const latest = deferred();
    mocks.loadPage.mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    await render({ query: nextPins });
    const latestQuery = restorePrevious ? firstPins : query;
    await render({ query: latestQuery });
    expect(current).toMatchObject({ complete: true, paged: true, loading: true, total: 655 });
    await act(async () => stale.resolve({ ...queriedPage(5, 'stale-5', nextPins), totalTopLevelCount: 999 }));
    expect(mocks.onPage).toHaveBeenCalledTimes(1);
    expect(current.total).toBe(655);
    await act(async () => latest.resolve({ ...queriedPage(5, 'latest-5', latestQuery), totalTopLevelCount: 660 }));
    expect(current).toMatchObject({ complete: true, loading: false, total: 660, nextCursor: 'latest-5' });
  });

  it.each([
    { name: 'workspace', props: { workspaceId: 'other', query: { ...query, workspaceId: 'other' } } },
    { name: 'source', props: { query: { ...query, source: 'codex' } } },
    { name: 'ordering', props: { query: { ...query, ordering: 'created' as const } } },
    { name: 'client-side view', props: {} },
    { name: 'explicit refresh', props: { query, refreshVersion: 1 } },
    { name: 'peer device', props: { query }, peer: true },
  ])('invalidates a settled paged catalog immediately on a $name change', async ({ props, ...scenario }) => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'old-5'));
    await render({ query });
    const pending = deferred();
    mocks.loadPage.mockReturnValueOnce(pending.promise);
    if ('peer' in scenario) activateSurface('peer');
    const beforeChange = renders.length;
    await render(props);
    expect(current).toMatchObject({ complete: false, paged: false, loading: true });
    expect(current.total).toBeUndefined();
    expect(renders.slice(beforeChange).every(value => !value.complete && !value.paged && value.total === undefined)).toBe(true);
    await act(async () => pending.resolve(page()));
  });

  it('does not resurrect a settled total after the host falls back to legacy traversal', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'old-5'));
    await render({ query });
    const pinned = { ...query, sortTimestamps: { running: 100 } };
    mocks.loadPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
    await render({ query: pinned });
    expect(current).toMatchObject({ complete: true, paged: false, total: undefined });
    const pending = deferred();
    mocks.loadPage.mockReturnValueOnce(pending.promise);
    await render({ query });
    expect(current).toMatchObject({ complete: false, paged: false });
    expect(current.total).toBeUndefined();
    await act(async () => pending.resolve(queriedPage(5, 'new-5')));
  });

  it('surfaces a failed pin refresh instead of reporting a completed catalog', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'old-5'));
    await render({ query });
    mocks.loadPage.mockRejectedValueOnce(new Error('Host unavailable'));
    await render({ query: { ...query, sortTimestamps: { running: 100 } } });
    expect(current).toMatchObject({ complete: false, loading: false, failed: true });
  });

  it('restarts loaded counts after a host revision change without draining the catalog', async () => {
    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(5, 'v1-5'), catalogRevision: 'v1' });
    await render({ query });
    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(5, 'v2-5'), catalogRevision: 'v2', catalogReset: true })
      .mockResolvedValueOnce({ ...queriedPage(5, 'v2-10'), catalogRevision: 'v2' });
    await render({ query, targetCount: 10 });
    expect(mocks.loadPage).toHaveBeenCalledTimes(3);
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 5, 'v2-5', 'sessions_nav_catalog', { fresh: false, query });
    expect(current).toMatchObject({ complete: true, loaded: 10, revision: 'v2', nextCursor: 'v2-10', hasMore: true });
  });

  it('captures newly observed order after a host revision change and retains it for later pages', async () => {
    const captured = { ...query, sortTimestamps: { observed: 20 } };
    const captureQuery = vi.fn(() => captured);
    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(5, 'v1-5'), catalogRevision: 'v1' });
    await render({ query, captureQuery });
    expect(captureQuery).not.toHaveBeenCalled();

    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(5, 'v2-5'), catalogRevision: 'v2', catalogReset: true })
      .mockResolvedValueOnce({ ...queriedPage(10, 'pinned-10', captured), catalogRevision: 'pinned-v2' });
    await render({ query, captureQuery, targetCount: 10 });
    expect(captureQuery).toHaveBeenCalledExactlyOnceWith(query);
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 10, undefined,
      'sessions_nav_catalog', { fresh: false, query: captured });
    expect(current).toMatchObject({ complete: true, loaded: 10, revision: 'pinned-v2', nextCursor: 'pinned-10' });

    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(5, 'pinned-15', captured), catalogRevision: 'pinned-v2' });
    await render({ query, captureQuery, targetCount: 15 });
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 5, 'pinned-10',
      'sessions_nav_catalog', { fresh: false, query: captured });
    expect(mocks.loadPage).toHaveBeenCalledTimes(4);
    expect(current).toMatchObject({ complete: true, loaded: 15, revision: 'pinned-v2' });
  });

  it('clears a cancelled expansion when the user collapses back to already-loaded rows', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, '5'));
    await render({ query });
    const expansion = deferred();
    mocks.loadPage.mockImplementationOnce(() => expansion.promise);
    await render({ query, targetCount: 10 });
    expect(current.loading).toBe(true);
    await render({ query, targetCount: 5 });
    expect(current).toMatchObject({ complete: true, loading: false, loaded: 5 });
    await act(async () => expansion.resolve(queriedPage(5, '10')));
    expect(mocks.onPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadPage).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({ complete: true, loading: false, loaded: 5 });
  });

  it('loads only five of 655 rows by default, then requests only the expansion delta', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, '5'))
      .mockResolvedValueOnce(queriedPage(5, '10'))
      .mockResolvedValueOnce(queriedPage(190, '200'));
    await render({ query });
    expect(mocks.loadPage).toHaveBeenCalledExactlyOnceWith('main', 5, undefined,
      'sessions_nav_catalog', { fresh: false, query });
    expect(current).toMatchObject({ complete: true, paged: true, total: 655, loaded: 5, hasMore: true });
    await render({ query, enabled: false });
    await render({ query });
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    await render({ query, targetCount: 10 });
    expect(mocks.loadPage).toHaveBeenNthCalledWith(2, 'main', 5, '5',
      'sessions_nav_catalog', { fresh: false, query });
    await render({ query, targetCount: 200 });
    expect(mocks.loadPage).toHaveBeenNthCalledWith(3, 'main', 190, '10',
      'sessions_nav_catalog', { fresh: false, query });
    expect(current).toMatchObject({ loaded: 200, hasMore: true, total: 655 });
    await render({ query, targetCount: 5 });
    expect(mocks.loadPage).toHaveBeenCalledTimes(3);
  });

  it('reuses the acknowledged startup page and records live count baselines after later hydration', async () => {
    let knownCount = 5;
    const getKnownCount = () => knownCount;
    const firstPage = queriedPage(5, '5');
    await render({ query, firstPage, getKnownCount });
    expect(mocks.loadPage).not.toHaveBeenCalled();
    expect(current).toMatchObject({ complete: true, paged: true, total: 655, loaded: 5, knownCount: 5 });
    mocks.loadPage.mockImplementationOnce(async () => {
      knownCount = 10;
      return queriedPage(5, '10');
    });
    await render({ query, firstPage, getKnownCount, targetCount: 10 });
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ total: 655, loaded: 10, knownCount: 10 });
  });

  it('traverses the original catalog when an older host ignores a query', async () => {
    mocks.loadPage.mockResolvedValueOnce({ ...page('5'), loadedTopLevelCount: 5 })
      .mockResolvedValueOnce(page('200')).mockResolvedValueOnce(page('400'))
      .mockResolvedValueOnce(page('600')).mockResolvedValueOnce(page());
    await render({ query });
    expect(current).toMatchObject({ complete: true, paged: false, total: undefined });
    expect(mocks.loadPage).toHaveBeenCalledTimes(5);
    expect(mocks.loadPage).toHaveBeenNthCalledWith(2, 'main', 200, undefined,
      'sessions_nav_catalog', { fresh: false });
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 200, '600',
      'sessions_nav_catalog', { fresh: false });
  });

  it('does not trust an acknowledgement for a different workspace or source', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, '5', { ...query, source: 'codex' }))
      .mockResolvedValueOnce(page());
    await render({ query });
    expect(current).toMatchObject({ complete: true, paged: false });
    expect(mocks.loadPage).toHaveBeenCalledTimes(2);
  });

  it('restarts legacy traversal when a host withdraws query support during expansion', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'scoped-5'));
    await render({ query });
    mocks.loadPage.mockResolvedValueOnce({ ...page('legacy-5'), loadedTopLevelCount: 5 })
      .mockResolvedValueOnce(page('200')).mockResolvedValueOnce(page());
    await render({ query, targetCount: 10 });
    expect(mocks.loadPage).toHaveBeenNthCalledWith(2, 'main', 5, 'scoped-5',
      'sessions_nav_catalog', { fresh: false, query });
    expect(mocks.loadPage).toHaveBeenNthCalledWith(3, 'main', 200, undefined,
      'sessions_nav_catalog', { fresh: false });
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 200, '200',
      'sessions_nav_catalog', { fresh: false });
    expect(current).toMatchObject({ complete: true, paged: false, total: undefined });
    await render({ query, targetCount: 200 });
    expect(mocks.loadPage).toHaveBeenCalledTimes(4);
  });

  it('restarts source filters and discovery refreshes at the first page without draining them', async () => {
    const codexQuery = { ...query, source: 'codex' };
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, '5'));
    await render({ query });
    const pending = deferred();
    mocks.loadPage.mockReturnValueOnce(pending.promise);
    await render({ query: codexQuery });
    expect(current).toMatchObject({ complete: false, paged: false });
    expect(current.total).toBeUndefined();
    await act(async () => pending.resolve({ ...queriedPage(5, 'source-5', codexQuery), totalTopLevelCount: 18 }));
    expect(current).toMatchObject({ complete: true, total: 18 });
    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(5, 'new-5', codexQuery), totalTopLevelCount: 19 });
    await render({ query: codexQuery, refreshVersion: 1 });
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 5, undefined,
      'sessions_nav_catalog', { fresh: true, query: codexQuery });
    expect(current).toMatchObject({ complete: true, loaded: 5, total: 19 });
    expect(mocks.loadPage).toHaveBeenCalledTimes(3);
  });

  it('abandons an in-flight expansion on a device switch', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, 'local-5'));
    await render({ query });
    const local = deferred();
    mocks.loadPage.mockReturnValueOnce(local.promise);
    await render({ query, targetCount: 10 });
    activateSurface('peer');
    mocks.loadPage.mockResolvedValueOnce({ ...queriedPage(2), totalTopLevelCount: 2 });
    await render({ query });
    await act(async () => local.resolve(queriedPage(5, 'local-10')));
    expect(current).toMatchObject({ complete: true, loaded: 2, total: 2 });
    expect(mocks.onPage).toHaveBeenCalledTimes(2);
    expect(mocks.loadPage).toHaveBeenLastCalledWith('main', 5, undefined,
      'sessions_nav_catalog', { fresh: false, query });
  });

  it('keeps a failed page recoverable and rejects a non-advancing query cursor', async () => {
    mocks.loadPage.mockResolvedValueOnce(queriedPage(5, '5')).mockResolvedValueOnce(queriedPage(5, '5'));
    await render({ query, targetCount: 10 });
    expect(current).toMatchObject({ complete: false, failed: true, loaded: 5 });
    mocks.loadPage.mockResolvedValueOnce(queriedPage(10, '10'));
    await render({ query, targetCount: 10, refreshVersion: 1 });
    expect(current).toMatchObject({ complete: true, failed: false, loaded: 10 });
  });
});
