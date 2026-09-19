import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  type FocusEventHandler,
  type ForwardedRef,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { ActionItem, type ActionItemProps } from "../ActionItem";
import { IconButton, type IconButtonProps } from "../IconButton";
import { ScrollArea, type ScrollbarVisibility } from "../ScrollArea";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import { isImeOwnedKeyboardEvent } from "../../internal/ime";
import styles from "./Menu.module.css";

export type MenuItemRole = "menuitem" | "menuitemcheckbox" | "menuitemradio";

export interface MenuProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "autoFocus" | "role"> {
  autoFocusFirstItem?: boolean;
  children: ReactNode;
  scrollbarVisibility?: ScrollbarVisibility;
}

export interface MenuItemProps
  extends Omit<ActionItemProps, "aria-checked" | "role"> {
  checked?: boolean;
  role?: MenuItemRole;
}

/** A row stack for custom scroll or animation wrappers inside a Menu. */
export interface MenuListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  "data-openbitfun-part"?: string;
}

export interface MenuSectionAction {
  disabled?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  tone?: IconButtonProps["tone"];
}

export interface MenuSectionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  actions?: readonly MenuSectionAction[];
  children: ReactNode;
  title?: ReactNode;
}

export type MenuSeparatorProps = HTMLAttributes<HTMLDivElement>;

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    (ref as { current: T | null }).current = value;
  }
}

function getEnabledItems(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-openbitfun-menu-item]"),
  ).filter((item) => item.closest('[role="menu"]') === root && !item.disabled && item.getAttribute("aria-disabled") !== "true");
}

function setActiveItem(items: readonly HTMLButtonElement[], index: number, focus = true) {
  const target = items[index];
  if (!target) return;

  items.forEach((item, itemIndex) => {
    item.tabIndex = itemIndex === index ? 0 : -1;
  });
  if (focus) {
    target.focus();
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
}

export const MenuList = forwardRef<HTMLDivElement, MenuListProps>(function MenuList({
  className,
  "data-openbitfun-part": part = "items",
  ...props
}, ref) {
  return (
    <div
      {...props}
      className={classNames(styles.items, className)}
      data-openbitfun-menu-list=""
      data-openbitfun-part={part}
      ref={ref}
    />
  );
});

export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu({
  autoFocusFirstItem = false,
  children,
  className,
  onFocusCapture,
  onKeyDown,
  scrollbarVisibility = "auto",
  ...props
}, forwardedRef) {
  const rootRef = useRef({ node: null as HTMLDivElement | null });
  const hasAutoFocusedRef = useRef(false);
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current.node = node;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  useEffect(() => {
    const root = rootRef.current.node;
    if (!root) return;
    if (!autoFocusFirstItem) hasAutoFocusedRef.current = false;

    const items = getEnabledItems(root);
    if (items.length === 0) {
      if (autoFocusFirstItem && !hasAutoFocusedRef.current) {
        hasAutoFocusedRef.current = true;
        root.focus();
      }
      return;
    }

    const activeIndex = Math.max(items.findIndex((item) => item.tabIndex === 0), 0);
    setActiveItem(items, activeIndex, false);
    if (autoFocusFirstItem && !hasAutoFocusedRef.current) {
      hasAutoFocusedRef.current = true;
      setActiveItem(items, activeIndex);
    }
  }, [autoFocusFirstItem, children]);

  const handleFocusCapture: FocusEventHandler<HTMLDivElement> = (event) => {
    onFocusCapture?.(event);
    if (event.defaultPrevented) return;

    const target = (event.target as Element).closest
      ? (event.target as Element).closest<HTMLButtonElement>("[data-openbitfun-menu-item]")
      : null;
    if (!target || !event.currentTarget.contains(target)) return;

    const items = getEnabledItems(event.currentTarget);
    const index = items.indexOf(target);
    if (index >= 0) setActiveItem(items, index, false);
  };

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || isImeOwnedKeyboardEvent(event)) return;

    const target = (event.target as Element).closest
      ? (event.target as Element).closest<HTMLButtonElement>("[data-openbitfun-menu-item]")
      : null;
    if (!target || !event.currentTarget.contains(target)) return;

    const items = getEnabledItems(event.currentTarget);
    const currentIndex = items.indexOf(target);
    if (currentIndex < 0 || items.length === 0) return;

    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % items.length;
        break;
      case "ArrowUp":
        nextIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = items.length - 1;
        break;
      default:
        if (
          event.key.length === 1
          && !event.altKey
          && !event.ctrlKey
          && !event.metaKey
        ) {
          const query = event.key.toLocaleLowerCase();
          for (let offset = 1; offset <= items.length; offset += 1) {
            const candidateIndex = (currentIndex + offset) % items.length;
            const label = items[candidateIndex]?.textContent?.trim().toLocaleLowerCase() ?? "";
            if (label.startsWith(query)) {
              nextIndex = candidateIndex;
              break;
            }
          }
        }
    }

    if (nextIndex !== undefined) {
      event.preventDefault();
      setActiveItem(items, nextIndex);
    }
  };

  return (
    <div
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="menu"
      onFocusCapture={handleFocusCapture}
      onKeyDown={handleKeyDown}
      ref={setRootRef}
      role="menu"
    >
      <ScrollArea
        className={styles.viewport}
        orientation="vertical"
        scrollbarVisibility={scrollbarVisibility}
      >
        <MenuList className={styles.list} data-openbitfun-part="list">{children}</MenuList>
      </ScrollArea>
    </div>
  );
});

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem({
  checked = false,
  className,
  role = "menuitem",
  tabIndex = -1,
  ...props
}, ref) {
  return (
    <ActionItem
      {...props}
      aria-checked={role === "menuitem" ? undefined : checked}
      className={classNames(styles.item, className)}
      data-openbitfun-menu-item=""
      ref={ref}
      role={role}
      tabIndex={tabIndex}
    />
  );
});

export const MenuSection = forwardRef<HTMLDivElement, MenuSectionProps>(function MenuSection({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  actions = [],
  children,
  className,
  title,
  ...props
}, ref) {
  const generatedHeadingId = useId();
  const headingId = title !== undefined && title !== null ? generatedHeadingId : undefined;
  const resolvedLabelledBy = ariaLabel || ariaLabelledBy ? ariaLabelledBy : headingId;

  return (
    <div
      {...props}
      aria-label={ariaLabel}
      aria-labelledby={resolvedLabelledBy}
      className={classNames(styles.section, className)}
      data-openbitfun-part="section"
      ref={ref}
      role="group"
    >
      {headingId && (
        <div className={styles.heading} data-openbitfun-part="heading" id={headingId}>
          <OverflowText className={styles.headingLabel} data-openbitfun-part="heading-label">{title}</OverflowText>
          {actions.length > 0 && (
            <span className={styles.headingActions} data-openbitfun-part="heading-actions">
              {actions.map((action) => (
                <IconButton
                  aria-label={action.label}
                  className={styles.headingAction}
                  data-openbitfun-menu-item=""
                  disabled={action.disabled}
                  icon={action.icon}
                  key={action.id}
                  onClick={action.onClick}
                  size="sm"
                  role="menuitem"
                  tabIndex={-1}
                  tone={action.tone}
                  variant="quiet"
                />
              ))}
            </span>
          )}
        </div>
      )}
      <MenuList data-openbitfun-part="section-items">
        {children}
      </MenuList>
    </div>
  );
});

export const MenuSeparator = forwardRef<HTMLDivElement, MenuSeparatorProps>(
  function MenuSeparator({ className, ...props }, ref) {
    return (
      <div
        {...props}
        className={classNames(styles.separator, className)}
        data-openbitfun-part="separator"
        ref={ref}
        role="separator"
      />
    );
  },
);
