// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPlatformPullRequest, ReviewPlatformPullRequestDetailPage, ReviewPlatformWorkspaceSnapshot, ReviewRepositoryLocator } from '@/infrastructure/api/service-api/ReviewPlatformAPI';
import { ReviewPlatformPanel } from './ReviewPlatformPanel';

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), detail: vi.fn(), openExternal: vi.fn(), t: (key: string) => key }));
vi.mock('@/infrastructure/api', () => ({ reviewPlatformAPI: { getWorkspaceSnapshot: mocks.snapshot, getPullRequestDetailPage: mocks.detail }, systemAPI: { openExternal: mocks.openExternal } }));
vi.mock('@/infrastructure/markdown', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/shared/notification-system', () => ({ notificationService: {} }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }), i18nService: { t: mocks.t, formatDate: () => '' } }));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: vi.fn() }));
vi.mock('@/flow_chat/services/btwSessionPane', () => ({ openBtwSessionInAuxPane: vi.fn() }));
vi.mock('@/flow_chat/services/ReviewService', () => ({ launchPreparedReviewSession: vi.fn(), prepareReviewLaunchFromPullRequest: vi.fn() }));
vi.mock('@/flow_chat/components/DeepReviewConsentDialog', () => ({ useDeepReviewConsent: () => ({ confirmDeepReviewLaunch: vi.fn(), deepReviewConsentDialog: null }) }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: new Map(), activeSessionId: null }), subscribe: () => () => {} } }));
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
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mocks.snapshot.mockReset().mockImplementation(snapshotFor());
    mocks.detail.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

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
