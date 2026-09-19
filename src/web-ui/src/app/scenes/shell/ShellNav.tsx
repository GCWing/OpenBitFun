import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { TerminalConfig } from '@/infrastructure/config/types';
import TerminalEditModal from '@/app/components/panels/TerminalEditModal';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { ContextType } from '@/shared/context-menu-system/types/context.types';
import type { MenuItem as ContextMenuItem } from '@/shared/context-menu-system/types/menu.types';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useTerminalSceneStore } from '@/app/stores/terminalSceneStore';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { getTerminalService } from '@/tools/terminal/services/TerminalService';
import type { ShellInfo } from '@/tools/terminal/types/session';
import { useShellEntries } from './hooks';
import type { ShellEntry } from './hooks/shellEntryTypes';
import { useShellNavMenuState } from './hooks/useShellNavMenuState';
import { createOverlayPortal,
  Button,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  Tooltip,
} from '@openbitfun/ui';
import ShellNavEntryItem from './components/ShellNavEntryItem';
import ShellNavWorkspaceSwitcher from './components/ShellNavWorkspaceSwitcher';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import './ShellNav.scss';

function extractShortVersion(version?: string): string {
  if (!version) return '';
  const match = version.match(/\d+(?:\.\d+){1,2}/);
  return match ? match[0] : '';
}

function formatShellMenuLabel(shell: ShellInfo, isDefault: boolean, defaultBadgeLabel: string): string {
  const shortVersion = extractShortVersion(shell.version);
  const base = shortVersion ? `${shell.name} ${shortVersion}` : shell.name;
  return isDefault ? `${base} · ${defaultBadgeLabel}` : base;
}

const ShellNav: React.FC = () => {
  const { t } = useI18n('common');
  const { activeWorkspace, openedWorkspacesList, workspaceName, setActiveWorkspace } = useWorkspaceContext();
  const activeSceneId = useSceneStore((s) => s.activeTabId);
  const activeTerminalSessionId = useTerminalSceneStore((s) => s.activeSessionId);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([]);
  const [defaultShellType, setDefaultShellType] = useState<string>('');

  const {
    entries,
    editModalOpen,
    editingTerminal,
    closeEditModal,
    refresh: refreshEntries,
    createManualTerminal,
    openEntry,
    stopEntry,
    deleteEntry,
    openEditModal,
    saveEdit,
  } = useShellEntries();

  const hasMultipleWorkspaces = openedWorkspacesList.length > 1;
  const hasVisibleContent = entries.length > 0;
  const {
    menuOpen,
    setMenuOpen,
    workspaceMenuOpen,
    setWorkspaceMenuOpen,
    workspaceMenuPosition,
    menuRef,
    menuPopoverRef,
    workspaceMenuRef,
    workspaceTriggerRef,
  } = useShellNavMenuState(hasMultipleWorkspaces);
  const loadAvailableShells = useCallback(async () => {
    try {
      const [shells, terminalConfig] = await Promise.all([
        getTerminalService().getAvailableShells(),
        configManager.getConfig<TerminalConfig>('terminal'),
      ]);
      setAvailableShells(shells.filter((shell) => shell.available));
      setDefaultShellType(terminalConfig?.default_shell || '');
    } catch {
      setAvailableShells([]);
      setDefaultShellType('');
    }
  }, []);

  useEffect(() => {
    void loadAvailableShells();
  }, [loadAvailableShells]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      refreshEntries(),
      loadAvailableShells(),
    ]);
  }, [loadAvailableShells, refreshEntries]);

  const handleCreateManualTerminal = useCallback(async (shellType?: string) => {
    setMenuOpen(false);
    await createManualTerminal(shellType);
  }, [createManualTerminal, setMenuOpen]);

  const handleToggleCreateMenu = useCallback(() => {
    setWorkspaceMenuOpen(false);
    setMenuOpen((prev) => !prev);
  }, [setMenuOpen, setWorkspaceMenuOpen]);

  const shellMenuItems = useMemo(
    () =>
      availableShells.map((shell) => ({
        key: shell.shellType,
        label: formatShellMenuLabel(
          shell,
          shell.shellType === defaultShellType,
          t('nav.shell.badges.default'),
        ),
        shellType: shell.shellType,
      })),
    [availableShells, defaultShellType, t],
  );
  const createMenuLayout = useAnchoredPopoverPosition({
    open: menuOpen,
    anchorRef: menuRef,
    popoverRef: menuPopoverRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 6,
    layoutRevision: shellMenuItems.length,
  });

  const handleToggleWorkspaceMenu = useCallback(() => {
    if (!hasMultipleWorkspaces) {
      return;
    }

    setMenuOpen(false);
    setWorkspaceMenuOpen((prev) => !prev);
  }, [hasMultipleWorkspaces, setMenuOpen, setWorkspaceMenuOpen]);

  const handleSelectWorkspace = useCallback(async (workspaceId: string) => {
    setWorkspaceMenuOpen(false);
    if (workspaceId === activeWorkspace?.id) {
      return;
    }
    await setActiveWorkspace(workspaceId);
  }, [activeWorkspace?.id, setActiveWorkspace, setWorkspaceMenuOpen]);

  const openContextMenu = useCallback((
    event: React.MouseEvent<HTMLElement>,
    items: ContextMenuItem[],
    data: Record<string, unknown>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    showMenu(
      { x: event.clientX, y: event.clientY },
      items,
      {
        type: ContextType.CUSTOM,
        customType: 'shell-nav',
        data,
        event,
        targetElement: event.currentTarget,
        position: { x: event.clientX, y: event.clientY },
        timestamp: Date.now(),
      },
    );
  }, [showMenu]);

  const getEntryMenuItems = useCallback((entry: ShellEntry): ContextMenuItem[] => {
    if (entry.kind === 'manual-profile') {
      return [
        !entry.isRunning
          ? {
              id: `start-${entry.sessionId}`,
              label: t('nav.shell.context.start'),
              icon: <Play size={14} />,
              onClick: async () => {
                await openEntry(entry);
              },
            }
          : {
              id: `stop-${entry.sessionId}`,
              label: t('nav.shell.context.stop'),
              icon: <Square size={14} />,
              onClick: async () => {
                await stopEntry(entry);
              },
            },
        {
          id: `edit-${entry.sessionId}`,
          label: t('nav.shell.context.editConfig'),
          icon: <Icon name="edit" size="sm" />,
          onClick: () => {
            openEditModal(entry);
          },
        },
        {
          id: `delete-${entry.sessionId}`,
          label: t('nav.shell.context.deleteSavedTerminal'),
          icon: <Icon name="delete" size="sm" />,
          onClick: async () => {
            await deleteEntry(entry);
          },
        },
      ];
    }

    if (entry.kind === 'agent-session') {
      return [];
    }

    return [{
        id: `config-${entry.sessionId}`,
        label: t('nav.shell.context.saveConfig'),
        icon: <Icon name="edit" size="sm" />,
        onClick: () => {
          openEditModal(entry);
        },
      }];
  }, [deleteEntry, openEditModal, openEntry, stopEntry, t]);

  const getQuickAction = useCallback((entry: ShellEntry) => {
    if (entry.isRunning) {
      return {
        icon: <Icon name="delete" size="xs" />,
        title: t('nav.shell.context.close'),
        onClick: () => { void deleteEntry(entry); },
      };
    }

    if (entry.isPersisted) {
      return {
        icon: <Icon name="delete" size="xs" />,
        title: t('nav.shell.context.deleteSavedTerminal'),
        onClick: () => { void deleteEntry(entry); },
      };
    }

    return {
      icon: <Icon name="delete" size="xs" />,
      title: t('nav.shell.context.close'),
      onClick: () => { void deleteEntry(entry); },
    };
  }, [deleteEntry, t]);

  return (
    <NavigationPanel data-openbitfun-component="shell-nav" data-openbitfun-part="root" className="openbitfun-shell-nav" data-testid="shell-panel">
      <NavigationPanelHeader className="openbitfun-shell-nav__panel-header">
        <div data-openbitfun-component="shell-nav" data-openbitfun-part="header" className="openbitfun-shell-nav__header">
        <div className="openbitfun-shell-nav__title-group">
          <span data-openbitfun-component="shell-nav" data-openbitfun-part="title" className="openbitfun-shell-nav__title" data-testid="shell-panel-title">{t('nav.shell.title')}</span>
          <ShellNavWorkspaceSwitcher
            workspaceName={workspaceName}
            hasMultipleWorkspaces={hasMultipleWorkspaces}
            workspaceMenuOpen={workspaceMenuOpen}
            workspaceMenuPosition={workspaceMenuPosition}
            openedWorkspacesList={openedWorkspacesList}
            activeWorkspaceId={activeWorkspace?.id}
            workspaceMenuRef={workspaceMenuRef}
            workspaceTriggerRef={workspaceTriggerRef}
            switchWorkspaceLabel={t('header.switchWorkspace')}
            onToggle={handleToggleWorkspaceMenu}
            onSelectWorkspace={handleSelectWorkspace}
          />
        </div>
        <div data-openbitfun-component="shell-nav" data-openbitfun-part="headerActions" className="openbitfun-shell-nav__header-actions" ref={menuRef}>
          <div data-openbitfun-component="shell-nav" data-openbitfun-part="splitButton" data-openbitfun-state={menuOpen ? 'active' : undefined} className={`openbitfun-shell-nav__split-button${menuOpen ? ' is-active' : ''}`}>
            <Tooltip content={t('nav.shell.actions.newTerminal')} placement="bottom">
              <button
                type="button"
                className="openbitfun-shell-nav__split-button-main"
                onClick={() => { void handleCreateManualTerminal(); }}
              >
                <Icon name="plus" size="sm" />
              </button>
            </Tooltip>
            <Tooltip content={t('actions.more')} placement="bottom">
              <button
                type="button"
                className="openbitfun-shell-nav__split-button-toggle"
                onClick={handleToggleCreateMenu}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Icon name="chevron-down" size="xs" />
              </button>
            </Tooltip>
          </div>

          {menuOpen ? createOverlayPortal(
            <Menu
              ref={menuPopoverRef}
              data-openbitfun-component="shell-nav"
              data-openbitfun-part="menu"
              data-openbitfun-placement={createMenuLayout?.placement ?? 'bottom'}
              className="openbitfun-shell-nav__dropdown-menu"
              style={{
                top: `${createMenuLayout?.top ?? 0}px`,
                left: `${createMenuLayout?.left ?? 0}px`,
                visibility: createMenuLayout ? 'visible' : 'hidden',
              }}
            >
              {shellMenuItems.map((shell) => (
                <MenuItem
                  data-openbitfun-component="shell-nav"
                  data-openbitfun-part="menuItem"
                  key={shell.key}
                  type="button"
                  leading={<Icon name="plus" size="sm" />}
                  onClick={() => { void handleCreateManualTerminal(shell.shellType); }}
                >
                  <span>{shell.label}</span>
                </MenuItem>
              ))}
              {shellMenuItems.length > 0 ? <MenuSeparator /> : null}
              <MenuItem type="button" data-openbitfun-component="shell-nav" data-openbitfun-part="menuItem" leading={<Icon name="refresh" size="sm" />} onClick={() => { setMenuOpen(false); void handleRefresh(); }}>
                <span>{t('nav.shell.actions.refresh')}</span>
              </MenuItem>
            </Menu>,
            getAppearanceOverlayHost(),
          ) : null}
        </div>
        </div>
      </NavigationPanelHeader>
      <NavigationPanelBody className={`openbitfun-shell-nav__sections${!hasVisibleContent ? ' openbitfun-shell-nav__sections--empty' : ''}`}>
        <NavigationPanelContent className="openbitfun-shell-nav__panel-content">
        {hasVisibleContent ? (
          <div data-openbitfun-component="shell-nav" data-openbitfun-part="list" className="openbitfun-shell-nav__terminal-list" data-testid="shell-command-list">
            {entries.map((entry) => (
              <ShellNavEntryItem
                key={entry.sessionId}
                entry={entry}
                isActive={activeSceneId === 'shell' && activeTerminalSessionId === entry.sessionId}
                showSavedBadge={entry.isPersisted}
                startupCommandBadgeLabel={t('nav.shell.badges.startupCommand')}
                savedBadgeLabel={t('nav.shell.badges.saved')}
                quickAction={getQuickAction(entry)}
                getEntryMenuItems={getEntryMenuItems}
                onOpen={openEntry}
                onOpenContextMenu={openContextMenu}
              />
            ))}
          </div>
        ) : (
          <div data-openbitfun-component="shell-nav" data-openbitfun-part="empty" className="openbitfun-shell-nav__empty">
            <p className="openbitfun-shell-nav__empty-message">
              {t('nav.shell.empty.all')}
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => { void handleCreateManualTerminal(); }}
              leadingIcon={<Icon name="plus" size="sm" aria-hidden />}
            >

              {t('nav.shell.empty.quickNew')}
            </Button>
          </div>
        )}
        </NavigationPanelContent>
      </NavigationPanelBody>
      {editingTerminal ? (
        <TerminalEditModal
          isOpen={editModalOpen}
          onClose={closeEditModal}
          onSave={saveEdit}
          initialName={editingTerminal.entry.name}
          initialWorkingDirectory={editingTerminal.entry.workingDirectory ?? editingTerminal.entry.cwd ?? ''}
          initialStartupCommand={editingTerminal.entry.startupCommand}
          showWorkingDirectory
          showStartupCommand
        />
      ) : null}
    </NavigationPanel>
  );
};

export default ShellNav;
