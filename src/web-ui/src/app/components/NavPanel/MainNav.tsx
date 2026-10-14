/**
 * MainNav — primary product navigation sidebar.
 *
 * Layout (top to bottom):
 *   1. Search
 *   2. Personal Overview and Task Board
 *   3. Unified Sessions (all or grouped by project / assistant)
 */

import React, { useCallback, useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText,
  Icon,
  IconButton,
  KeyHint,
  Menu,
  MenuItem,
  MenuList,
  MenuSection,
  MenuSeparator,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  NavigationPanelItem,
  ScrollArea,
  Tooltip,
} from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { FolderOpen, FolderPlus, House, Server } from 'lucide-react';
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
import { getRecentWorkspaceLineParts } from '@/shared/utils/recentWorkspaceDisplay';
import { computeFixedPopoverPosition } from '@/shared/utils/fixedPopoverViewport';
import { useSSHRemoteContext, SSHConnectionDialog, RemoteFileBrowser } from '@/features/ssh-remote';
import { openGlobalSearch } from '@/app/global-search/globalSearchStore';
import { activateProductAction } from '@/app/global-search/productActionActivator';
import {
  getGlobalSearchShortcutLabel,
  splitGlobalSearchShortcutLabel,
  subscribeGlobalSearchShortcut,
} from '@/app/global-search/globalSearchShortcut';

import './NavPanel.scss';

const log = createLogger('MainNav');

const MainNav: React.FC = () => {
  const sshRemote = useSSHRemoteContext();
  const [isSSHConnectionDialogOpen, setIsSSHConnectionDialogOpen] = useState(false);

  useEffect(() => {
    if (sshRemote.showFileBrowser) {
      setIsSSHConnectionDialogOpen(false);
    }
  }, [sshRemote.showFileBrowser]);

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
    recentWorkspaces,
    openedWorkspacesList,
    switchWorkspace,
  } = useWorkspaceContext();

  useMiniAppCatalogSync({
    enabled: !workspaceLoading,
    initialLoad: 'idle',
  });

  const workspaceMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const sectionsScrollRef = useRef<HTMLDivElement | null>(null);
  const sessionContentRef = useRef<HTMLDivElement | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceMenuClosing, setWorkspaceMenuClosing] = useState(false);
  const [workspaceMenuPos, setWorkspaceMenuPos] = useState({ top: 0, left: 0 });

  const closeWorkspaceMenu = useCallback(() => {
    setWorkspaceMenuClosing(true);
    window.setTimeout(() => {
      setWorkspaceMenuOpen(false);
      setWorkspaceMenuClosing(false);
    }, 150);
  }, []);

  const updateWorkspaceMenuPos = useCallback(() => {
    const btn = workspaceMenuButtonRef.current;
    if (!btn || !workspaceMenuOpen) return;
    const rect = btn.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 6;
    const fallbackWidth = 300;
    const fallbackHeight = 420;

    const apply = () => {
      const menuEl = workspaceMenuRef.current;
      const w = menuEl?.offsetWidth ?? fallbackWidth;
      const h = menuEl?.offsetHeight ?? fallbackHeight;
      setWorkspaceMenuPos(computeFixedPopoverPosition(rect, w, h, gap, viewportPadding));
    };

    apply();
    requestAnimationFrame(apply);
  }, [workspaceMenuOpen]);

  const openWorkspaceMenu = useCallback(async () => {
    try {
      await workspaceManager.cleanupInvalidWorkspaces();
    } catch (error) {
      log.warn('Failed to cleanup invalid workspaces before opening workspace menu', { error });
    }
    const rect = workspaceMenuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWorkspaceMenuPos(computeFixedPopoverPosition(rect, 300, 420, 6, 8));
    setWorkspaceMenuOpen(true);
    setWorkspaceMenuClosing(false);
  }, []);

  const toggleWorkspaceMenu = useCallback(() => {
    if (workspaceMenuOpen) { closeWorkspaceMenu(); return; }
    void openWorkspaceMenu();
  }, [closeWorkspaceMenu, openWorkspaceMenu, workspaceMenuOpen]);

  const handleOpenProject = useCallback(async () => {
    try {
      await activateProductAction('project.open', { t });
    } catch (err) {
      log.error('Failed to open project', err);
    }
  }, [t]);

  const handleNewProject = useCallback(() => {
    void activateProductAction('project.new');
  }, []);

  const handleOpenAssistantManager = useCallback(() => {
    closeWorkspaceMenu();
    openScene('assistant');
  }, [closeWorkspaceMenu, openScene]);

  const handleSwitchWorkspace = useCallback(async (workspaceId: string) => {
    const targetWorkspace = recentWorkspaces.find(item => item.id === workspaceId);
    if (!targetWorkspace) return;
    closeWorkspaceMenu();
    await switchWorkspace(targetWorkspace);
  }, [closeWorkspaceMenu, recentWorkspaces, switchWorkspace]);

  const handleOpenRemoteSSH = useCallback(() => {
    closeWorkspaceMenu();
    setIsSSHConnectionDialogOpen(true);
  }, [closeWorkspaceMenu]);

  const handleSelectRemoteWorkspace = useCallback(async (path: string) => {
    try {
      if (!(await sshRemote.openWorkspace(path))) {
        return;
      }
      sshRemote.setShowFileBrowser(false);
      setIsSSHConnectionDialogOpen(false);
    } catch (err) {
      log.error('Failed to open remote workspace', err);
    }
  }, [sshRemote]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (workspaceMenuButtonRef.current?.contains(target)) return;
      if (workspaceMenuRef.current?.contains(target)) return;
      closeWorkspaceMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeOwnedKeyboardEvent(event)) closeWorkspaceMenu();
    };
    const removeOverlayMousedown0 = subscribeOverlayInteraction(workspaceMenuRef, 'mousedown', handleClickOutside);
    const removeOverlayKeydown1 = subscribeOverlayInteraction(workspaceMenuRef, 'keydown', handleEscape);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [closeWorkspaceMenu, workspaceMenuOpen]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;

    updateWorkspaceMenuPos();

    const handleViewportChange = () => updateWorkspaceMenuPos();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [workspaceMenuOpen, updateWorkspaceMenuPos]);

  const handleOpenTodos = useCallback(() => {
    void activateProductAction('surface.todos.open');
  }, []);

  const workspaceMenuPortal = workspaceMenuOpen ? createOverlayPortal(
    <Menu
      ref={workspaceMenuRef}
      className={`openbitfun-nav-panel__workspace-menu${workspaceMenuClosing ? ' is-closing' : ''}`}
      style={{ top: workspaceMenuPos.top, left: workspaceMenuPos.left }}
    >
      <MenuItem
        leading={<Icon glyph={FolderOpen} size="sm" />}
        onClick={() => { closeWorkspaceMenu(); void handleOpenProject(); }}
      >
        {t('header.openProject')}
      </MenuItem>
      <MenuItem
        leading={<Icon glyph={FolderPlus} size="sm" />}
        onClick={() => { closeWorkspaceMenu(); handleNewProject(); }}
      >
        {t('header.newProject')}
      </MenuItem>
      <MenuItem
        leading={<Icon name="user" size="sm" />}
        onClick={handleOpenAssistantManager}
        data-testid="nav-session-group-add-assistant"
      >
        {t('nav.workspaces.actions.newAssistant')}
      </MenuItem>
      <MenuItem
        leading={<Icon glyph={Server} size="sm" />}
        onClick={handleOpenRemoteSSH}
      >
        {t('ssh.remote.connect')}
      </MenuItem>
      <MenuSeparator />
      <MenuSection
        title={t('header.recentWorkspaces')}
      >
        <ScrollArea className="openbitfun-nav-panel__workspace-menu-workspaces">
          <MenuList>
            {recentWorkspaces.length === 0 ? (
              <div className="openbitfun-nav-panel__workspace-menu-empty">
                <span>{t('header.noRecentWorkspaces')}</span>
              </div>
            ) : (
              recentWorkspaces.map((workspace) => {
                const { hostPrefix, folderLabel, tooltip } = getRecentWorkspaceLineParts(workspace);
                const isCurrent = workspace.id === currentWorkspace?.id;
                return (
                  <MenuItem data-overflow-trigger
                    key={workspace.id}
                    leading={<Icon glyph={FolderOpen} size="sm" />}
                    role="menuitemradio"
                    checked={isCurrent}
                    metadata={isCurrent ? <Icon name="check-line" size="xs" /> : undefined}
                    title={tooltip}
                    onClick={() => { void handleSwitchWorkspace(workspace.id); }}
                    data-testid="nav-workspace-menu-recent-workspace"
                    data-workspace-id={workspace.id}
                  >
                    <span className="openbitfun-nav-panel__workspace-menu-item-main">
                      {hostPrefix ? (
                        <>
                          <OverflowText className="openbitfun-nav-panel__workspace-menu-item-host">{hostPrefix}</OverflowText>
                          <span className="openbitfun-nav-panel__workspace-menu-item-host-sep" aria-hidden>
                            ·
                          </span>
                        </>
                      ) : null}
                      <OverflowText className="openbitfun-nav-panel__workspace-menu-item-name">{folderLabel}</OverflowText>
                    </span>
                  </MenuItem>
                );
              })
            )}
          </MenuList>
          </ScrollArea>
      </MenuSection>
    </Menu>,
    getAppearanceOverlayHost()
  ) : null;

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
                    <Tooltip content={addSessionGroupTooltip} placement="right" followCursor disabled={workspaceMenuOpen}>
                      <IconButton
                        ref={workspaceMenuButtonRef}
                        className={`openbitfun-nav-panel__section-action${workspaceMenuOpen ? ' is-active' : ''}`}
                        aria-label={addSessionGroupTooltip}
                        aria-haspopup="menu"
                        aria-expanded={workspaceMenuOpen}
                        onClick={toggleWorkspaceMenu}
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

      {workspaceMenuPortal}

      {/* SSH Remote Dialogs */}
      <SSHConnectionDialog
        open={isSSHConnectionDialogOpen}
        onClose={() => setIsSSHConnectionDialogOpen(false)}
      />
      {sshRemote.showFileBrowser && sshRemote.connectionId && (
        <RemoteFileBrowser
          connectionId={sshRemote.connectionId}
          initialPath={sshRemote.remoteFileBrowserInitialPath}
          homePath={sshRemote.remoteFileBrowserInitialPath}
          selectDirectoriesOnly
          onSelect={handleSelectRemoteWorkspace}
          onCancel={() => {
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
