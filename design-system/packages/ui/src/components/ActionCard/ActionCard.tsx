import {
  forwardRef,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { IconButton, type IconButtonProps } from "../IconButton";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./ActionCard.module.css";

export interface ActionCardAction {
  disabled?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  tone?: IconButtonProps["tone"];
}

export type ActionCardSize = "sm" | "md";

export interface ActionCardProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> {
  actions?: readonly ActionCardAction[];
  children?: ReactNode;
  /** Rich card body (preview, multiline copy, selection marker) instead of title/description. */
  body?: ReactNode;
  triggerClassName?: string;
  className?: string;
  description?: ReactNode;
  leading?: ReactNode;
  selected?: boolean;
  size?: ActionCardSize;
}

export const ActionCard = forwardRef<HTMLButtonElement, ActionCardProps>(
  function ActionCard({
    actions = [],
    children,
    body,
    triggerClassName,
    className,
    description,
    disabled = false,
    leading,
    selected = false,
    size = "sm",
    type = "button",
    ...props
  }, ref) {
    return (
      <span
        className={classNames(styles.root, className)}
        data-openbitfun-component="action-card"
        data-disabled={disabled ? "true" : "false"}
        data-has-actions={actions.length > 0 ? "true" : "false"}
        data-selected={selected ? "true" : "false"}
        data-size={size}
      >
        <button data-overflow-trigger
          {...props}
          className={classNames(styles.trigger, triggerClassName)}
          data-openbitfun-part="trigger"
          disabled={disabled}
          ref={ref}
          type={type}
        >
          {leading !== undefined && leading !== null && (
            <span aria-hidden="true" className={styles.leading} data-openbitfun-icon-slot="true" data-openbitfun-part="leading">
              {leading}
            </span>
          )}
          {body !== undefined ? body : <span className={styles.content} data-openbitfun-part="content">
            <OverflowText className={styles.title} data-openbitfun-part="title">{children}</OverflowText>
            {description !== undefined && description !== null && (
              <OverflowText className={styles.description} data-openbitfun-part="description">
                {description}
              </OverflowText>
            )}
          </span>}
        </button>
        {actions.length > 0 && (
          <span className={styles.actions} data-openbitfun-part="actions">
            {actions.map((action) => (
              <IconButton
                aria-label={action.label}
                disabled={disabled || action.disabled}
                icon={action.icon}
                key={action.id}
                onClick={action.onClick}
                size="xs"
                tone={action.tone}
                variant="quiet"
              />
            ))}
          </span>
        )}
      </span>
    );
  },
);
