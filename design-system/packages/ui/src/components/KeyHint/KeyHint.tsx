import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import styles from "./KeyHint.module.css";

export interface KeyHintProps extends HTMLAttributes<HTMLElement> {
  icon?: ReactNode;
}

export const KeyHint = forwardRef<HTMLElement, KeyHintProps>(function KeyHint({
  children,
  className,
  icon,
  ...props
}, ref) {
  return (
    <kbd
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="key-hint"
      ref={ref}
    >
      {icon !== undefined && icon !== null && (
        <span aria-hidden="true" className={styles.icon} data-openbitfun-icon-slot="true" data-openbitfun-part="icon">
          {icon}
        </span>
      )}
      <span className={styles.label} data-openbitfun-part="label">{children}</span>
    </kbd>
  );
});
