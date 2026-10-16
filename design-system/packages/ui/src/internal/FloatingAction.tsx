import { Children, cloneElement, isValidElement, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "./classNames";
import { FloatingActionContext } from "./floatingActionContext";
import glassStyles from "./GlassAction.module.css";
import styles from "./FloatingAction.module.css";

interface FloatingActionProps extends HTMLAttributes<HTMLSpanElement> {
  group?: boolean;
  size?: "xs" | "standard";
}

export function FloatingAction({ children, className, group = false, size = "xs", ...props }: FloatingActionProps) {
  return (
    <FloatingActionContext.Provider value={size}>
      <span {...props} className={classNames(styles.action, className)} data-floating-action-group={group || undefined}>
        {Children.map(children, (child: ReactNode) => (
          isValidElement<HTMLAttributes<HTMLButtonElement>>(child) && child.type === "button"
            ? cloneElement(child, { className: classNames(child.props.className, glassStyles.surface) })
            : child
        ))}
      </span>
    </FloatingActionContext.Provider>
  );
}
