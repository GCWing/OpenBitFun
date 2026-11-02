// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPlatformPullRequest, ReviewPlatformPullRequestDetailPage, ReviewPlatformPullRequestReviewTarget, ReviewPlatformWorkspaceSnapshot, ReviewRepositoryLocator } from '@/infrastructure/api/service-api/ReviewPlatformAPI';
import type { Session } from '@/flow_chat/types/flow-chat';
import { ReviewPlatformPanel } from './ReviewPlatformPanel';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import type { PeerHostCapabilities } from '@/infrastructure/peer-device/PeerConnectionManager';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), context: vi.fn(), detail: vi.fn(), openExternal: vi.fn(), reviewTarget: vi.fn(),
  prepareReview: vi.fn(),
  state: { sessions: new Map<string, Session>(), activeSessionId: null as string | null },
  t: (key: string) => key,
}));
const peer = vi.hoisted(() => ({ active: false, capabilities: null as Partial<PeerHostCapabilities> | null }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => peer.active
    ? { peerMode: { active: true }, currentPeerCapabilities: peer.capabilities }
    : null,
}));
vi.mock('@/infrastructure/api', () => ({ reviewPlatformAPI: { getWorkspaceSnapshot: mocks.snapshot, getWorkspaceContext: mocks.context, getPullRequestDetailPage: mocks.detail, getPullRequestReviewTarget: mocks.reviewTarget }, systemAPI: { openExternal: mocks.openExternal } }));
vi.mock('@/infrastructure/markdown', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/shared/notification-system', () => ({ notificationService: {} }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }), i18nService: { t: mocks.t, formatDate: () => '' } }));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: vi.fn() }));
vi.mock('@/flow_chat/services/btwSessionPane', () => ({ openBtwSessionInAuxPane: vi.fn() }));
vi.mock('@/flow_chat/services/ReviewService', () => ({ launchPreparedReviewSession: vi.fn(), prepareReviewLaunchFromPullRequest: mocks.prepareReview }));
vi.mock('@/flow_chat/components/DeepReviewConsentDialog', () => ({ useDeepReviewConsent: () => ({ confirmDeepReviewLaunch: vi.fn(), deepReviewConsentDialog: null }) }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => mocks.state, subscribe: () => () => {} } }));
vi.mock('@/shared/stores/contextStore', () => ({ useContextStore: {} }));
vi.mock('@/shared/services/ide-control', () => ({ quickActions: {} }));

function pull(number: number, state: 'open' | 'merged'): ReviewPlatformPullRequest {
  return { id: String(number), number, state, title: `PR ${number}`, author: 'author', sourceBranch: 'feature', targetBranch: 'main',
    baseRevision: 'a'.repeat(40), headRevision: 'b'.repeat(40), updatedAt: '', webUrl: '', additions: 0, deletions: 0,
    changedFiles: 0, changedFileCountKnown: false, lineStatsKnown: false, comments: 0,
    reviewDecision: 'pending', checks: { total: 0, passed: 0, failed: 0, pending: 0 } };
}
function snapshot(path: string, page = 1, state = 'all'): ReviewPlatformWorkspaceSnapshot {
  const remote = { id: 'origin', name: 'origin', url: 'https://gitee.com/example/repo.git', platform: 'gitee' as const,
    host: 'gitee.com', owner: 'example', repositoryName: 'repo', projectPath: 'example/repo', webUrl: '', supported: true,
    authState: 'not_required' as const, authSource: 'none' as const };
  return { remotes: [remote], selectedRemoteId: 'origin', accounts: [],
    repository: { providerId: 'origin', platform: 'gitee', host: 'gitee.com', owner: 'example', name: 'repo', projectPath: 'example/repo',
      defaultBranch: 'main', workspacePath: path, webUrl: '' },
    pullRequests: Array.from({ length: 10 }, (_, index) => pull((state === 'merged' ? 100 : page * 10) + index, state === 'merged' ? 'merged' : 'open')),
    pagination: { page, perPage: 10, total: state === 'merged' ? 269 : 376, hasNext: true },
    capabilities: { canCreateReview: true, canCreatePullRequest: false, canReplyToThread: false, canResolveThread: false,
      canApprove: false, canRevokeApproval: false, canRequestChanges: false, canMerge: false, supportsDraftReview: false,
      supportedPullRequestStates: ['all', 'open', 'draft', 'merged', 'closed'] } };
}
function detail(number: number, section: ReviewPlatformPullRequestDetailPage['section']): ReviewPlatformPullRequestDetailPage {
  return { ...pull(number, number >= 100 ? 'merged' : 'open'), section, body: '', ci: [], files: [], commits: [], threads: [],
    ...(section === 'overview' ? { changedFiles: 2, changedFileCountKnown: true, additions: 4, deletions: 4, lineStatsKnown: true } : {}),
    pagination: { page: 1, perPage: 20, total: 0, hasNext: false } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let host: HTMLDivElement;
let testNumber = 0;
// The panel keys its module-level caches by workspace ID, so every test mounts
// a distinct workspace; the path is only the IO operand sent alongside it.
const workspaceIdFor = (path: string) => `workspace:${path}`;
const locator = (path: string): ReviewRepositoryLocator => ({ workspaceId: workspaceIdFor(path), repositoryPath: path });
type SnapshotMock = (repository: ReviewRepositoryLocator, remote: string | null, page: number, size: number, state: string) => Promise<ReviewPlatformWorkspaceSnapshot>;
const snapshotFor = (mutate?: (result: ReviewPlatformWorkspaceSnapshot) => void): SnapshotMock => ({ repositoryPath }, _remote, page, _size, state) => {
  const result = snapshot(repositoryPath, page, state);
  mutate?.(result);
  return Promise.resolve(result);
};
async function click(id: string) {
  const selector = id.startsWith('review-platform-filter-')
    ? `[data-openbitfun-product-part="filters"] [data-openbitfun-value="${id.slice('review-platform-filter-'.length)}"]`
    : `[data-testid="${id}"]`;
  await act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
}
async function mount() {
  const path = `/gitee-panel-test-${++testNumber}`;
  await act(async () => { root.render(<ReviewPlatformPanel workspaceId={workspaceIdFor(path)} workspacePath={path} />); });
  return path;
}

function statisticText(owner: Element, id: string): string | null | undefined {
  const lineStat = /^(pr|detail)-(additions|deletions)$/.exec(id);
  if (lineStat) {
    const lineStats = owner.querySelector(`[data-testid="review-platform-${lineStat[1]}-line-stats"]`);
    return lineStats?.querySelector(`[data-openbitfun-part="${lineStat[2]}"]`)?.textContent ?? lineStats?.textContent;
  }
  return owner.querySelector(`[data-testid="review-platform-${id}"]`)?.textContent;
}

describe('Gitee panel state and asynchronous request ordering', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    activateSurface('local');
    peer.active = false;
    peer.capabilities = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mocks.snapshot.mockReset().mockImplementation(snapshotFor());
    mocks.context.mockReset();
    mocks.detail.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    mocks.reviewTarget.mockReset();
    mocks.prepareReview.mockReset();
    mocks.state.sessions.clear();
    mocks.state.activeSessionId = null;
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); activateSurface('local'); });

  it.each([null, { hostKind: 'cli' }, { hostKind: 'desktop', reviewPlatformV1: false }] as const)(
    'keeps unsupported restored panels out of the peer transport: %j', async capabilities => {
      peer.active = true;
      peer.capabilities = capabilities;
      const url = 'https://github.com/GCWing/OpenBitFun/pull/3573/files#diff-example';
      await act(async () => root.render(
        <ReviewPlatformPanel workspaceId="workspace-1" workspacePath="/workspace" initialPullRequestUrl={url} detailOnly />,
      ));
      expect(host.textContent).toContain('common:reviewPlatform.messages.hostUnsupported');
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.detail).not.toHaveBeenCalled();
      await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
    },
  );

  it('replaces a mounted panel on a device switch even when workspace identities match', async () => {
    const old = deferred<ReviewPlatformWorkspaceSnapshot>();
    mocks.snapshot.mockImplementationOnce(() => old.promise);
    const path = await mount();
    const selected = snapshot(path);
    selected.pullRequests[0].title = 'Selected peer result';
    mocks.snapshot.mockResolvedValueOnce(selected);
    await act(async () => { activateSurface('other-peer'); });
    const departed = snapshot(path);
    departed.pullRequests[0].title = 'Departed peer result';
    await act(async () => old.resolve(departed));
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Selected peer result');
    expect(host.textContent).not.toContain('Departed peer result');
  });

  it('isolates remembered remotes by device and preserves legacy local preferences', async () => {
    const path = `/remote-preferences-${++testNumber}`;
    const workspaceId = workspaceIdFor(path);
    const legacyKey = `openbitfun:review-platform:last-remote:id:${workspaceId}`;
    window.localStorage.setItem(legacyKey, 'local-origin');
    mocks.context.mockImplementation(({ repositoryPath }, remoteId) => {
      const result = snapshot(repositoryPath);
      result.selectedRemoteId = remoteId ?? 'peer-origin';
      return Promise.resolve(result);
    });
    await act(async () => {
      activateSurface('preference-peer-a');
      root.render(<ReviewPlatformPanel workspaceId={workspaceId} workspacePath={path} detailOnly />);
    });
    expect(mocks.context).toHaveBeenLastCalledWith(locator(path), null);
    await act(async () => { activateSurface('preference-peer-b'); });
    expect(mocks.context).toHaveBeenLastCalledWith(locator(path), null);
    await act(async () => { activateSurface('local'); });
    expect(mocks.context).toHaveBeenLastCalledWith(locator(path), 'local-origin');
    expect(window.localStorage.getItem(legacyKey)).toBe('local-origin');
  });

  it('migrates a legacy path preference only on the local device', async () => {
    const path = `/legacy-remote-preference-${++testNumber}`;
    const legacyKey = `openbitfun:review-platform:last-remote:${path}`;
    window.localStorage.setItem(legacyKey, 'old-origin');
    mocks.context.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      activateSurface('legacy-preference-peer');
      root.render(<ReviewPlatformPanel workspaceId={workspaceIdFor(path)} workspacePath={path} detailOnly />);
    });
    expect(mocks.context).toHaveBeenLastCalledWith(locator(path), null);
    expect(window.localStorage.getItem(legacyKey)).toBe('old-origin');
    await act(async () => { activateSurface('local'); });
    expect(mocks.context).toHaveBeenLastCalledWith(locator(path), 'old-origin');
    expect(window.localStorage.getItem(`openbitfun:review-platform:last-remote:id:${workspaceIdFor(path)}`)).toBe('old-origin');
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });

  it('discards a departed device response before it writes preferences or cache aliases', async () => {
    const path = `/late-remote-preference-${++testNumber}`;
    const old = deferred<ReviewPlatformWorkspaceSnapshot>();
    mocks.context.mockImplementationOnce(() => old.promise);
    const selected = snapshot(path);
    selected.selectedRemoteId = 'selected-origin';
    mocks.context.mockResolvedValue(selected);
    await act(async () => {
      activateSurface('late-preference-peer-a');
      root.render(<ReviewPlatformPanel workspaceId={workspaceIdFor(path)} workspacePath={path} detailOnly />);
    });
    await act(async () => { activateSurface('late-preference-peer-b'); });
    const preferenceAfterSwitch = { ...window.localStorage };
    const departed = snapshot(path);
    departed.selectedRemoteId = 'departed-origin';
    await act(async () => old.resolve(departed));
    expect({ ...window.localStorage }).toEqual(preferenceAfterSwitch);
    // The discarded response must not become a cache hit on a later activation.
    await act(async () => { activateSurface('late-preference-peer-a'); });
    expect(mocks.context).toHaveBeenCalledTimes(3);
    expect(mocks.context).toHaveBeenLastCalledWith(locator(path), null);
  });

  it('does not prepare a review on a new device when the old target response arrives', async () => {
    const path = `/review-launch-switch-${++testNumber}`;
    mocks.state.sessions.set('chat', {
      sessionId: 'chat', sessionKind: 'normal', workspaceId: workspaceIdFor(path), dialogTurns: [],
    } as Session);
    mocks.state.activeSessionId = 'chat';
    mocks.detail.mockImplementation(({ pullRequestId, section }) => Promise.resolve(detail(Number(pullRequestId), section)));
    const target = deferred<ReviewPlatformPullRequestReviewTarget>();
    mocks.reviewTarget.mockReturnValue(target.promise);
    await act(async () => root.render(<ReviewPlatformPanel workspaceId={workspaceIdFor(path)} workspacePath={path} />));
    const review = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Review');
    expect(review?.disabled).toBe(false);
    await act(async () => review!.click());
    expect(mocks.reviewTarget).toHaveBeenCalledOnce();
    await act(async () => { activateSurface('review-launch-new-peer'); });
    await act(async () => target.resolve({ pullRequest: pull(10, 'open'), files: [], omittedFileCount: 0, limitations: [] }));
    expect(mocks.prepareReview).not.toHaveBeenCalled();
  });

  it('keeps a browser action when a supported peer cannot load the PR context', async () => {
    const url = 'https://github.com/GCWing/OpenBitFun/pull/3573';
    mocks.context.mockRejectedValueOnce(new Error('Provider unavailable'));
    await act(async () => root.render(
      <ReviewPlatformPanel workspaceId="failed-context" workspacePath="/workspace" initialPullRequestUrl={url} detailOnly />,
    ));
    const browser = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'common:file.openInSystemBrowser');
    expect(browser).toBeDefined();
    await act(async () => browser?.click());
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('never serves one device\'s pull requests to another device with the same workspace ID', async () => {
    // Same-path local workspaces hash to one workspace ID on every device.
    const path = '/same-path-on-two-devices';
    const remount = async () => {
      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () => { root.render(<ReviewPlatformPanel workspaceId={workspaceIdFor(path)} workspacePath={path} />); });
    };
    try {
      const late = deferred<ReviewPlatformWorkspaceSnapshot>();
      mocks.snapshot.mockImplementationOnce(() => late.promise);
      await remount();
      await act(async () => { activateSurface('peer-b'); });
      await act(async () => late.resolve(snapshot(path)));
      await remount();
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
      await remount();
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
      await act(async () => { activateSurface('local'); });
      await remount();
      expect(mocks.snapshot).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => { activateSurface('local'); });
    }
  });

  it('uses list statistics in the selected detail while its overview is still pending', async () => {
    mocks.snapshot.mockImplementation(snapshotFor(result => {
      result.pullRequests = result.pullRequests.map((pr, index) => ({ ...pr,
        changedFiles: index, changedFileCountKnown: true,
        additions: index * 4, deletions: index * 2, lineStatsKnown: true,
      }));
    }));
    const path = await mount();
    expect(mocks.snapshot).toHaveBeenCalledWith(locator(path), null, 1, 10, 'all');
    const rows = [...host.querySelectorAll('[data-testid="review-platform-pr-row"]')];
    expect(rows).toHaveLength(10);
    for (const [index, row] of rows.entries()) {
      await act(async () => { (row as HTMLButtonElement).click(); });
      expect(statisticText(host, 'detail-files')).toBe(`${index} files`);
      expect(statisticText(host, 'detail-additions')).toBe(`+${index * 4}`);
      expect(statisticText(host, 'detail-deletions')).toBe(`-${index * 2}`);
    }
    expect(mocks.detail.mock.calls.map(([request]) => request.pullRequestId)).toEqual(Array.from({ length: 10 }, (_, index) => String(10 + index)));
    expect(mocks.detail).toHaveBeenCalledWith(expect.objectContaining(locator(path)));
  });

  it.each([true, false])('uses complete list statistics for unknown detail counts only at the same revisions (%s)', async sameRevisions => {
    mocks.snapshot.mockImplementation(snapshotFor(result => {
      result.pullRequests = result.pullRequests.map(pr => ({ ...pr,
        changedFiles: 2, changedFileCountKnown: true, additions: 4, deletions: 3, lineStatsKnown: true,
      }));
    }));
    mocks.detail.mockImplementation(({ pullRequestId, section }) => Promise.resolve({
      ...detail(Number(pullRequestId), section),
      headRevision: (sameRevisions ? 'b' : 'c').repeat(40),
      changedFiles: 0, changedFileCountKnown: false, additions: 0, deletions: 0, lineStatsKnown: false,
    }));
    await mount();
    expect(host.querySelector('[data-testid="review-platform-detail-files"]')?.textContent).toBe(sameRevisions ? '2 files' : '— files');
    expect(statisticText(host, 'detail-additions')).toBe(sameRevisions ? '+4' : '—');
    expect(statisticText(host, 'detail-deletions')).toBe(sameRevisions ? '-3' : '—');
  });

  it('replaces list statistics with authoritative zero counts from a legacy overview', async () => {
    mocks.snapshot.mockImplementation(snapshotFor(result => {
      result.pullRequests = result.pullRequests.map(pr => ({ ...pr,
        changedFiles: 2, changedFileCountKnown: true, additions: 4, deletions: 3, lineStatsKnown: undefined,
      }));
    }));
    mocks.detail.mockImplementation(({ pullRequestId, section }) => Promise.resolve({
      ...detail(Number(pullRequestId), section),
      changedFiles: 0, changedFileCountKnown: section === 'overview',
      additions: 0, deletions: 0, lineStatsKnown: undefined,
    }));
    await mount();
    expect(statisticText(host, 'detail-files')).toBe('0 files');
    expect(statisticText(host, 'detail-additions')).toBe('+0');
    expect(statisticText(host, 'detail-deletions')).toBe('-0');
  });

  it('requests Merged from page one after All page two and ignores a late All refresh', async () => {
    const path = await mount();
    await click('review-platform-next-page');
    expect(host.querySelector('[data-testid="review-platform-pagination"]')?.textContent).toContain('11-20 of 376');
    const pending = deferred<ReviewPlatformWorkspaceSnapshot>();
    mocks.snapshot.mockReturnValueOnce(pending.promise);
    await click('review-platform-refresh');
    await click('review-platform-filter-merged');
    expect(mocks.snapshot).toHaveBeenLastCalledWith(locator(path), null, 1, 10, 'merged');
    await act(async () => pending.resolve(snapshot(path, 2)));
    expect(host.querySelector('[data-testid="review-platform-pagination"]')?.textContent).toContain('1-10 of 269');
    expect([...host.querySelectorAll('[data-testid="review-platform-pr-row"]')].map(row => row.getAttribute('data-pr-state'))).toEqual(Array(10).fill('merged'));
  });

  it('does not enqueue old PR reviews when its CI response arrives after switching state', async () => {
    const pendingCi = deferred<ReviewPlatformPullRequestDetailPage>();
    mocks.detail.mockImplementation(({ pullRequestId, section }) => section === 'ci' && pullRequestId === '10'
      ? pendingCi.promise : Promise.resolve(detail(Number(pullRequestId), section)));
    await mount();
    expect(mocks.detail).toHaveBeenCalledWith(expect.objectContaining({ pullRequestId: '10', section: 'ci' }));
    await click('review-platform-filter-merged');
    await act(async () => pendingCi.resolve(detail(10, 'ci')));
    expect(mocks.detail).not.toHaveBeenCalledWith(expect.objectContaining({ pullRequestId: '10', section: 'reviews' }));
    expect(host.querySelector('[data-testid="review-platform-detail-state"]')?.textContent).toBe('Merged');
    expect(host.querySelector('[data-openbitfun-product-part="detailMeta"]')?.textContent).toContain('#100');
  });

  it.each([4, 0])('revalidates cached statistics (%i lines) and discards them for a new revision', async lines => {
    const pendingOverview = deferred<ReviewPlatformPullRequestDetailPage>();
    mocks.detail.mockImplementation(({ pullRequestId, section }) => section === 'overview'
      ? pendingOverview.promise : Promise.resolve(detail(Number(pullRequestId), section)));
    const path = await mount();
    const text = statisticText;
    expect(text(host, 'detail-files')).toBe('— files');
    expect(text(host, 'detail-additions')).toBe('—');
    expect(text(host, 'detail-deletions')).toBe('—');
    await act(async () => pendingOverview.resolve({ ...detail(10, 'overview'), additions: lines, deletions: lines }));
    expect(text(host, 'detail-files')).toBe('2 files');
    expect(text(host, 'detail-additions')).toBe(`+${lines}`);
    expect(text(host, 'detail-deletions')).toBe(`-${lines}`);
    expect(mocks.detail.mock.calls.map(([request]) => request.section)).toEqual(['overview', 'ci', 'reviews']);

    // Revalidating the same revision must accept an authoritative zero.
    mocks.detail.mockImplementation(({ pullRequestId, section }) => Promise.resolve({
      ...detail(Number(pullRequestId), section),
      ...(section === 'overview' ? { additions: 0, deletions: 0 } : {}),
    }));
    await click('review-platform-refresh');
    expect(text(host, 'detail-additions')).toBe('+0');

    const next = snapshot(path);
    next.pullRequests[0].headRevision = 'c'.repeat(40);
    mocks.snapshot.mockResolvedValueOnce(next);
    mocks.detail.mockImplementation(() => new Promise(() => {}));
    await click('review-platform-refresh');
    expect(text(host, 'detail-files')).toBe('— files');
    expect(text(host, 'detail-additions')).toBe('—');
    expect(text(host, 'detail-deletions')).toBe('—');
  });

  it('returns from detail to the same list selection, search and page without refetching', async () => {
    mocks.detail.mockImplementation(({ pullRequestId, section }) => Promise.resolve(detail(Number(pullRequestId), section)));
    await mount();
    await click('review-platform-next-page');
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search pull requests"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'PR 2');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const selectedRow = host.querySelector<HTMLButtonElement>('[data-testid="review-platform-pr-row"][data-pr-number="21"]')!;
    const panel = host.querySelector('[data-openbitfun-product-part="root"]')!;
    expect(panel.getAttribute('data-openbitfun-view')).toBe('list');
    await act(async () => { selectedRow.click(); });
    expect(panel.getAttribute('data-openbitfun-view')).toBe('detail');
    expect(document.activeElement).toBe(host.querySelector('[data-testid="review-platform-back"]'));
    const detailRequests = mocks.detail.mock.calls.length;
    const listRequests = mocks.snapshot.mock.calls.length;
    await click('review-platform-back');
    expect(panel.getAttribute('data-openbitfun-view')).toBe('list');
    expect(document.activeElement).toBe(selectedRow);
    expect(selectedRow.getAttribute('aria-current')).toBe('page');
    expect(search.value).toBe('PR 2');
    expect(host.querySelector('[data-testid="review-platform-pagination"]')?.textContent).toContain('11-20 of 376');
    expect(mocks.detail).toHaveBeenCalledTimes(detailRequests);
    expect(mocks.snapshot).toHaveBeenCalledTimes(listRequests);
  });

  it('shows an empty PR list instead of successful authentication copy or a second empty detail', async () => {
    mocks.snapshot.mockImplementation(path => {
      const result = snapshot(path);
      const remote = result.remotes[0];
      remote.platform = 'github';
      remote.authState = 'connected';
      remote.authSource = 'gh_cli';
      remote.message = 'Authenticated via GitHub CLI as author.';
      result.accounts = [{ id: remote.id, platform: 'github', label: 'author', host: remote.host,
        authState: 'connected', authSource: 'gh_cli', scopes: [], message: remote.message }];
      result.pullRequests = [];
      result.pagination = { page: 1, perPage: 10, total: 0, hasNext: false };
      return Promise.resolve(result);
    });
    await mount();
    expect(host.textContent).toContain('No open pull requests authored by the current GitHub CLI account.');
    expect(host.textContent).not.toContain('Authenticated via GitHub CLI');
    expect(host.querySelector('[data-openbitfun-product-part="detailPane"]')).toBeNull();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('opens the selected PR and refreshes it from the detail actions menu', async () => {
    const webUrl = 'https://gitee.com/example/repo/pulls/10';
    mocks.detail.mockImplementation(({ pullRequestId, section }) => Promise.resolve({ ...detail(Number(pullRequestId), section), webUrl }));
    await mount();
    await click('review-platform-pr-row');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Pull request actions"]')!;
    await act(async () => { trigger.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-id="open-external"]')!.click(); });
    expect(mocks.openExternal).toHaveBeenCalledWith(webUrl);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    const detailRequests = mocks.detail.mock.calls.length;
    await act(async () => { trigger.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-menu-id="refresh"]')!.click(); });
    expect(mocks.detail.mock.calls.slice(detailRequests)).toEqual(expect.arrayContaining([
      [expect.objectContaining({ pullRequestId: '10', section: 'overview' })],
      [expect.objectContaining({ pullRequestId: '10', section: 'ci' })],
      [expect.objectContaining({ pullRequestId: '10', section: 'reviews' })],
    ]));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
