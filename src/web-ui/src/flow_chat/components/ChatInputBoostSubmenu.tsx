import React, { useCallback, useId, useRef } from 'react';

import { createOverlayPortal, Menu, MenuItem, Icon } from '@openbitfun/ui';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useSideAnchoredPopoverPosition } from '@/shared/utils/useSideAnchoredPopoverPosition';

interface ChatInputBoostSubmenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}

/** Shared second-level disclosure used by ChatInput's add menu. */
export const ChatInputBoostSubmenu: React.FC<ChatInputBoostSubmenuProps> = ({
  open,
  onOpenChange: setOpen,
  label,
  icon,
  children,
  testId,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const layout = useSideAnchoredPopoverPosition({
    open,
    anchorRef: triggerRef,
    popoverRef: submenuRef,
    layoutRevision: React.Children.count(children),
  });

  const openFlyout = useCallback((focusFirstItem = false) => {
    setOpen(true);
    if (focusFirstItem) {
      requestAnimationFrame(() => {
        submenuRef.current?.querySelector<HTMLButtonElement>('[data-openbitfun-menu-item]')?.focus();
      });
    }
  }, [setOpen]);

  return (
    <div
      className="openbitfun-chat-input__boost-submenu-host"
      data-testid={testId}
    >
      <MenuItem
        ref={triggerRef}
        data-openbitfun-component="chat-input"
        data-openbitfun-part="boostSubmenuTrigger"
        data-openbitfun-state={open ? 'open' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        leading={icon}
        metadata={<Icon name="chevron-right" size="sm" aria-hidden />}
        onClick={(event) => {
          event.stopPropagation();
          if (open) setOpen(false);
          else openFlyout();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'ArrowLeft') {
            if (!open) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          openFlyout(true);
        }}
      >
        {label}
      </MenuItem>
      {open ? createOverlayPortal(
        <Menu
          ref={submenuRef}
          id={panelId}
          className="openbitfun-chat-input__boost-submenu-panel"
          data-openbitfun-component="chat-input"
          data-openbitfun-part="boostSubmenuPanel"
          data-openbitfun-state="open"
          data-openbitfun-placement={layout ? `${layout.placement}-${layout.alignment}` : 'right-start'}
          style={{
            top: layout?.top ?? 0,
            left: layout?.left ?? 0,
            visibility: layout ? 'visible' : 'hidden',
          }}
          onMouseDown={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
          >
            {children}
        </Menu>,
        getAppearanceOverlayHost(),
      ) : null}
    </div>
  );
};

export default ChatInputBoostSubmenu;
