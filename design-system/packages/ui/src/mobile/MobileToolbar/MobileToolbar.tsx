import { type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileToolbar.module.css";

export type MobileToolbarAppearance = "surface" | "plain";

export interface MobileToolbarProps extends HTMLAttributes<HTMLDivElement> {
  appearance?: MobileToolbarAppearance;
  children?: ReactNode;
  label?: string;
  leading?: ReactNode;
  safeArea?: boolean;
  sticky?: boolean;
  trailing?: ReactNode;
}

/** The action bar under a mobile screen. It separates from the content by fill and elevation rather
    than a rule, the same way the rest of the mobile surfaces do. */
export function MobileToolbar({
  appearance = "surface",
  children,
  className,
  label,
  leading,
  safeArea = true,
  sticky = false,
  trailing,
  ...props
}: MobileToolbarProps) {
  return (
    <div
      {...props}
      aria-label={label}
      className={classNames(styles.root, className)}
      data-appearance={appearance}
      data-openbitfun-component="mobile-toolbar"
      data-safe-area={safeArea ? "true" : "false"}
      data-sticky={sticky ? "true" : "false"}
      role={label ? "toolbar" : undefined}
    >
      {leading !== undefined && leading !== null && (
        <span className={styles.leading} data-openbitfun-part="leading">{leading}</span>
      )}
      {children !== undefined && children !== null && (
        <span className={styles.content} data-openbitfun-part="content">{children}</span>
      )}
      {trailing !== undefined && trailing !== null && (
        <span className={styles.trailing} data-openbitfun-part="trailing">{trailing}</span>
      )}
    </div>
  );
}
