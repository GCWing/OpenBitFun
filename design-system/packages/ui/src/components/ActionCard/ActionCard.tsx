import {
  forwardRef,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { IconButton, type IconButtonProps } from "../IconButton";
import { Tooltip } from "../Tooltip";
import { classNames } from "../../internal/classNames";
import { FloatingAction } from "../../internal/FloatingAction";
import actionStyles from "../../internal/FloatingAction.module.css";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./ActionCard.module.css";

export interface ActionCardAction
  extends Pick<IconButtonProps, "aria-controls" | "aria-expanded" | "aria-haspopup"> {
  disabled?: boolean;
  loading?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  tone?: IconButtonProps["tone"];
  tooltip?: ReactNode;
}

export type ActionCardSize = "sm" | "md";

export interface ActionCardProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> {
  actions?: readonly ActionCardAction[];
  /** Floating actions share tab-close glass styling without reducing the text width. */
  actionPlacement?: "inline" | "floating";
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
    actionPlacement = "inline",
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
    const actionButtons = actions.map((action) => {
      const button = (
        <IconButton
          aria-controls={action["aria-controls"]}
          aria-expanded={action["aria-expanded"]}
          aria-haspopup={action["aria-haspopup"]}
          aria-label={action.label}
          disabled={disabled || action.disabled}
          icon={action.icon}
          key={action.id}
          loading={action.loading}
          onClick={action.onClick}
          size="xs"
          tone={action.tone}
          variant="quiet"
        />
      );
      return action.tooltip != null
        ? <Tooltip key={action.id} content={action.tooltip}>{button}</Tooltip>
        : button;
    });
    return (
      <span
        className={classNames(styles.root, actionPlacement === "floating" && actionStyles.host, className)}
        data-openbitfun-component="action-card"
        data-action-placement={actionPlacement}
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
        {actions.length > 0 && (actionPlacement === "floating" ? (
          <FloatingAction group size="standard" className={styles.floatingActions} data-openbitfun-part="actions">
            {actionButtons}
          </FloatingAction>
        ) : (
          <span className={styles.actions} data-openbitfun-part="actions">
            {actionButtons}
          </span>
        ))}
      </span>
    );
  },
);
