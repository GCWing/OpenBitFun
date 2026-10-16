import { forwardRef } from 'react';
import { Icon, MenuItem, MenuSeparator } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceId, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { sessionSourceAgentLabel, useWorkspaceSessionViewStore, type WorkspaceSessionSourceAgent } from '../../workspaceSessionView';
import WorkspaceMenuSubmenu from './WorkspaceMenuSubmenu';

const SOURCES: readonly WorkspaceSessionSourceAgent[] = ['all', 'openbitfun', 'codex', 'zcode'];

interface WorkspaceSessionSourceFilterProps {
  workspaceId: string;
  onSelect: () => void;
}

const WorkspaceSessionSourceFilter = forwardRef<HTMLDivElement, WorkspaceSessionSourceFilterProps>(
  function WorkspaceSessionSourceFilter({ workspaceId, onSelect }, forwardedRef) {
    const { t } = useI18n('common');
    const scope = surfaceScopedKey(getActiveSurfaceId(), workspaceId);
    const selected = useWorkspaceSessionViewStore(state => state.sourceAgents[scope] ?? 'all');
    const setSourceAgent = useWorkspaceSessionViewStore(state => state.setSourceAgent);

    return (
      <>
        <MenuSeparator />
        <WorkspaceMenuSubmenu
          ref={forwardedRef}
          label={t('nav.sessions.sourceAgentFilter')}
          leading={<Icon name="filter" size="sm" />}
          triggerTestId="nav-workspace-menu-source-agents"
          submenuTestId="nav-workspace-menu-source-submenu"
        >
          {SOURCES.map(source => (
            <MenuItem
              key={source}
              role="menuitemradio"
              checked={selected === source}
              data-testid={`nav-workspace-source-${source}`}
              onClick={() => { setSourceAgent(scope, source); onSelect(); }}
            >
              {source === 'all' ? t('nav.sessions.allSourceAgents') : sessionSourceAgentLabel(source)}
            </MenuItem>
          ))}
        </WorkspaceMenuSubmenu>
      </>
    );
  },
);

export default WorkspaceSessionSourceFilter;
