/**
 * MainNav — primary product navigation sidebar.
 *
 * Layout (top to bottom):
 *   1. Search
 *   2. Personal Overview and Task Board
 *   3. Unified Sessions (all or grouped by project / assistant)
 */

import React, { Suspense, useCallback, useState, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  OverflowText,
  Icon,
  IconButton,
  KeyHint,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  NavigationPanelItem,
  Tooltip,
} from '@openbitfun/ui';
import { FolderPlus, House } from 'lucide-react';
// import { PanelsTopLeft } from 'lucide-react'; // temporarily hidden: Pages nav entry
import { useSceneManager } from '../../hooks/useSceneManager';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import SectionHeader from './components/SectionHeader';
import StickySectionHeader from './components/StickySectionHeader';
import WorkspaceSessionGroupingToggle from './components/WorkspaceSessionGroupingToggle';
import WorkspaceSessionFilterMenu from './components/WorkspaceSessionFilterMenu';
import { useMiniAppNavigation } from '@/app/scenes/miniapps/miniAppNavigationStore';
import WorkspaceListSection from './sections/workspaces/WorkspaceListSection';
import { useSceneStore } from '../../stores/sceneStore';
import { useMiniAppCatalogSync } from '../../scenes/miniapps/hooks/useMiniAppCatalogSync';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { isRemoteWorkspace } from '@/shared/types';
import { useSSHRemoteContext, SSHConnectionDialog, RemoteFileBrowser } from '@/features/ssh-remote';
import { savedConnectionConfig } from '@/features/ssh-remote/savedConnectionConfig';
import { workspacePresetHost } from '@/features/ssh-remote/useWorkspaceSourceOptions';
import { isSshAuthenticationError, workspaceSourceErrorKey } from '@/features/ssh-remote/workspaceSourceError';
import type { WorkspaceConnectionTarget } from '@/features/ssh-remote/types';
import { openGlobalSearch } from '@/app/global-search/globalSearchStore';
import { useSidebarNavigation } from '@/app/navigation/useSidebarNavigation';
import PinnedNavigationItems from './components/PinnedNavigationItems';
import { createProject, type ProjectDraft, type ProjectFolder } from '@/app/services/createProject';
import { useWorkspaceSessionViewStore } from './workspaceSessionView';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useNurseryStore } from '@/app/scenes/profile/nurseryStore';
import { RetainedMountBoundary } from '@/shared/presence';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import {
  getGlobalSearchShortcutLabel,
  splitGlobalSearchShortcutLabel,
  subscribeGlobalSearchShortcut,
} from '@/app/global-search/globalSearchShortcut';

import './NavPanel.scss';
import type { WorkspaceConnectionPreset } from '@/features/ssh-remote/useWorkspaceSourceOptions';

const log = createLogger('MainNav');
const NewProjectDialog = lazyWithRecovery(() =>
  import('../NewProjectDialog').then(module => ({ default: module.NewProjectDialog }))
);
const MiniAppShortcuts = lazyWithRecovery(() => import('./components/MiniAppShortcuts'));

const MainNav: React.FC = () => {
  const sshRemote = useSSHRemoteContext();
  const sshRemoteRef = useRef(sshRemote);
  sshRemoteRef.current = sshRemote;
  const [isSSHConnectionDialogOpen, setIsSSHConnectionDialogOpen] = useState(false);
  const [connectionTargetType, setConnectionTargetType] = useState<WorkspaceConnectionTarget>('ssh');
  const [connectionPreset, setConnectionPreset] = useState<WorkspaceConnectionPreset>();
  const remoteHostResolver = useRef<((host: NonNullable<ProjectFolder['remote']> | null) => void) | null>(null);

  const { openScene } = useSceneManager();
  const activeTabId = useSceneStore(s => s.activeTabId);
  const { pinnedAppIds } = useMiniAppNavigation();
  const sidebarNavigation = useSidebarNavigation();
  const isOverviewActive = !sidebarNavigation.selectedId && typeof activeTabId === 'string' && (
    ['personal-overview', 'assistant', 'profile', 'agents', 'skills', 'miniapps'].includes(activeTabId)
    || (activeTabId.startsWith('miniapp:') && !pinnedAppIds.includes(activeTabId.slice('miniapp:'.length)))
  );
  const { t } = useI18n('common');
  const searchShortcutLabel = useSyncExternalStore(
    subscribeGlobalSearchShortcut,
    getGlobalSearchShortcutLabel,
    getGlobalSearchShortcutLabel,
  );
  const searchShortcutHint = splitGlobalSearchShortcutLabel(searchShortcutLabel);
  // const { t: tPages } = useI18n('scenes/pages'); // temporarily hidden: Pages nav entry
  const {
    currentWorkspace,
    loading: workspaceLoading,
    openedWorkspacesList,
  } = useWorkspaceContext();

  useMiniAppCatalogSync({
    enabled: !workspaceLoading,
    initialLoad: 'idle',
  });

  const sectionsScrollRef = useRef<HTMLDivElement | null>(null);
  const sessionContentRef = useRef<HTMLDivElement | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [showAssistantChoice, setShowAssistantChoice] = useState(true);
  const [remoteFolderTarget, setRemoteFolderTarget] = useState<ProjectFolder | null>(null);
  const remoteFolderResolver = useRef<((folder: ProjectFolder | null) => void) | null>(null);
  const finishRemoteFolderPick = useCallback((folder: ProjectFolder | null) => {
    remoteFolderResolver.current?.(folder);
    remoteFolderResolver.current = null;
    setRemoteFolderTarget(null);
  }, []);
  useEffect(() => () => { remoteFolderResolver.current?.(null); }, []);
  useEffect(() => () => { remoteHostResolver.current?.(null); }, []);

  const handleSelectRemoteHost = useCallback(async (target: WorkspaceConnectionTarget, preset?: WorkspaceConnectionPreset) => {
    const scope = getActiveSurfaceScope();
    const profile = workspacePresetHost(preset);
    if (profile && !preset?.edit && (profile.username !== '' || profile.wsl || profile.container?.local)) {
      try {
        const result = await sshRemoteRef.current.connect(profile.id, savedConnectionConfig(profile), { browseAfterConnect: false });
        scope.assertCurrent('accept connected project source');
        return { connectionId: result?.connectionId || profile.id, connectionName: profile.name, sshHost: profile.host };
      } catch (cause) {
        scope.assertCurrent('retry project source authentication');
        if (profile.wsl || profile.container?.local || !isSshAuthenticationError(cause)) {
          log.error('Failed to connect selected project source', cause);
          throw new Error(t(profile.wsl || profile.container?.local ? workspaceSourceErrorKey(target, cause) : 'workspaceSource.connectionFailed'));
        }
        preset = { kind: 'saved', connection: profile, authenticate: true };
      }
    }
    return new Promise<NonNullable<ProjectFolder['remote']> | null>(resolve => {
      remoteHostResolver.current = resolve;
      setConnectionTargetType(target); setConnectionPreset(preset); setIsSSHConnectionDialogOpen(true);
    });
  }, [t]);

  const handlePickRemoteFolder = useCallback(async (target: WorkspaceConnectionTarget, existing?: ProjectFolder, preset?: WorkspaceConnectionPreset) => {
    const scope = getActiveSurfaceScope();
    const remote = existing?.remote ?? await handleSelectRemoteHost(target, preset);
    scope.assertCurrent('browse selected project environment');
    if (!remote) return null;
    return new Promise<ProjectFolder | null>(resolve => {
      remoteFolderResolver.current = resolve;
      setRemoteFolderTarget({ path: existing?.path || '', remote });
    });
  }, [handleSelectRemoteHost]);

  const handleConfirmProject = useCallback(async (draft: ProjectDraft) => {
    const scope = getActiveSurfaceScope();
    const succeeded = await createProject(draft, async folder => {
      const remote = sshRemoteRef.current;
      if (folder.remote?.connectionId !== remote.connectionId) {
        throw new Error(t('newProject.remoteConnectionChanged'));
      }
      if (!(await remote.openWorkspace(folder.path))) {
        // A cancelled rebind returns to this draft, not the provider's standalone picker.
        remote.setShowFileBrowser(false);
        return null;
      }
      const workspace = workspaceManager.getState().currentWorkspace;
      if (!workspace) throw new Error(t('newProject.errorCreateFailed'));
      return workspace;
    });
    scope.assertCurrent('reveal created project');
    // The flat session view has no row for a new project without sessions.
    if (succeeded) useWorkspaceSessionViewStore.getState().setGrouping('grouped');
    return succeeded;
  }, [t]);

  const closeWorkspaceDialog = useCallback(() => {
    setWorkspaceDialogOpen(false);
  }, []);

  const openWorkspaceDialog = useCallback(() => {
    setShowAssistantChoice(true);
    setWorkspaceDialogOpen(true);
  }, []);

  // Menu, Welcome and global search use the same source pickers as the sidebar.
  useEffect(() => {
    const onNewProject = () => {
      setShowAssistantChoice(false);
      setWorkspaceDialogOpen(true);
    };
    window.addEventListener('nav:new-project', onNewProject);
    return () => window.removeEventListener('nav:new-project', onNewProject);
  }, []);

  const handleCreateAssistant = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    const workspace = await workspaceManager.createAssistantWorkspace();
    scope.assertCurrent('open newly created assistant');
    useNurseryStore.getState().openAssistant(workspace.id);
    openScene('assistant');
  }, [openScene]);

  const handleSelectRemoteWorkspace = useCallback(async (path: string) => {
    try {
      if (remoteFolderResolver.current && remoteFolderTarget?.remote) {
        finishRemoteFolderPick({ path, remote: remoteFolderTarget.remote });
        return;
      }
      if (!(await sshRemote.openWorkspace(path))) {
        return;
      }
      sshRemote.setShowFileBrowser(false);
      setIsSSHConnectionDialogOpen(false);
    } catch (err) {
      log.error('Failed to open remote workspace', err);
    }
  }, [sshRemote, remoteFolderTarget, finishRemoteFolderPick]);

  const addSessionGroupTooltip = t('nav.tooltips.addSessionGroup');
  return (
    <>
    <NavigationPanel
      className="openbitfun-nav-panel__main-nav"
    >
      <NavigationPanelHeader className="openbitfun-nav-panel__main-nav-header">
        <div data-openbitfun-component="nav-panel" data-openbitfun-part="brandHeader" className="openbitfun-nav-panel__brand-header">
        <div className="openbitfun-nav-panel__utility-row" data-openbitfun-component="nav-panel" data-openbitfun-part="utilityRow">
          <div className="openbitfun-nav-panel__brand-search" data-openbitfun-component="nav-panel" data-openbitfun-part="search">
            <Tooltip content={t('nav.search.triggerTooltip')} placement="right" followCursor>
              <button data-overflow-trigger
                type="button"
                className="openbitfun-nav-panel__search-trigger"
                data-openbitfun-component="nav-panel"
                data-openbitfun-part="searchTrigger"
                onClick={() => openGlobalSearch()}
                aria-label={t('nav.search.triggerTooltip')}
                data-testid="nav-search-trigger"
              >
                <span className="openbitfun-nav-panel__search-trigger__icon" aria-hidden="true">
                  <span className="openbitfun-nav-panel__search-trigger__icon-inner">
                    <Icon name="search" size="xs" />
                  </span>
                </span>
                <OverflowText className="openbitfun-nav-panel__search-trigger__label">
                  {t('nav.search.triggerPlaceholder')}
                </OverflowText>
                <KeyHint
                  data-testid="nav-search-shortcut"
                  aria-hidden="true"
                  icon={searchShortcutHint.modifier}
                >
                  {searchShortcutHint.key}
                </KeyHint>
              </button>
            </Tooltip>
          </div>
        </div>
        </div>
      </NavigationPanelHeader>
      <NavigationPanelBody className="openbitfun-nav-panel__sections" ref={sectionsScrollRef} scrollbarVisibility="hidden">
        <NavigationPanelContent className="openbitfun-nav-panel__main-nav-content">
        <div data-testid="nav-sections" className="openbitfun-nav-panel__sections-slot">
        <div data-openbitfun-component="nav-panel" data-openbitfun-part="topActions" className="openbitfun-nav-panel__top-actions">
          <Tooltip content={t('nav.items.personalOverview')} placement="right" followCursor>
            <NavigationPanelItem
              className="openbitfun-nav-panel__top-action-item openbitfun-nav-panel__top-action-item--root"
              triggerClassName={`openbitfun-nav-panel__top-action-btn${isOverviewActive ? ' is-active' : ''}`}
              data-openbitfun-component="nav-panel"
              data-openbitfun-part="topAction"
              data-openbitfun-action="personal-overview"
              data-openbitfun-state={isOverviewActive ? 'active' : ''}
              onClick={() => openScene('personal-overview')}
              aria-label={t('nav.items.personalOverview')}
              data-testid="nav-personal-overview"
              leading={<span className="openbitfun-nav-panel__top-action-icon-slot"><Icon glyph={House} size="sm" /></span>}
              selected={isOverviewActive}
            >
              {t('nav.items.personalOverview')}
            </NavigationPanelItem>
          </Tooltip>

          <PinnedNavigationItems navigation={sidebarNavigation} />
          {pinnedAppIds.length > 0 && <Suspense fallback={null}><MiniAppShortcuts /></Suspense>}
        </div>

        {/* Unified sessions */}
        <div className="openbitfun-nav-panel__section" data-openbitfun-component="nav-panel" data-openbitfun-part="section" data-openbitfun-section="sessions">
          <StickySectionHeader scrollRootRef={sectionsScrollRef} contentRef={sessionContentRef}>
            <SectionHeader
              label={t('nav.items.sessions')}
              actions={
                <>
                  <WorkspaceSessionGroupingToggle />
                  <WorkspaceSessionFilterMenu />
                  <div className="openbitfun-nav-panel__workspace-action-wrap">
                    <Tooltip content={addSessionGroupTooltip} placement="right" followCursor disabled={workspaceDialogOpen}>
                      <IconButton
                        className={`openbitfun-nav-panel__section-action${workspaceDialogOpen ? ' is-active' : ''}`}
                        aria-label={addSessionGroupTooltip}
                        aria-haspopup="dialog"
                        aria-expanded={workspaceDialogOpen}
                        onClick={() => { void openWorkspaceDialog(); }}
                        data-testid="nav-workspace-add-btn"
                        icon={<Icon glyph={FolderPlus} size="sm" />}
                        size="xs"
                        variant="quiet"
                      />
                    </Tooltip>
                  </div>
                </>
              }
            />
          </StickySectionHeader>
          <div ref={sessionContentRef} className="openbitfun-nav-panel__items" data-openbitfun-component="nav-panel" data-openbitfun-part="sectionContent">
            <WorkspaceListSection variant="all" scrollRootRef={sectionsScrollRef} />
          </div>
        </div>
        </div>
        </NavigationPanelContent>
      </NavigationPanelBody>
    </NavigationPanel>

      <RetainedMountBoundary present={workspaceDialogOpen}>
        <Suspense fallback={null}>
          <NewProjectDialog
            isOpen={workspaceDialogOpen}
            onClose={closeWorkspaceDialog}
            onConfirm={handleConfirmProject}
            onPickRemoteFolder={handlePickRemoteFolder}
            onSelectRemoteHost={handleSelectRemoteHost}
            onCreateAssistant={showAssistantChoice ? handleCreateAssistant : undefined}
            defaultParentPath={currentWorkspace && !isRemoteWorkspace(currentWorkspace) ? currentWorkspace.rootPath : undefined}
            data-testid="nav-workspace-dialog"
          />
        </Suspense>
      </RetainedMountBoundary>

      {/* SSH Remote Dialogs */}
      <SSHConnectionDialog
        open={isSSHConnectionDialogOpen}
        initialTargetType={connectionTargetType}
        initialPreset={connectionPreset}
        fixedSource
        confirmLabel={t('ssh.remote.connect')}
        browseAfterConnect={false}
        onConnected={(config, connectionId) => {
          remoteHostResolver.current?.({ connectionId, connectionName: config.name, sshHost: config.host });
          remoteHostResolver.current = null;
        }}
        onClose={() => { remoteHostResolver.current?.(null); remoteHostResolver.current = null; setIsSSHConnectionDialogOpen(false); }}
      />
      {(remoteFolderTarget?.remote || (!workspaceDialogOpen && sshRemote.showFileBrowser && sshRemote.connectionId)) && (
        <RemoteFileBrowser
          connectionId={remoteFolderTarget?.remote?.connectionId || sshRemote.connectionId!}
          initialPath={remoteFolderTarget?.path || sshRemote.remoteFileBrowserInitialPath}
          homePath={sshRemote.remoteFileBrowserInitialPath}
          selectDirectoriesOnly
          onSelect={handleSelectRemoteWorkspace}
          onCancel={() => {
            if (remoteFolderResolver.current) { finishRemoteFolderPick(null); return; }
            const hasActiveRemoteWorkspace =
              Boolean(sshRemote.remoteWorkspace) ||
              openedWorkspacesList.some(workspace =>
                isRemoteWorkspace(workspace) &&
                workspace.connectionId === sshRemote.connectionId
              );
            sshRemote.setShowFileBrowser(false);
            if (!hasActiveRemoteWorkspace) {
              void sshRemote.disconnect();
            }
          }}
        />
      )}
    </>
  );
};

export default MainNav;
