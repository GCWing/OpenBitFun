import { useCallback } from 'react';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { useReviewPlatformSupport } from '@/infrastructure/peer-device/useReviewPlatformSupport';
import { createLogger } from '@/shared/utils/logger';
import { parsePullRequestUrl } from '@/shared/utils/pullRequestLinks';
import { createReviewPlatformPullRequestDetailTab } from '@/shared/utils/tabUtils';

const log = createLogger('FlowChatHttpLink');

export function useFlowChatHttpLinkClick(workspaceId?: string, workspacePath?: string) {
  const canViewPullRequests = useReviewPlatformSupport();

  return useCallback((url: string, event: React.MouseEvent<HTMLAnchorElement>): boolean => {
    const target = parsePullRequestUrl(url);
    if (!target) return false;

    const externalModifier = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (!canViewPullRequests || !workspaceId || externalModifier) {
      // Consume the click: returning false opens the built-in browser. The
      // system opener belongs to the controller, never the selected peer.
      void systemAPI.openExternal(url).catch(error => {
        log.error('Failed to open pull request URL', { url, error });
      });
      return true;
    }

    createReviewPlatformPullRequestDetailTab({
      workspaceId,
      workspacePath,
      pullRequestId: target.pullRequestId,
      pullRequestUrl: target.webUrl,
      title: `PR #${target.pullRequestId}`,
    });
    return true;
  }, [canViewPullRequests, workspaceId, workspacePath]);
}
