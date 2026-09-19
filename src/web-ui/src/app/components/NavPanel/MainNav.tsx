/**
 * MainNav — primary product navigation sidebar.
 *
 * Layout (top to bottom):
 *   1. Search
 *   2. AI Assistant, Task Board, Mini Apps, then Extensions & Compatibility
 *   3. Unified Sessions (all or grouped by project / assistant)
 */

import React, { useCallback, useState, useMemo, useEffect, useRef, useSyncExternalStore } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText,
  Icon,
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
  ScrollArea,
  Tooltip,
} from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { FolderOpen, FolderPlus, Network, Server, Users } from 'lucide-react';
// import { PanelsTopLeft } from 'lucide-react'; // temporarily hidden: Pages nav entry
import { useSceneManager } from '../../hooks/useSceneManager';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import SectionHeader from './components/SectionHeader';
import StickySectionHeader from './components/StickySectionHeader';
import WorkspaceSessionGroupingToggle from './components/WorkspaceSessionGroupingToggle';
import WorkspaceSessionFilterMenu from './components/WorkspaceSessionFilterMenu';
import MiniAppEntry from './components/MiniAppEntry';
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
import { useExternalAppAwareness } from '@/infrastructure/config/components/external-sources/useExternalAppAwareness';

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

  const activeMiniAppId = useMemo(
    () => (typeof activeTabId === 'string' && activeTabId.startsWith('miniapp:') ? activeTabId.slice('miniapp:'.length) : null),
    [activeTabId]
  );

  const workspaceMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const sectionsScrollRef = useRef<HTMLDivElement | null>(null);
  const sessionContentRef = useRef<HTMLDivElement | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceMenuClosing, setWorkspaceMenuClosing] = useState(false);
  const [workspaceMenuPos, setWorkspaceMenuPos] = useState({ top: 0, left: 0 });
  const [isExtensionsOpen, setIsExtensionsOpen] = useState(false);

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
      await sshRemote.openWorkspace(path);
      sshRemote.setShowFileBrowser(false);
      setIsSSHConnectionDialogOpen(false);
    } catch (err) {
      log.error('Failed to open remote workspace', err);
    }
  }, [sshRemote]);

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
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
    removeOverlayMousedown0 = subscribeOverlayInteraction(workspaceMenuRef, 'mousedown', handleClickOutside);
    removeOverlayKeydown1 = subscribeOverlayInteraction(workspaceMenuRef, 'keydown', handleEscape);
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

  const handleOpenAgents = useCallback(() => {
    void activateProductAction('surface.agents.open');
  }, []);

  const handleOpenTodos = useCallback(() => {
    void activateProductAction('surface.todos.open');
  }, []);

  const handleOpenSkills = useCallback(() => {
    void activateProductAction('surface.skills.open');
  }, []);

  const handleOpenEcosystemCompatibility = useCallback(() => {
    void activateProductAction('surface.ecosystemCompatibility.open');
  }, []);

  const isAgentsActive = activeTabId === 'agents';
  const isSkillsActive = activeTabId === 'skills';
  const isEcosystemCompatibilityActive = activeTabId === 'ecosystem-compatibility';
  const hasUnseenEcosystemCompatibility = useExternalAppAwareness(
    isEcosystemCompatibilityActive,
  );

  useEffect(() => {
    if (isAgentsActive || isSkillsActive || isEcosystemCompatibilityActive) {
      setIsExtensionsOpen(true);
    }
  }, [isAgentsActive, isEcosystemCompatibilityActive, isSkillsActive]);

  const workspaceMenuPortal = workspaceMenuOpen ? createOverlayPortal(
    <Menu
      ref={workspaceMenuRef}
      className={`openbitfun-nav-panel__workspace-menu${workspaceMenuClosing ? ' is-closing' : ''}`}
      style={{ top: workspaceMenuPos.top, left: workspaceMenuPos.left }}
    >
      <MenuItem
        leading={<Icon glyph={FolderOpen} />}
        onClick={() => { closeWorkspaceMenu(); void handleOpenProject(); }}
      >
        {t('header.openProject')}
      </MenuItem>
      <MenuItem
        leading={<Icon glyph={FolderPlus} />}
        onClick={() => { closeWorkspaceMenu(); handleNewProject(); }}
      >
        {t('header.newProject')}
      </MenuItem>
      <MenuItem
        leading={<Icon name="user" size="xs" />}
        onClick={handleOpenAssistantManager}
        data-testid="nav-session-group-add-assistant"
      >
        {t('nav.workspaces.actions.newAssistant')}
      </MenuItem>
      <MenuItem
        leading={<Icon glyph={Server} />}
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
                    leading={<Icon glyph={FolderOpen} />}
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
  const agentsTooltip = t('nav.tooltips.agents');
  const skillsTooltip = t('nav.tooltips.skills');
  const ecosystemCompatibilityTooltip = hasUnseenEcosystemCompatibility
    ? t('nav.tooltips.ecosystemCompatibilityUnseen')
    : t('nav.tooltips.ecosystemCompatibility');
  const assistantManagerLabel = t('nav.items.assistant');
  const taskBoardLabel = t('nav.items.todos');
  const extensionsLabel = t('nav.sections.extensions');
  const isAssistantManagerActive = activeTabId === 'assistant' || activeTabId === 'profile';
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
      <NavigationPanelBody className="openbitfun-nav-panel__sections" ref={sectionsScrollRef}>
        <NavigationPanelContent className="openbitfun-nav-panel__main-nav-content">
        <div data-testid="nav-sections" className="openbitfun-nav-panel__sections-slot">
        <div data-openbitfun-component="nav-panel" data-openbitfun-part="topActions" className="openbitfun-nav-panel__top-actions">
          <Tooltip content={assistantManagerLabel} placement="right" followCursor>
            <button data-overflow-trigger
              type="button"
              className={[
                'openbitfun-nav-panel__top-action-btn',
                isAssistantManagerActive ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              data-openbitfun-component="nav-panel"
              data-openbitfun-part="topAction"
              data-openbitfun-action="assistant-manager"
              data-openbitfun-state={isAssistantManagerActive ? 'active' : ''}
              onClick={handleOpenAssistantManager}
              aria-label={assistantManagerLabel}
              data-testid="nav-assistant-manager"
            >
              <span className="openbitfun-nav-panel__top-action-icon-slot" aria-hidden="true">
                <Icon name="user" size="sm" />
              </span>
              <OverflowText>{assistantManagerLabel}</OverflowText>
            </button>
          </Tooltip>

          <Tooltip content={t('nav.tooltips.todos')} placement="right" followCursor>
            <button data-overflow-trigger
              type="button"
              className={[
                'openbitfun-nav-panel__top-action-btn',
                isTaskBoardActive ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              data-openbitfun-component="nav-panel"
              data-openbitfun-part="todoEntry"
              data-openbitfun-action="todos"
              data-openbitfun-state={isTaskBoardActive ? 'active' : ''}
              onClick={handleOpenTodos}
              aria-label={taskBoardLabel}
              aria-pressed={isTaskBoardActive}
              data-testid="nav-todos-btn"
            >
              <span className="openbitfun-nav-panel__top-action-icon-slot" aria-hidden="true">
                <Icon name="clock" size="sm" />
              </span>
              <OverflowText>{taskBoardLabel}</OverflowText>
            </button>
          </Tooltip>

          <div className="openbitfun-nav-panel__miniapp-navigation" data-openbitfun-component="nav-panel" data-openbitfun-part="miniAppFooter">
            <MiniAppEntry
              isActive={activeTabId === 'miniapps' || !!activeMiniAppId}
              activeMiniAppId={activeMiniAppId}
              onOpenMiniApps={() => openScene('miniapps')}
              onOpenMiniApp={(appId) => openScene(`miniapp:${appId}`)}
            />
          </div>

          <div className="openbitfun-nav-panel__top-action-expand" data-openbitfun-component="nav-panel" data-openbitfun-part="extensionGroup" data-openbitfun-state={isExtensionsOpen ? 'open' : ''} data-testid="agent-skill-panel">
            <Tooltip content={extensionsLabel} placement="right" followCursor>
              <button data-overflow-trigger
                type="button"
                className={[
                  'openbitfun-nav-panel__top-action-btn',
                  'openbitfun-nav-panel__top-action-btn--expand',
                  isExtensionsOpen ? 'is-open' : '',
                ].filter(Boolean).join(' ')}
                data-openbitfun-component="nav-panel"
                data-openbitfun-part="topAction"
                data-openbitfun-action="extensions"
                data-openbitfun-state={isExtensionsOpen ? 'open' : ''}
                onClick={() => setIsExtensionsOpen(v => !v)}
                aria-expanded={isExtensionsOpen}
                aria-label={extensionsLabel}
                data-testid="agent-skill-entry"
              >
                <span
                  className="openbitfun-nav-panel__top-action-icon-slot openbitfun-nav-panel__top-action-expand-icons"
                  aria-hidden="true"
                >
                  <Icon
                    name="extension"
                    size="sm"
                    className="openbitfun-nav-panel__top-action-expand-icon-default"
                  />
                  <Icon
                    name="chevron-down"
                    size="sm"
                    className={[
                      'openbitfun-nav-panel__top-action-expand-icon-chevron',
                      isExtensionsOpen ? 'is-open' : '',
                    ].filter(Boolean).join(' ')}
                  />
                </span>
                <OverflowText>{extensionsLabel}</OverflowText>
              </button>
            </Tooltip>

            <div
              className={`openbitfun-nav-panel__top-action-sublist${isExtensionsOpen ? ' is-open' : ''}`}
              data-testid="agent-skill-tabs"
              aria-hidden={!isExtensionsOpen}
              {...(!isExtensionsOpen ? { inert: '' } : {})}
            >
              <div className="openbitfun-nav-panel__top-action-sublist-inner">
                <Tooltip content={agentsTooltip} placement="right" followCursor>
                  <button data-overflow-trigger
                    type="button"
                    className={[
                      'openbitfun-nav-panel__top-action-btn',
                      'openbitfun-nav-panel__top-action-btn--sub',
                      isAgentsActive ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    data-openbitfun-component="nav-panel"
                    data-openbitfun-part="topAction"
                    data-openbitfun-action="agents"
                    data-openbitfun-state={isAgentsActive ? 'active' : ''}
                    onClick={handleOpenAgents}
                    aria-label={agentsTooltip}
                    data-testid="agent-tab"
                  >
                    <span className="openbitfun-nav-panel__top-action-icon-slot" aria-hidden="true">
                      <Icon glyph={Users} size="sm" />
                    </span>
                    <OverflowText>{t('nav.items.agents')}</OverflowText>
                  </button>
                </Tooltip>

                <Tooltip content={skillsTooltip} placement="right" followCursor>
                  <button data-overflow-trigger
                    type="button"
                    className={[
                      'openbitfun-nav-panel__top-action-btn',
                      'openbitfun-nav-panel__top-action-btn--sub',
                      isSkillsActive ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    data-openbitfun-component="nav-panel"
                    data-openbitfun-part="topAction"
                    data-openbitfun-action="skills"
                    data-openbitfun-state={isSkillsActive ? 'active' : ''}
                    onClick={handleOpenSkills}
                    aria-label={skillsTooltip}
                    data-testid="skill-tab"
                  >
                    <span className="openbitfun-nav-panel__top-action-icon-slot" aria-hidden="true">
                      <Icon name="extension" size="sm" />
                    </span>
                    <OverflowText>{t('nav.items.skills')}</OverflowText>
                  </button>
                </Tooltip>

                <Tooltip content={ecosystemCompatibilityTooltip} placement="right" followCursor>
                  <button data-overflow-trigger
                    type="button"
                    className={[
                      'openbitfun-nav-panel__top-action-btn',
                      'openbitfun-nav-panel__top-action-btn--sub',
                      isEcosystemCompatibilityActive ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    data-openbitfun-component="nav-panel"
                    data-openbitfun-part="topAction"
                    data-openbitfun-action="ecosystem-compatibility"
                    data-openbitfun-state={isEcosystemCompatibilityActive ? 'active' : ''}
                    onClick={handleOpenEcosystemCompatibility}
                    aria-label={ecosystemCompatibilityTooltip}
                    data-testid="ecosystem-compatibility-tab"
                  >
                    <span className="openbitfun-nav-panel__top-action-icon-slot" aria-hidden="true">
                      <Icon glyph={Network} size="sm" />
                    </span>
                    <OverflowText>{t('nav.items.ecosystemCompatibility')}</OverflowText>
                    {hasUnseenEcosystemCompatibility ? (
                      <span
                        className="openbitfun-nav-panel__top-action-unseen"
                        data-openbitfun-component="nav-panel"
                        data-openbitfun-part="topActionUnseen"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
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
                      <button
                        ref={workspaceMenuButtonRef}
                        type="button"
                        className={`openbitfun-nav-panel__section-action${workspaceMenuOpen ? ' is-active' : ''}`}
                        aria-label={addSessionGroupTooltip}
                        aria-haspopup="menu"
                        aria-expanded={workspaceMenuOpen}
                        onClick={toggleWorkspaceMenu}
                        data-testid="nav-workspace-add-btn"
                      >
                        <Icon glyph={FolderPlus} size="sm" />
                      </button>
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
