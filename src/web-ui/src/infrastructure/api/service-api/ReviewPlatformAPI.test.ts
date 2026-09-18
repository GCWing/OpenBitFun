import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ReviewPlatformAPI,
  type ReviewPlatformIssueRequest,
  type ReviewPlatformPullRequestIdentityRequest,
} from './ReviewPlatformAPI';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: {
    invoke: invokeMock,
  },
}));

describe('ReviewPlatformAPI identity evidence wire', () => {
  let reviewPlatformAPI: ReviewPlatformAPI;

  beforeEach(() => {
    reviewPlatformAPI = new ReviewPlatformAPI();
    invokeMock.mockReset();
  });

  it('keeps Gitee PR numbers and alphanumeric Issue identities in remote requests', async () => {
    invokeMock.mockResolvedValue({});
    const identity = { platform: 'gitee' as const, host: 'gitee.com', projectPath: 'example/repo' };
    await reviewPlatformAPI.getPullRequestReviewTargetByIdentity({ ...identity, pullRequestId: '69' });
    await reviewPlatformAPI.getIssue({ ...identity, issueId: 'IABC12', page: 1, perPage: 100 });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'review_platform_get_pull_request_review_target_by_identity', {
      request: { ...identity, pullRequestId: '69' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'review_platform_get_issue', {
      request: { ...identity, issueId: 'IABC12', page: 1, perPage: 100 },
    });
  });

  it('sends Issue identity and bounded pagination in a structured request', async () => {
    const evidence = { issueId: '42', comments: [] };
    invokeMock.mockResolvedValueOnce(evidence);
    const request: ReviewPlatformIssueRequest = {
      platform: 'github' as const,
      host: 'github.com',
      projectPath: 'example/repo',
      issueId: '42',
      repositoryPath: 'D:/workspace/example',
      page: 2,
      perPage: 100,
    };

    await expect(reviewPlatformAPI.getIssue(request)).resolves.toBe(evidence);

    expect(invokeMock).toHaveBeenCalledWith('review_platform_get_issue', { request });
  });

  it('sends pull request identity in a structured request', async () => {
    const target = { pullRequest: { id: '7' }, files: [] };
    invokeMock.mockResolvedValueOnce(target);
    const request: ReviewPlatformPullRequestIdentityRequest = {
      platform: 'gitlab' as const,
      host: 'gitlab.com',
      projectPath: 'example/group/repo',
      pullRequestId: '7',
      repositoryPath: 'D:/workspace/example',
    };

    await expect(
      reviewPlatformAPI.getPullRequestReviewTargetByIdentity(request),
    ).resolves.toBe(target);

    expect(invokeMock).toHaveBeenCalledWith(
      'review_platform_get_pull_request_review_target_by_identity',
      { request },
    );
  });

  it('loads workspace context without requesting a pull request list', async () => {
    const context = { remotes: [], pullRequests: [] };
    invokeMock.mockResolvedValueOnce(context);

    await expect(
      reviewPlatformAPI.getWorkspaceContext(
        { workspaceId: 'ws-1', repositoryPath: 'D:/workspace/example' },
        'origin:github:example__repo',
      ),
    ).resolves.toBe(context);

    expect(invokeMock).toHaveBeenCalledWith('review_platform_get_workspace_context', {
      request: {
        workspaceId: 'ws-1',
        repositoryPath: 'D:/workspace/example',
        remoteId: 'origin:github:example__repo',
      },
    });
  });

  const repo = { workspaceId: 'ws-1', repositoryPath: '/repo' };

  it('sends a repository state filter together with its page', async () => {
    const snapshot = { capabilities: { supportedPullRequestStates: ['all', 'merged'] } };
    invokeMock.mockResolvedValue(snapshot);
    await expect(reviewPlatformAPI.getWorkspaceSnapshot(repo, 'origin', 2, 10, 'merged')).resolves.toBe(snapshot);
    expect(invokeMock).toHaveBeenCalledWith('review_platform_get_workspace_snapshot', {
      request: { workspaceId: 'ws-1', repositoryPath: '/repo', remoteId: 'origin', page: 2, perPage: 10, state: 'merged' },
    });
  });

  it('preserves the legacy All request and accepts older hosts', async () => {
    const snapshot = { capabilities: {} };
    invokeMock.mockResolvedValue(snapshot);
    await expect(reviewPlatformAPI.getWorkspaceSnapshot(repo, 'origin', 1, 10, 'all')).resolves.toBe(snapshot);
    expect(invokeMock.mock.calls[0][1].request).not.toHaveProperty('state');
  });

  it('rejects an older host that silently ignores a requested state', async () => {
    invokeMock.mockResolvedValue({ capabilities: {}, pullRequests: [{ state: 'open' }] });
    await expect(reviewPlatformAPI.getWorkspaceSnapshot(repo, 'origin', 1, 10, 'merged'))
      .rejects.toThrow('review_platform_state_filter_unsupported');
  });
});
