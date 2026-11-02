import { gitAPI, type GitStatus } from '@/infrastructure/api/service-api/GitAPI';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
export async function loadProjectGit(workspaceId: string, isCurrent: () => boolean): Promise<GitStatus | null> {
  const target = { workspaceId };
  if (!await gitAPI.isGitRepository(target)) return null;
  if (!isCurrent()) throw new Error('Project resource view changed');
  return gitAPI.getStatus(target, 'project-resources');
}

export function changedProjectFileCount(status: GitStatus): number {
  return new Set([...status.staged.map(file => file.path), ...status.unstaged.map(file => file.path),
    ...status.untracked, ...status.conflicts]).size;
}

export async function loadProjectSessionCount(workspaceId: string) {
  const page = await sessionAPI.listSessionsPage({ workspaceId, limit: 1,
    query: { workspaceId, ordering: 'created', source: 'all' } });
  if (!Number.isSafeInteger(page.totalTopLevelCount) || page.totalTopLevelCount < 0) {
    throw new Error('Project session count is unavailable on this host');
  }
  return { count: page.totalTopLevelCount,
    partial: page.discoveryPending === true || Boolean(page.discoveryWarnings?.length || page.discoveryDiagnostics?.length) };
}
