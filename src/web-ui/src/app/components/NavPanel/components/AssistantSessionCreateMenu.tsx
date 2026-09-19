import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeOverlayInteraction, createOverlayPortal, OverflowText, Icon, Menu, MenuItem, Tooltip } from '@openbitfun/ui';

import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { WorkspaceInfo } from '@/shared/types';
import { useAnchoredPopoverPosition } from '@/shared/utils/useAnchoredPopoverPosition';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';

interface AssistantSessionCreateMenuProps {
  assistants: WorkspaceInfo[];
  primaryAssistant: WorkspaceInfo | null;
  onCreatePrimary: () => void | Promise<void>;
  onCreateAssistant: (workspace: WorkspaceInfo) => void | Promise<void>;
}

const getAssistantDisplayName = (workspace: WorkspaceInfo): string =>
  workspace.identity?.name?.trim() || workspace.name;

const AssistantSessionCreateMenu: React.FC<AssistantSessionCreateMenuProps> = ({
  assistants,
  primaryAssistant,
  onCreatePrimary,
  onCreateAssistant,
}) => {
  const { t } = useI18n('common');
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const orderedAssistants = useMemo(() => {
    if (!primaryAssistant) return assistants;
    return [
      primaryAssistant,
      ...assistants.filter(workspace => workspace.id !== primaryAssistant.id),
    ];
  }, [assistants, primaryAssistant]);

  const menuLayout = useAnchoredPopoverPosition({
    open: menuOpen,
    anchorRef,
    popoverRef: menuRef,
    preferredPlacement: 'bottom',
    alignment: 'end',
    gap: 6,
    layoutRevision: orderedAssistants.length,
  });

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    let removeOverlayKeydown1: (() => void) | undefined;
    if (!menuOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (anchorRef.current?.contains(target) || menuRef.current?.contains(target))
      ) {
        return;
      }
      closeMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeOwnedKeyboardEvent(event)) closeMenu();
    };

    removeOverlayMousedown0 = subscribeOverlayInteraction(menuRef, 'mousedown', handleMouseDown);
    removeOverlayKeydown1 = subscribeOverlayInteraction(menuRef, 'keydown', handleEscape);
    return () => {
      removeOverlayMousedown0?.();
      removeOverlayKeydown1?.();
    };
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (orderedAssistants.length === 0) closeMenu();
  }, [closeMenu, orderedAssistants.length]);

  const createPrimaryLabel = t('nav.sessions.newPrimaryAssistantSession');
  const chooseAssistantLabel = t('nav.sessions.chooseAssistant');

  return (
    <div
      ref={anchorRef}
      className={`openbitfun-nav-panel__assistant-session-actions${menuOpen ? ' is-open' : ''}`}
      data-openbitfun-component="nav-panel"
      data-openbitfun-part="assistantSessionActions"
      data-openbitfun-state={menuOpen ? 'open' : undefined}
    >
      <div className={`openbitfun-nav-panel__assistant-session-split-button${menuOpen ? ' is-active' : ''}`}>
        <Tooltip content={createPrimaryLabel} placement="right" followCursor>
          <button
            type="button"
            className="openbitfun-nav-panel__assistant-session-split-main"
            aria-label={createPrimaryLabel}
            onClick={() => {
              closeMenu();
              void onCreatePrimary();
            }}
            data-testid="nav-primary-assistant-session-add-btn"
          >
            <Icon name="plus" size="xs" />
          </button>
        </Tooltip>
        <Tooltip content={chooseAssistantLabel} placement="right" followCursor disabled={menuOpen}>
          <button
            type="button"
            className="openbitfun-nav-panel__assistant-session-split-toggle"
            aria-label={chooseAssistantLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={orderedAssistants.length === 0}
            onClick={() => setMenuOpen(open => !open)}
            data-testid="nav-assistant-session-menu-toggle"
          >
            <Icon name="chevron-down" size="2xs" />
          </button>
        </Tooltip>
      </div>

      {menuOpen ? createOverlayPortal(
        <Menu
          ref={menuRef}
          className="openbitfun-nav-panel__assistant-session-menu"
          aria-label={chooseAssistantLabel}
          data-testid="nav-assistant-session-menu"
          style={{
            top: `${menuLayout?.top ?? 0}px`,
            left: `${menuLayout?.left ?? 0}px`,
            visibility: menuLayout ? 'visible' : 'hidden',
          }}
        >
          {orderedAssistants.map(workspace => {
            const assistantName = getAssistantDisplayName(workspace);
            return (
              <MenuItem data-overflow-trigger
                key={workspace.id}
                leading={<Icon name="plus" size="xs" aria-hidden="true" />}
                aria-label={t('nav.sessions.newAssistantSessionFor', { assistantName })}
                onClick={() => {
                  closeMenu();
                  void onCreateAssistant(workspace);
                }}
                data-testid={`nav-assistant-session-menu-item-${workspace.id}`}
              >
                <OverflowText className="openbitfun-nav-panel__assistant-session-menu-name">{assistantName}</OverflowText>
              </MenuItem>
            );
          })}
        </Menu>,
        getAppearanceOverlayHost(),
      ) : null}
    </div>
  );
};

export default React.memo(AssistantSessionCreateMenu);
