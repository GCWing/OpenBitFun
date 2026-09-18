import {
  forwardRef,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { IconButton, type IconButtonProps } from "../IconButton";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./ActionItem.module.css";

export interface ActionItemAction {
  checked?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  role?: "button" | "menuitem" | "menuitemcheckbox" | "menuitemradio";
  testAttributes?: Record<`data-${string}`, string | number | boolean | undefined>;
  testId?: string;
  tone?: IconButtonProps["tone"];
}

export type ActionItemTone = "neutral" | "danger";

export interface ActionItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> {
  actions?: readonly ActionItemAction[];
  /** Independently interactive trailing content, outside the primary button. */
  actionContent?: ReactNode;
  triggerClassName?: string;
  children: ReactNode;
  className?: string;
  leading?: ReactNode;
  /** Static labels preserve wrapping without implicit overflow motion or tooltips. */
  labelBehavior?: "overflow" | "static";
  metadata?: ReactNode;
  reserveLeadingSpace?: boolean;
  shortcut?: ReactNode;
  tone?: ActionItemTone;
}

export const ActionItem = forwardRef<HTMLButtonElement, ActionItemProps>(function ActionItem({
  actions = [],
  actionContent,
  triggerClassName,
  children,
  className,
  disabled,
  leading,
  labelBehavior = "overflow",
  metadata,
  reserveLeadingSpace = false,
  shortcut,
  tone = "neutral",
  type = "button",
  ...props
}, ref) {
  const hasLeadingArea = reserveLeadingSpace || leading !== undefined && leading !== null;

  return (
    <span
      className={classNames(styles.root, className)}
      data-openbitfun-component="action-item"
      data-openbitfun-tone={tone}
      data-disabled={disabled ? "true" : "false"}
    >
      <button data-overflow-trigger
        {...props}
        className={classNames(styles.trigger, triggerClassName)}
        data-openbitfun-part="trigger"
        disabled={disabled}
        ref={ref}
        type={type}
      >
        {hasLeadingArea && (
          <span aria-hidden="true" className={styles.leading} data-openbitfun-icon-slot="true" data-openbitfun-part="leading">
            {leading}
          </span>
        )}
        {labelBehavior === "static" ? (
          <span className={classNames(styles.label, styles.staticLabel)} data-openbitfun-part="label">{children}</span>
        ) : (
          <OverflowText className={styles.label} data-openbitfun-part="label">{children}</OverflowText>
        )}
        {metadata !== undefined && metadata !== null && (
          <span className={styles.metadata} data-openbitfun-part="metadata">
            {metadata}
          </span>
        )}
        {shortcut !== undefined && shortcut !== null && (
          <span aria-hidden="true" className={styles.shortcut} data-openbitfun-part="shortcut">
            {shortcut}
          </span>
        )}
      </button>
      {(actions.length > 0 || actionContent != null) && (
        <span className={styles.actions} data-openbitfun-part="actions">
          {actionContent}
          {actions.map((action) => (
              <IconButton
                aria-label={action.label}
                aria-checked={action.role === "menuitemcheckbox" || action.role === "menuitemradio"
                  ? action.checked
                  : undefined}
                data-testid={action.testId}
                disabled={disabled || action.disabled}
                icon={action.icon}
                key={action.id}
                onClick={action.onClick}
                role={action.role}
                size="sm"
                tone={action.tone}
                variant="quiet"
                {...action.testAttributes}
              />
          ))}
        </span>
      )}
    </span>
  );
});
