import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import { FloatingAction } from "../../internal/FloatingAction";
import actionStyles from "../../internal/FloatingAction.module.css";
import styles from "./Capsule.module.css";

export interface CapsuleProps extends HTMLAttributes<HTMLSpanElement> {
  /** Join two independent controls into one capsule. */
  layout?: "inline" | "split";
  /** Fit both split controls and the capsule to their content, or use equal halves. */
  splitSizing?: "equal" | "content";
  /** One IconButton (optionally wrapped in Tooltip), rendered beside the content. */
  action?: ReactNode;
  /** Reserve a fixed action slot inside a Button child's trailing padding. */
  actionPlacement?: "overlay" | "reserved";
  /** Match the size of the child Button, Input, or label surface. */
  size?: "xs" | "sm" | "md" | "lg";
}

/** Composes content with a floating action, or joins two independent controls. */
export const Capsule = forwardRef<HTMLSpanElement, CapsuleProps>(function Capsule({
  action,
  actionPlacement = "overlay",
  children,
  className,
  layout = "inline",
  size = "sm",
  splitSizing = "equal",
  ...props
}, ref) {
  return (
    <span {...props} className={classNames(actionStyles.host, styles.root, className)}
      data-openbitfun-component="capsule" data-layout={layout} data-size={size} data-split-sizing={layout === "split" ? splitSizing : undefined}
      data-action-placement={action != null ? actionPlacement : undefined} data-overflow-trigger ref={ref}>
      {children}
      {action != null && <FloatingAction data-openbitfun-part="action"
        className={actionPlacement === "reserved" ? styles.reservedAction : undefined}>{action}</FloatingAction>}
    </span>
  );
});
