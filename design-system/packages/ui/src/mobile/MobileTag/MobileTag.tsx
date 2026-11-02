import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileTag.module.css";

export type MobileTagAppearance = "soft" | "accent";
export type MobileTagSize = "sm" | "md";

export interface MobileTagProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  appearance?: MobileTagAppearance;
  children: ReactNode;
  leading?: ReactNode;
  selected?: boolean;
  size?: MobileTagSize;
  trailing?: ReactNode;
}

/** The mobile form of the web Capsule: a labelled pill that may carry a leading mark and a trailing
    slot. Selection is a fill, never a stroke — a bordered chip would make a filter row read as a
    row of inputs. */
export const MobileTag = forwardRef<HTMLButtonElement, MobileTagProps>(
  function MobileTag({
    appearance = "soft",
    children,
    className,
    leading,
    selected = false,
    size = "md",
    trailing,
    type = "button",
    ...props
  }, ref) {
    return (
      <button
        aria-pressed={selected}
        {...props}
        className={classNames(styles.root, className)}
        data-appearance={appearance}
        data-openbitfun-component="mobile-tag"
        data-selected={selected ? "true" : "false"}
        data-size={size}
        ref={ref}
        type={type}
      >
        {leading !== undefined && leading !== null && (
          <span aria-hidden="true" className={styles.leading} data-openbitfun-part="leading">{leading}</span>
        )}
        <span className={styles.label} data-openbitfun-part="label">{children}</span>
        {trailing !== undefined && trailing !== null && (
          <span className={styles.trailing} data-openbitfun-part="trailing">{trailing}</span>
        )}
      </button>
    );
  },
);
