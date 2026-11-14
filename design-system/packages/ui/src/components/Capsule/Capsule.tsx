import { Children, forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import { FloatingAction } from "../../internal/FloatingAction";
import actionStyles from "../../internal/FloatingAction.module.css";
import styles from "./Capsule.module.css";

export interface CapsuleProps extends HTMLAttributes<HTMLSpanElement> {
  /** Join two independent controls into one capsule. */
  layout?: "inline" | "split";
  /** Fit both split controls and the capsule to their content, or use equal halves. */
  splitSizing?: "equal" | "content";
  /** An IconButton or array of IconButtons (optionally wrapped in Tooltip). */
  action?: ReactNode;
  /** Reserve one fixed action slot; additional actions overlay the content. */
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
  const actionCount = Children.toArray(action).length;
  return (
    <span {...props} className={classNames(actionStyles.host, styles.root, className)}
      data-openbitfun-component="capsule" data-layout={layout} data-size={size} data-split-sizing={layout === "split" ? splitSizing : undefined}
      data-action-placement={actionCount > 0 ? actionPlacement : undefined} data-overflow-trigger ref={ref}>
      {children}
      {actionCount > 0 && <FloatingAction data-openbitfun-part="action" group={actionCount > 1}
        className={actionPlacement === "reserved" ? styles.reservedAction : undefined}>{action}</FloatingAction>}
    </span>
  );
});
