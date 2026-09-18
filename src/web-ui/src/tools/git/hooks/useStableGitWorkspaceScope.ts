import { useMemo } from 'react';
import type { GitWorkspaceScope } from '@/infrastructure/api/service-api/GitAPI';

/**
 * Returns a git workspace scope whose object identity only changes when its
 * identifying facts change. Callers frequently build the scope inline on every
 * render; downstream hooks key subscriptions and requests on this object, so
 * they must not re-run just because the parent re-rendered.
 */
export function useStableGitWorkspaceScope(scope: GitWorkspaceScope): GitWorkspaceScope {
  const { workspaceId, repositoryPath } = scope;
  return useMemo<GitWorkspaceScope>(
    () => (repositoryPath === undefined ? { workspaceId } : { workspaceId, repositoryPath }),
    [workspaceId, repositoryPath],
  );
}
