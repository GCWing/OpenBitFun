import type { HTMLAttributes } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./ShimmerText.module.css";

export interface ShimmerTextProps extends HTMLAttributes<HTMLSpanElement> {
  /** Animate while work is active; false keeps the same readable text. */
  active?: boolean;
}

/** A slow, softly feathered fade for short, host-provided activity labels. */
export function ShimmerText({ active = true, children, className, ...props }: ShimmerTextProps) {
  return (
    <span
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="shimmer-text"
      data-openbitfun-part="root"
      data-active={active ? "true" : "false"}
    >
      {children}
    </span>
  );
}
