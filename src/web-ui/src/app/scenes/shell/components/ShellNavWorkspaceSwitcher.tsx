import React from 'react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { createOverlayPortal, OverflowText, Icon, Menu, MenuItem, Tooltip } from '@openbitfun/ui';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';

interface ShellNavWorkspaceSwitcherProps {
  workspaceName?: string;
  hasMultipleWorkspaces: boolean;
  workspaceMenuOpen: boolean;
  workspaceMenuPosition: { top: number; left: number } | null;
  openedWorkspacesList: WorkspaceInfo[];
  activeWorkspaceId?: string;
  workspaceMenuRef: React.RefObject<HTMLDivElement>;
  workspaceTriggerRef: React.RefObject<HTMLButtonElement>;
  switchWorkspaceLabel: string;
  onToggle: () => void;
  onSelectWorkspace: (workspaceId: string) => Promise<void>;
}

function getWorkspaceDisplayName(workspace: WorkspaceInfo): string {
  return workspace.workspaceKind === WorkspaceKind.Assistant
    ? workspace.identity?.name?.trim() || workspace.name
    : workspace.name;
}

const ShellNavWorkspaceSwitcher: React.FC<ShellNavWorkspaceSwitcherProps> = ({
  workspaceName,
  hasMultipleWorkspaces,
  workspaceMenuOpen,
  workspaceMenuPosition,
  openedWorkspacesList,
  activeWorkspaceId,
  workspaceMenuRef,
  workspaceTriggerRef,
  switchWorkspaceLabel,
  onToggle,
  onSelectWorkspace,
}) => {
  if (!workspaceName) {
    return null;
  }

  return (
    <div className="openbitfun-shell-nav__workspace-switcher">
      <Tooltip
        content={hasMultipleWorkspaces ? switchWorkspaceLabel : workspaceName}
        placement="bottom"
      >
        <button data-overflow-trigger
          ref={workspaceTriggerRef}
          type="button"
          className={`openbitfun-shell-nav__workspace-trigger${workspaceMenuOpen ? ' is-active' : ''}${hasMultipleWorkspaces ? ' is-switchable' : ''}`}
          onClick={onToggle}
          aria-haspopup={hasMultipleWorkspaces ? 'menu' : undefined}
          aria-expanded={hasMultipleWorkspaces ? workspaceMenuOpen : undefined}
        >
          <span className="openbitfun-shell-nav__workspace-separator">/</span>
          <OverflowText className="openbitfun-shell-nav__workspace-name">{workspaceName}</OverflowText>
          {hasMultipleWorkspaces ? (
            <Icon name="chevron-down" size="xs" className="openbitfun-shell-nav__workspace-trigger-icon" />
          ) : null}
        </button>
      </Tooltip>

      {workspaceMenuOpen && hasMultipleWorkspaces && workspaceMenuPosition
        ? createOverlayPortal(
            <Menu
              ref={workspaceMenuRef}
              className="openbitfun-shell-nav__workspace-menu"
              aria-label={switchWorkspaceLabel}
              style={{
                top: `${workspaceMenuPosition.top}px`,
                left: `${workspaceMenuPosition.left}px`,
              }}
            >
              {openedWorkspacesList.map((workspace) => {
                const isActive = workspace.id === activeWorkspaceId;
                const label = getWorkspaceDisplayName(workspace);

                return (
                  <Tooltip
                    key={workspace.id}
                    content={workspace.rootPath}
                    placement="right"
                    disabled={!workspace.rootPath}
                  >
                    <MenuItem data-overflow-trigger
                      role="menuitemradio"
                      checked={isActive}
                      reserveLeadingSpace
                      leading={isActive ? (
                        <span className="openbitfun-shell-nav__workspace-menu-check" aria-hidden="true">
                          <Icon name="check-line" size="xs" />
                        </span>
                      ) : undefined}
                      onClick={() => { void onSelectWorkspace(workspace.id); }}
                    >
                      <OverflowText className="openbitfun-shell-nav__workspace-menu-text">{label}</OverflowText>
                    </MenuItem>
                  </Tooltip>
                );
              })}
            </Menu>,
            getAppearanceOverlayHost(),
          )
        : null}
    </div>
  );
};

export default ShellNavWorkspaceSwitcher;
