import type { WorkspaceInfo } from '@/shared/types';
import type { GitBasicInfoOptions } from '@/tools/git/hooks/useGitState';

export const WORKSPACE_GIT_BASIC_INFO_SOURCE = 'workspace_item_git_basic_info';
const WORKSPACE_GIT_AUTO_REFRESH_SOURCES = ['workspace_git_initializer'];
export const WORKSPACE_GIT_PENDING_CANCEL_SOURCES = [
  WORKSPACE_GIT_BASIC_INFO_SOURCE,
  ...WORKSPACE_GIT_AUTO_REFRESH_SOURCES,
] as const;
export const WORKSPACE_GIT_PENDING_CANCEL_REASONS = ['mount', 'visibility'] as const;

export function getWorkspaceGitBasicInfoOptions(
  _workspace: WorkspaceInfo,
  isActive: boolean
): GitBasicInfoOptions | undefined {
  return {
    isActive,
    refreshOnMount: isActive,
    refreshOnActive: true,
    participateInWindowFocusRefresh: false,
    debugSource: WORKSPACE_GIT_BASIC_INFO_SOURCE,
    cancelPendingRefreshSources: WORKSPACE_GIT_AUTO_REFRESH_SOURCES,
  };
}

export function suppressWorkspaceGitRefreshOnMountDuringSessionTransition(
  options: GitBasicInfoOptions | undefined,
  transitionActive: boolean
): GitBasicInfoOptions | undefined {
  if (!options || !transitionActive) {
    return options;
  }

  return {
    ...options,
    refreshOnMount: false,
  };
}
