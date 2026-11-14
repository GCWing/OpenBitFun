import { Trans } from 'react-i18next';
import { useI18n } from '@/infrastructure/i18n';
import { useTrackedChangeCount } from '@/tools/git/hooks/useTrackedChangeCount';

export function WelcomeWorkspaceChanges({ workspaceId, remoteWorkspace }: {
  workspaceId: string;
  remoteWorkspace: boolean;
}) {
  const count = useTrackedChangeCount(workspaceId, remoteWorkspace);
  const { i18n, formatNumber } = useI18n('flow-chat');
  if (count === null || count <= 0) return null;

  return (
    <p className="welcome-panel__workspace-changes"
      data-openbitfun-product-component="welcome-panel"
      data-openbitfun-product-part="workspaceChanges">
      <Trans ns="flow-chat" i18nKey="welcome.workspaceChanges" i18n={i18n} count={count}
        values={{ fileCount: formatNumber(count) }} components={{ number: <strong /> }} />
    </p>
  );
}
