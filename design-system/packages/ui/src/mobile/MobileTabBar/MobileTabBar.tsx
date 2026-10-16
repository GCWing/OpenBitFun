import { useState, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileTabBar.module.css";

export type MobileTabBarAppearance = "surface" | "plain";

export interface MobileTabBarItem {
  badge?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  value: string;
}

export interface MobileTabBarProps
  extends Omit<HTMLAttributes<HTMLElement>, "onChange"> {
  appearance?: MobileTabBarAppearance;
  defaultValue?: string;
  items: readonly MobileTabBarItem[];
  label: string;
  onValueChange?: (value: string) => void;
  safeArea?: boolean;
  value?: string;
}

/** Destinations, not tabs: the bar swaps the screen, so each item is a link-like button marked with
    aria-current rather than a tab in a tablist. */
export function MobileTabBar({
  appearance = "surface",
  className,
  defaultValue,
  items,
  label,
  onValueChange,
  safeArea = true,
  value,
  ...props
}: MobileTabBarProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : uncontrolled;

  function select(next: string) {
    if (!controlled) setUncontrolled(next);
    onValueChange?.(next);
  }

  return (
    <nav
      {...props}
      aria-label={label}
      className={classNames(styles.root, className)}
      data-appearance={appearance}
      data-openbitfun-component="mobile-tab-bar"
      data-safe-area={safeArea ? "true" : "false"}
    >
      {items.map(item => {
        const selected = item.value === current;
        return (
          <button
            aria-current={selected ? "page" : undefined}
            className={styles.item}
            data-openbitfun-part="item"
            data-selected={selected ? "true" : "false"}
            disabled={item.disabled}
            key={item.value}
            onClick={() => select(item.value)}
            type="button"
          >
            <span className={styles.icon} data-openbitfun-part="icon">
              {item.icon}
              {item.badge !== undefined && item.badge !== null && (
                <span className={styles.badge} data-openbitfun-part="badge">{item.badge}</span>
              )}
            </span>
            <span className={styles.label} data-openbitfun-part="label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
