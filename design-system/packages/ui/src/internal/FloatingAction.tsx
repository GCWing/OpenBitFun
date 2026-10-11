import { Children, cloneElement, isValidElement, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "./classNames";
import { FloatingActionContext } from "./floatingActionContext";
import glassStyles from "./GlassAction.module.css";
import styles from "./FloatingAction.module.css";

export function FloatingAction({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <FloatingActionContext.Provider value>
      <span {...props} className={classNames(styles.action, className)}>
        {Children.map(children, (child: ReactNode) => (
          isValidElement<HTMLAttributes<HTMLButtonElement>>(child) && child.type === "button"
            ? cloneElement(child, { className: classNames(child.props.className, glassStyles.surface) })
            : child
        ))}
      </span>
    </FloatingActionContext.Provider>
  );
}
