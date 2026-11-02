import { beforeEach, expect, it, vi } from 'vitest';
import { changedProjectFileCount, loadProjectGit, loadProjectSessionCount } from './projectResourceStats';

const mocks = vi.hoisted(() => ({ probe: vi.fn(), status: vi.fn(), sessionPage: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/GitAPI', () => ({ gitAPI: { isGitRepository: mocks.probe, getStatus: mocks.status } }));
vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({ sessionAPI: { listSessionsPage: mocks.sessionPage } }));
beforeEach(() => { vi.resetAllMocks(); });

it('uses the project catalog total instead of the loaded page size and supports legacy pages without discovery fields', async () => {
  mocks.sessionPage.mockResolvedValue({ sessions: [{ sessionId: 'one' }], totalTopLevelCount: 655, hasMore: true });
  expect(await loadProjectSessionCount('project-a')).toEqual({ count: 655, partial: false });
  expect(mocks.sessionPage).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'project-a', limit: 1,
    query: { workspaceId: 'project-a', ordering: 'created', source: 'all' } });
});

it('does not present pending discovery, source failures or missing host totals as an exact zero', async () => {
  for (const extra of [{ discoveryPending: true }, { discoveryWarnings: ['Source offline'] },
    { discoveryDiagnostics: [{ ecosystemId: 'codex', code: 'unavailable' }] }]) {
    mocks.sessionPage.mockResolvedValue({ totalTopLevelCount: 0, ...extra });
    expect(await loadProjectSessionCount('project-a')).toEqual({ count: 0, partial: true });
  }
  mocks.sessionPage.mockResolvedValue({ sessions: [] });
  await expect(loadProjectSessionCount('project-a')).rejects.toThrow('unavailable');
  mocks.sessionPage.mockRejectedValue(new Error('Host offline'));
  await expect(loadProjectSessionCount('project-a')).rejects.toThrow('Host offline');
});

it('deduplicates partially staged and conflicting files in the pending total', () => {
  expect(changedProjectFileCount({ staged: [{ path: 'a', status: 'M' }], unstaged: [{ path: 'a', status: 'M' }, { path: 'b', status: 'M' }],
    untracked: ['c'], conflicts: ['b'], current_branch: 'main', ahead: 1, behind: 2 })).toBe(3);
});

it('keeps non-repositories distinct and fences follow-up Git reads after a device change', async () => {
  mocks.probe.mockResolvedValue(false);
  expect(await loadProjectGit('a', () => true)).toBeNull();
  expect(mocks.status).not.toHaveBeenCalled();
  mocks.probe.mockResolvedValue(true);
  await expect(loadProjectGit('a', () => false)).rejects.toThrow('changed');
  expect(mocks.status).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ ahead: 2, behind: 1 });
  await loadProjectGit('a', () => true);
  expect(mocks.status).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'a' }, 'project-resources');
});
