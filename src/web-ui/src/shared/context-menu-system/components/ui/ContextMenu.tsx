import React from 'react';
import { Menu, MenuItem, MenuPopover, MenuSeparator, type MenuEntry, type MenuItemProps, type MenuProps, type MenuPopoverParts, type MenuSeparatorProps } from '@openbitfun/ui';
import { createLogger } from '@/shared/utils/logger';
import type { ContextMenuProps, ContextMenuItem } from './types';

const log = createLogger('ContextMenu');

// Keep persisted appearance part IDs while the public components retain DOM ownership.
const menuParts: MenuPopoverParts = {
  root: React.forwardRef<HTMLDivElement, MenuProps>((props, ref) => <Menu {...props} ref={ref} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="root" />),
  item: React.forwardRef<HTMLButtonElement, MenuItemProps>((props, ref) => <MenuItem {...props} ref={ref} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="item" data-openbitfun-state={[props.disabled && 'disabled', props['aria-expanded'] === true && 'submenu-active'].filter(Boolean).join(' ') || undefined} />),
  separator: React.forwardRef<HTMLDivElement, MenuSeparatorProps>((props, ref) => <MenuSeparator {...props} ref={ref} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="separator" />),
  icon: props => <span {...props} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="icon" />,
  label: props => <span {...props} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="label" />,
  shortcut: props => <span {...props} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="shortcut" />,
  submenuArrow: props => <span {...props} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="submenuArrow" />,
  submenu: props => <div {...props} data-openbitfun-product-component="context-menu" data-openbitfun-product-part="submenu" />,
};

/** Product adapter: portable menus own UI; callbacks retain their product context. */
export const ContextMenu: React.FC<ContextMenuProps> = ({ items, position, visible, context, onClose, onItemClick }) => {
  const ownerRef = React.useRef<HTMLElement | null>(null);
  ownerRef.current = context?.targetElement ?? context?.element ?? null;
  const convert = (item: ContextMenuItem): MenuEntry => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    separator: item.separator,
    icon: typeof item.icon === 'string' ? <i className={item.icon} /> : item.icon,
    shortcut: item.shortcut,
    submenu: item.submenu?.map(convert),
    onSelect: () => {
      void (async () => {
        try {
          await item.onClick?.(context);
        } catch (error) {
          log.error('onClick handler failed', { itemId: item.id, error });
        }
        onItemClick?.(item, context);
      })();
    },
  });

  return <MenuPopover items={items.map(convert)} position={position} ownerRef={ownerRef} open={visible} onClose={onClose} parts={menuParts} />;
};

export default ContextMenu;
