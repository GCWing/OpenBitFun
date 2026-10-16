import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Icon, MenuItem } from '@openbitfun/ui';

import type { AcpClientInfo } from '@/infrastructure/api/service-api/ACPClientAPI';
import { useI18n } from '@/infrastructure/i18n';
import WorkspaceMenuSubmenu from './WorkspaceMenuSubmenu';

interface WorkspaceAcpSessionSubmenuProps {
  clients: readonly AcpClientInfo[];
  loading: boolean;
  onSelect: (client: AcpClientInfo) => void;
}

const WorkspaceAcpSessionSubmenu = forwardRef<HTMLDivElement, WorkspaceAcpSessionSubmenuProps>(
  function WorkspaceAcpSessionSubmenu({ clients, loading, onSelect }, forwardedRef) {
    const { t } = useI18n('common');
    if (!loading && clients.length === 0) return null;

    return (
      <WorkspaceMenuSubmenu
        ref={forwardedRef}
        label={t('nav.sessions.acpSessions')}
        leading={<Icon name="user" size="sm" />}
        triggerTestId="nav-workspace-menu-acp-sessions"
        submenuTestId="nav-workspace-menu-acp-submenu"
        layoutRevision={`${loading}:${clients.length}`}
      >
        {loading ? (
          <MenuItem leading={<Loader2 className="openbitfun-nav-panel__menu-loading-icon" aria-hidden="true" />} disabled>
            {t('app.loading')}
          </MenuItem>
        ) : clients.map(client => (
          <MenuItem
            key={client.id}
            leading={<Icon name="user" size="sm" />}
            onClick={() => onSelect(client)}
            data-testid="nav-workspace-menu-create-acp-session"
            data-acp-client-id={client.id}
          >
            {t('nav.sessions.newExternalAgentSessionShort', { agentName: client.name || client.id })}
          </MenuItem>
        ))}
      </WorkspaceMenuSubmenu>
    );
  },
);

export default WorkspaceAcpSessionSubmenu;
