import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./StatusPill.module.css";

export type StatusPillTone =
  | "neutral"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

export interface StatusPillProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children: ReactNode;
  leading?: ReactNode;
  tone?: StatusPillTone;
  /** Strong color for short labels such as chat modes; prose keeps the default. */
  emphasis?: boolean;
}

export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(
  function StatusPill({
    children,
    className,
    leading,
    tone = "success",
    emphasis = false,
    ...props
  }, ref) {
    return (
      <span
        {...props}
        className={classNames(styles.root, className)}
        data-openbitfun-component="status-pill"
        data-tone={tone}
        data-emphasis={emphasis ? "true" : "false"}
        ref={ref}
      >
        {leading !== undefined && leading !== null && (
          <span aria-hidden="true" className={styles.leading} data-openbitfun-icon-slot="true" data-openbitfun-part="leading">
            {leading}
          </span>
        )}
        <OverflowText className={styles.label} data-openbitfun-part="label">{children}</OverflowText>
      </span>
    );
  },
);
