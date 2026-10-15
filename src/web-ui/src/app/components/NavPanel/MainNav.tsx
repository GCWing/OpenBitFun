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
import WorkspaceListSection from './sections/workspaces/WorkspaceListSection';
import { useSceneStore } from '../../stores/sceneStore';
import { useMiniAppCatalogSync } from '../../scenes/miniapps/hooks/useMiniAppCatalogSync';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { createLogger } from '@/shared/utils/logger';
import { isRemoteWorkspace } from '@/shared/types';
import { useSSHRemoteContext, SSHConnectionDialog, RemoteFileBrowser } from '@/features/ssh-remote';
import { openGlobalSearch } from '@/app/global-search/globalSearchStore';
import { activateProductAction } from '@/app/global-search/productActionActivator';
import { createProject, type ProjectDraft, type ProjectFolder } from '@/app/services/createProject';
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

const log = createLogger('MainNav');
const NewProjectDialog = lazyWithRecovery(() =>
  import('../NewProjectDialog').then(module => ({ default: module.NewProjectDialog }))
);

const MainNav: React.FC = () => {
  const sshRemote = useSSHRemoteContext();
  const sshRemoteRef = useRef(sshRemote);
  sshRemoteRef.current = sshRemote;
  const [isSSHConnectionDialogOpen, setIsSSHConnectionDialogOpen] = useState(false);
  const remoteHostResolver = useRef<((host: NonNullable<ProjectFolder['remote']> | null) => void) | null>(null);

  useEffect(() => {
    if (sshRemote.showFileBrowser) {
      setIsSSHConnectionDialogOpen(false);
      if (remoteHostResolver.current && sshRemote.connectionId) {
        remoteHostResolver.current({
          connectionId: sshRemote.connectionId,
          connectionName: sshRemote.connectionConfig?.name || sshRemote.connectionId,
          sshHost: sshRemote.connectionConfig?.host,
        });
        remoteHostResolver.current = null;
        sshRemote.setShowFileBrowser(false);
      }
    }
  }, [sshRemote]);

  const { openScene } = useSceneManager();
  const activeTabId = useSceneStore(s => s.activeTabId);
  const isOverviewActive = typeof activeTabId === 'string' && (
    ['personal-overview', 'assistant', 'profile', 'agents', 'skills', 'miniapps'].includes(activeTabId)
    || activeTabId.startsWith('miniapp:')
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
  const [remoteFolderTarget, setRemoteFolderTarget] = useState<ProjectFolder | null>(null);
  const remoteFolderResolver = useRef<((folder: ProjectFolder | null) => void) | null>(null);

  const finishRemoteFolderPick = useCallback((folder: ProjectFolder | null) => {
    remoteFolderResolver.current?.(folder);
    remoteFolderResolver.current = null;
    setRemoteFolderTarget(null);
  }, []);

  useEffect(() => {
    if (!isSSHConnectionDialogOpen && !sshRemote.showFileBrowser && !remoteFolderTarget) {
      finishRemoteFolderPick(null);
      remoteHostResolver.current?.(null);
      remoteHostResolver.current = null;
    }
  }, [isSSHConnectionDialogOpen, sshRemote.showFileBrowser, remoteFolderTarget, finishRemoteFolderPick]);

  useEffect(() => () => {
    remoteFolderResolver.current?.(null);
    remoteHostResolver.current?.(null);
  }, []);

  const handleSelectRemoteHost = useCallback(() => new Promise<NonNullable<ProjectFolder['remote']> | null>(resolve => {
    const remote = sshRemoteRef.current;
    if (remote.isConnected && remote.connectionId) {
      resolve({
        connectionId: remote.connectionId,
        connectionName: remote.connectionConfig?.name || remote.connectionId,
        sshHost: remote.connectionConfig?.host,
      });
      return;
    }
    remoteHostResolver.current = resolve;
    setIsSSHConnectionDialogOpen(true);
  }), []);

  const handlePickRemoteFolder = useCallback((existing?: ProjectFolder) => new Promise<ProjectFolder | null>(resolve => {
    remoteFolderResolver.current = resolve;
    if (existing?.remote) setRemoteFolderTarget(existing);
    else setIsSSHConnectionDialogOpen(true);
  }), []);

  const handleConfirmProject = useCallback((draft: ProjectDraft) => createProject(draft, async folder => {
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
  }), [t]);

  const closeWorkspaceDialog = useCallback(() => {
    setWorkspaceDialogOpen(false);
  }, []);

  const openWorkspaceDialog = useCallback(() => setWorkspaceDialogOpen(true), []);

  const handleCreateAssistant = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    const workspace = await workspaceManager.createAssistantWorkspace();
    scope.assertCurrent('open newly created assistant');
    useNurseryStore.getState().openAssistant(workspace.id);
    openScene('assistant');
  }, [openScene]);

  const handleSelectRemoteWorkspace = useCallback(async (path: string) => {
    try {
      if (remoteFolderResolver.current) {
        const remote = remoteFolderTarget?.remote ?? (sshRemote.connectionId ? {
          connectionId: sshRemote.connectionId,
          connectionName: sshRemote.connectionConfig?.name || sshRemote.connectionId,
          sshHost: sshRemote.connectionConfig?.host,
        } : undefined);
        if (!remote) return;
        finishRemoteFolderPick({ path, remote });
        sshRemote.setShowFileBrowser(false);
        setIsSSHConnectionDialogOpen(false);
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

  const handleOpenTodos = useCallback(() => {
    void activateProductAction('surface.todos.open');
  }, []);

  const addSessionGroupTooltip = t('nav.tooltips.addSessionGroup');
  const taskBoardLabel = t('nav.items.todos');
  const isTaskBoardActive = activeTabId === 'todos';
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

          <Tooltip content={t('nav.tooltips.todos')} placement="right" followCursor>
            <NavigationPanelItem
              className="openbitfun-nav-panel__top-action-item openbitfun-nav-panel__top-action-item--root"
              triggerClassName={[
                'openbitfun-nav-panel__top-action-btn',
                isTaskBoardActive ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              data-openbitfun-component="nav-panel"
              data-openbitfun-part="todoEntry"
              data-openbitfun-action="todos"
              data-openbitfun-state={isTaskBoardActive ? 'active' : ''}
              onClick={handleOpenTodos}
              aria-label={taskBoardLabel}
              data-testid="nav-todos-btn"
              leading={(
                <span className="openbitfun-nav-panel__top-action-icon-slot">
                  <Icon name="clock" size="sm" />
                </span>
              )}
              selected={isTaskBoardActive}
            >
              {taskBoardLabel}
            </NavigationPanelItem>
          </Tooltip>
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
            <WorkspaceListSection variant="all" />
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
            onCreateAssistant={handleCreateAssistant}
            defaultParentPath={currentWorkspace && !isRemoteWorkspace(currentWorkspace) ? currentWorkspace.rootPath : undefined}
            data-testid="nav-workspace-dialog"
          />
        </Suspense>
      </RetainedMountBoundary>

      {/* SSH Remote Dialogs */}
      <SSHConnectionDialog
        open={isSSHConnectionDialogOpen}
        onClose={() => setIsSSHConnectionDialogOpen(false)}
      />
      {!remoteHostResolver.current && (remoteFolderTarget?.remote || (sshRemote.showFileBrowser && sshRemote.connectionId)) && (
        <RemoteFileBrowser
          connectionId={remoteFolderTarget?.remote?.connectionId || sshRemote.connectionId!}
          initialPath={remoteFolderTarget?.path || sshRemote.remoteFileBrowserInitialPath}
          homePath={sshRemote.remoteFileBrowserInitialPath}
          selectDirectoriesOnly
          onSelect={handleSelectRemoteWorkspace}
          onCancel={() => {
            const wasSelectingFolder = Boolean(remoteFolderResolver.current);
            finishRemoteFolderPick(null);
            const hasActiveRemoteWorkspace =
              Boolean(sshRemote.remoteWorkspace) ||
              openedWorkspacesList.some(workspace =>
                isRemoteWorkspace(workspace) &&
                workspace.connectionId === sshRemote.connectionId
              );
            sshRemote.setShowFileBrowser(false);
            if (!wasSelectingFolder && !hasActiveRemoteWorkspace) {
              void sshRemote.disconnect();
            }
          }}
        />
      )}
    </>
  );
};

export default MainNav;
