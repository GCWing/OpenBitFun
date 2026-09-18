import { useEffect, useId, useRef, useState, type ComponentType, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { Menu, MenuItem, MenuSeparator, type MenuProps, type MenuItemRole } from "./Menu";
import { Icon } from "../Icon";
import { classNames } from "../../internal/classNames";
import { isImeOwnedKeyboardEvent } from "../../internal/ime";
import { useAnchoredLayer, type LayerPlacement } from "../../internal/useAnchoredLayer";
import { useSubmenuIntent } from "../../internal/useSubmenuIntent";
import { Portal } from "../../overlay/Portal";
import { useDismissibleLayer } from "../../overlay/useDismissibleLayer";
import { useFocusScope } from "../../overlay/useFocusScope";
import { usePresence } from "../../overlay/usePresence";
import styles from "./MenuPopover.module.css";

export interface MenuEntry {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: ReactNode;
  disabled?: boolean;
  separator?: boolean;
  submenu?: readonly MenuEntry[];
  role?: MenuItemRole;
  checked?: boolean;
  tone?: "neutral" | "danger";
  /** Dispatch only: the host owns async work and error presentation. */
  onSelect?: () => void;
}

export interface MenuPopoverProps extends Omit<MenuProps, "children"> {
  items: readonly MenuEntry[];
  open: boolean;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  position?: { x: number; y: number };
  placement?: LayerPlacement;
  /** Stable wrappers must forward all props (and refs for root/item/separator). */
  parts?: MenuPopoverParts;
}

export interface MenuPopoverParts {
  root?: typeof Menu;
  item?: typeof MenuItem;
  separator?: typeof MenuSeparator;
  icon?: ComponentType<HTMLAttributes<HTMLSpanElement>>;
  label?: ComponentType<HTMLAttributes<HTMLSpanElement>>;
  shortcut?: ComponentType<HTMLAttributes<HTMLSpanElement>>;
  submenuArrow?: ComponentType<HTMLAttributes<HTMLSpanElement>>;
  submenu?: ComponentType<HTMLAttributes<HTMLDivElement>>;
}

function ownItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-openbitfun-menu-item]"))
    .filter(item => item.closest('[role="menu"]') === menu && !item.disabled && item.getAttribute("aria-disabled") !== "true");
}

/** Anchored/coordinate menu with nested navigation, safe pointer corridors and focus return. */
export function MenuPopover({ items, open, onClose, anchorRef, position, placement = "bottom", autoFocusFirstItem = true, ...props }: MenuPopoverProps) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const { present, state: phase } = usePresence(open, 100);
  const resolvedAnchor = anchorRef ?? markerRef;
  const branchRefs = anchorRef ? [anchorRef] : [];
  const closeAndRestoreFocus = () => {
    if (anchorRef?.current?.isConnected) anchorRef.current.focus();
    onClose();
  };

  useDismissibleLayer({
    branchRefs,
    containsTarget: (target) => target instanceof Element
      && target.closest("[data-openbitfun-menu-tree]")?.getAttribute("data-openbitfun-menu-tree") === treeId,
    enabled: open,
    layerRef: menuRef,
    onDismiss: closeAndRestoreFocus,
  });
  useFocusScope({
    active: open && present,
    autoFocus: autoFocusFirstItem,
    containerRef: menuRef,
    restoreFocus: !anchorRef,
    trapFocus: false,
  });

  const content = present ? (
    <MenuLevel
      {...props}
      anchorRef={resolvedAnchor}
      autoFocusFirstItem={false}
      items={items}
      menuRef={menuRef}
      onClose={closeAndRestoreFocus}
      open={open}
      phase={phase}
      placement={placement}
      position={position}
      treeId={treeId}
    />
  ) : null;
  return (
    <>
      <span ref={markerRef} hidden />
      <Portal ownerDocument={markerRef.current?.ownerDocument}>{content}</Portal>
    </>
  );
}

interface MenuLevelProps extends Omit<MenuProps, "children"> {
  items: readonly MenuEntry[];
  open: boolean;
  phase: string;
  treeId: string;
  onClose: () => void;
  onBack?: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  position?: { x: number; y: number };
  placement: LayerPlacement;
  menuRef?: RefObject<HTMLDivElement | null>;
  parts?: MenuPopoverParts;
}

function MenuLevel({ items, open, phase, treeId, onClose, onBack, anchorRef, position, placement, menuRef: externalRef, autoFocusFirstItem, className, style, parts, ...props }: MenuLevelProps) {
  const MenuSurface = parts?.root ?? Menu;
  const Item = parts?.item ?? MenuItem;
  const Separator = parts?.separator ?? MenuSeparator;
  const Leading = parts?.icon ?? "span";
  const Label = parts?.label ?? "span";
  const Shortcut = parts?.shortcut ?? "span";
  const Arrow = parts?.submenuArrow ?? "span";
  const SubmenuBoundary = parts?.submenu ?? "div";
  const localRef = useRef<HTMLDivElement>(null);
  const menuRef = externalRef ?? localRef;
  const submenuRef = useRef<HTMLDivElement>(null);
  const submenuAnchor = useRef<HTMLElement | null>(null);
  const keyboardOpen = useRef(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const submenuId = useId();
  const intent = useSubmenuIntent({ activeId, onActiveIdChange: setActiveId, parentRef: menuRef, submenuRef, enabled: open, openDelayMs: 150, closeDelayMs: 300, switchDelayMs: 300, tolerance: 50 });
  // Keep geometry until presence unmounts the menu, including its exit transition.
  const layout = useAnchoredLayer({ open: true, anchorRef, layerRef: menuRef, placement, point: position });
  const activeEntry = items.find(item => item.id === activeId && !item.disabled && item.submenu?.length);
  const openSubmenu = (item: MenuEntry, trigger: HTMLElement, keyboard: boolean) => {
    if (item.disabled || !item.submenu?.length) return;
    submenuAnchor.current = trigger;
    keyboardOpen.current = keyboard;
    intent.openNow(item.id);
    if (keyboard && activeId === item.id && submenuRef.current) ownItems(submenuRef.current)[0]?.focus();
  };
  const activate = (item: MenuEntry) => {
    if (item.disabled || item.separator) return;
    onClose();
    item.onSelect?.();
  };

  useEffect(() => { if (!open) intent.closeNow(); }, [open, intent.closeNow]);
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const doc = menu?.ownerDocument;
    const keyboard = (event: KeyboardEvent) => {
      if (!menu || doc?.activeElement?.closest('[role="menu"]') !== menu || isImeOwnedKeyboardEvent(event)) return;
      const enabled = ownItems(menu);
      const current = enabled.indexOf(doc.activeElement as HTMLButtonElement);
      const button = enabled[current];
      const item = items.find(entry => entry.id === button?.getAttribute("data-menu-id"));
      let index: number | undefined;
      switch (event.key) {
        case "ArrowDown": index = (current + 1) % enabled.length; break;
        case "ArrowUp": index = (current - 1 + enabled.length) % enabled.length; break;
        case "Home": index = 0; break;
        case "End": index = enabled.length - 1; break;
        case "Tab": onClose(); return;
        case "ArrowLeft":
          if (onBack) { event.preventDefault(); event.stopPropagation(); onBack(); }
          return;
        case "ArrowRight":
          if (item?.submenu?.length && button) { event.preventDefault(); event.stopPropagation(); openSubmenu(item, button, true); }
          return;
        case "Enter":
        case " ":
          event.preventDefault(); event.stopPropagation();
          if (item && button) { if (item.submenu?.length) openSubmenu(item, button, true); else activate(item); }
          return;
        default:
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            for (let offset = 1; offset <= enabled.length; offset++) {
              const candidate = (current + offset) % enabled.length;
              if (enabled[candidate]?.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase())) { index = candidate; break; }
            }
          }
      }
      if (index !== undefined) { event.preventDefault(); event.stopPropagation(); enabled[index]?.focus(); enabled[index]?.scrollIntoView?.({ block: "nearest" }); }
    };
    doc?.addEventListener("keydown", keyboard, true);
    return () => doc?.removeEventListener("keydown", keyboard, true);
  });

  const submenu = activeEntry ? <SubmenuBoundary className={styles.submenuBoundary}><MenuLevel key={activeEntry.id} id={submenuId} aria-label={activeEntry.label} menuRef={submenuRef} items={activeEntry.submenu!} open={open} phase={phase} treeId={treeId} onClose={onClose} parts={parts}
    onBack={() => { intent.closeNow(); submenuAnchor.current?.focus(); }} anchorRef={submenuAnchor} placement="right" autoFocusFirstItem={keyboardOpen.current}
    onPointerEnter={intent.keepOpen} onPointerLeave={intent.requestClose} /></SubmenuBoundary> : null;

  return <>
    <MenuSurface {...props} ref={node => { (menuRef as { current: HTMLDivElement | null }).current = node; }} className={classNames(styles.popup, className)} autoFocusFirstItem={open && autoFocusFirstItem && Boolean(layout)} tabIndex={-1}
      style={{ ...layout?.style, ...style, visibility: layout ? undefined : "hidden" }} data-openbitfun-native-webview-occlusion data-openbitfun-menu-tree={treeId} data-placement={layout?.placement ?? placement} data-state={phase}
      aria-hidden={!open || undefined} {...(!open ? { inert: "" } : {})} onContextMenu={event => event.preventDefault()}>
      {items.map(item => item.separator ? <Separator key={item.id} /> : <Item key={item.id} data-menu-id={item.id} leading={item.icon ? <Leading className={styles.icon} data-openbitfun-icon-slot="true">{item.icon}</Leading> : undefined} shortcut={item.shortcut ? <Shortcut>{item.shortcut}</Shortcut> : undefined} tone={item.tone} role={item.role} checked={item.checked}
        disabled={item.disabled} aria-disabled={item.disabled || undefined} aria-haspopup={item.submenu?.length ? "menu" : undefined} aria-expanded={item.submenu?.length ? activeEntry?.id === item.id : undefined}
        aria-controls={activeEntry?.id === item.id ? submenuId : undefined} metadata={item.submenu?.length ? <Arrow className={styles.submenuArrow}><Icon name="chevron-right" size="sm" /></Arrow> : undefined}
        onClick={event => { event.stopPropagation(); if (item.submenu?.length) openSubmenu(item, event.currentTarget, true); else activate(item); }}
        onPointerEnter={event => { if (activeId === null || activeId === item.id) submenuAnchor.current = event.currentTarget; keyboardOpen.current = false; intent.requestChange(!item.disabled && item.submenu?.length ? item.id : null, event); }}
        onPointerLeave={intent.requestClose}
        ref={element => { if (activeEntry?.id === item.id && element) submenuAnchor.current = element; }}>
        <Label>{item.label}</Label>
      </Item>)}
    </MenuSurface>
    {submenu && <Portal ownerDocument={menuRef.current?.ownerDocument}>{submenu}</Portal>}
  </>;
}
