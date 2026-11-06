import { Button, type ButtonProps } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { OverflowText } from '../../primitives/OverflowText';
import {
  forwardRef,
  type HTMLAttributes,
  type LiHTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import styles from "./ChatComposerQueue.module.css";

export type ChatComposerQueueItemState =
  | "default"
  | "sending"
  | "failed";

export interface ChatComposerQueueProps
  extends HTMLAttributes<HTMLElement> {}

export interface ChatComposerQueueHeaderProps
  extends HTMLAttributes<HTMLDivElement> {}

export interface ChatComposerQueueTitleProps
  extends HTMLAttributes<HTMLSpanElement> {
  count?: ReactNode;
}

export interface ChatComposerQueueToggleProps
  extends Omit<ButtonProps, "aria-expanded" | "labelBehavior" | "leadingIcon" | "size" | "trailingIcon" | "variant"> {
  expanded: boolean;
}

export interface ChatComposerQueueListProps
  extends HTMLAttributes<HTMLUListElement> {}

export interface ChatComposerQueueItemProps
  extends LiHTMLAttributes<HTMLLIElement> {
  state?: ChatComposerQueueItemState;
  leadingIcon?: ReactNode;
  /** Interactive leading slot; unlike leadingIcon it remains accessible. */
  leadingControl?: ReactNode;
}

export interface ChatComposerQueueItemContentProps
  extends HTMLAttributes<HTMLDivElement> {}

export interface ChatComposerQueueItemMessageProps
  extends HTMLAttributes<HTMLDivElement> {}

export type ChatComposerQueueItemStatusTone = "neutral" | "warning" | "danger";

export interface ChatComposerQueueItemStatusProps
  extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChatComposerQueueItemStatusTone;
}

export interface ChatComposerQueueAttachmentBadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  count: number;
  /** Supply a real icon from the consumer's icon library. */
  icon?: ReactNode;
  label: string;
}

export interface ChatComposerQueueItemActionsProps
  extends HTMLAttributes<HTMLDivElement> {}

/** Neutral queue surface rendered inside a ChatComposer body. */
export const ChatComposerQueue = forwardRef<HTMLElement, ChatComposerQueueProps>(
  function ChatComposerQueue({ className, ...props }, ref) {
    return (
      <section
        {...props}
        className={classNames(styles.root, className)}
        data-openbitfun-component="chat-composer-queue"
        data-openbitfun-part="root"
        ref={ref}
      />
    );
  },
);

/** Queue heading row. Supply a real icon from the consumer's icon library. */
export const ChatComposerQueueHeader = forwardRef<
  HTMLDivElement,
  ChatComposerQueueHeaderProps
>(function ChatComposerQueueHeader({ className, ...props }, ref) {
  return (
    <div
      {...props}
      className={classNames(styles.header, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="header"
      ref={ref}
    />
  );
});

/** Queue label and its separate total-count fact. */
export const ChatComposerQueueTitle = forwardRef<
  HTMLSpanElement,
  ChatComposerQueueTitleProps
>(function ChatComposerQueueTitle({ children, className, count, ...props }, ref) {
  return (
    <span
      {...props}
      className={classNames(styles.title, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="title"
      ref={ref}
    >
      <OverflowText className={styles.titleLabel}>{children}</OverflowText>
      {count !== undefined && count !== null && (
        <span
          className={styles.totalCount}
          data-openbitfun-component="chat-composer-queue"
          data-openbitfun-part="totalCount"
        >
          {count}
        </span>
      )}
    </span>
  );
});

/** Disclosure for the message list; wrap a ChatComposerQueueTitle as its label. */
export const ChatComposerQueueToggle = forwardRef<
  HTMLButtonElement,
  ChatComposerQueueToggleProps
>(function ChatComposerQueueToggle({ className, expanded, ...props }, ref) {
  return (
    <Button
      {...props}
      aria-expanded={expanded}
      className={classNames(styles.toggle, className)}
      labelBehavior="static"
      ref={ref}
      size="xs"
      trailingIcon={<Icon name={expanded ? "chevron-down" : "chevron-up"} size="xs" />}
      variant="text"
    />
  );
});

export const ChatComposerQueueList = forwardRef<
  HTMLUListElement,
  ChatComposerQueueListProps
>(function ChatComposerQueueList({ className, ...props }, ref) {
  return (
    <ul
      {...props}
      className={classNames(styles.list, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="list"
      ref={ref}
    />
  );
});

export const ChatComposerQueueItem = forwardRef<
  HTMLLIElement,
  ChatComposerQueueItemProps
>(function ChatComposerQueueItem({ children, className, leadingIcon, leadingControl, state = "default", ...props }, ref) {
  return (
    <li
      {...props}
      className={classNames(styles.item, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="item"
      data-openbitfun-state={state === "default" ? undefined : state}
      ref={ref}
    >
      {leadingControl && <span className={styles.leadingIcon} data-openbitfun-part="leading-control">{leadingControl}</span>}
      {!leadingControl && leadingIcon && <span className={styles.leadingIcon} data-openbitfun-part="leading-icon" aria-hidden="true">{leadingIcon}</span>}
      {children}
    </li>
  );
});

export const ChatComposerQueueItemContent = forwardRef<
  HTMLDivElement,
  ChatComposerQueueItemContentProps
>(function ChatComposerQueueItemContent({ className, ...props }, ref) {
  return (
    <div
      {...props}
      className={classNames(styles.content, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="content"
      ref={ref}
    />
  );
});

/** Natural-width preview and its attachments; status belongs below this line. */
export const ChatComposerQueueItemMessage = forwardRef<
  HTMLDivElement,
  ChatComposerQueueItemMessageProps
>(function ChatComposerQueueItemMessage({ className, ...props }, ref) {
  return (
    <div
      {...props}
      className={classNames(styles.message, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="message"
      ref={ref}
    />
  );
});

/** A fact about one message, such as its delivery state or a failure reason. */
export const ChatComposerQueueItemStatus = forwardRef<
  HTMLSpanElement,
  ChatComposerQueueItemStatusProps
>(function ChatComposerQueueItemStatus({ className, tone = "neutral", ...props }, ref) {
  return (
    <span
      {...props}
      className={classNames(styles.status, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="status"
      data-openbitfun-tone={tone}
      ref={ref}
    />
  );
});

/** Per-message attachment count; this is intentionally distinct from queue position. */
export const ChatComposerQueueAttachmentBadge = forwardRef<
  HTMLSpanElement,
  ChatComposerQueueAttachmentBadgeProps
>(function ChatComposerQueueAttachmentBadge({ className, count, icon, label, ...props }, ref) {
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  return (
    <span
      {...props}
      aria-label={label}
      role="img"
      className={classNames(styles.attachmentBadge, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="attachmentCount"
      ref={ref}
      title={label}
    >
      {icon}
      {Math.trunc(count)}
    </span>
  );
});

export const ChatComposerQueueItemActions = forwardRef<
  HTMLDivElement,
  ChatComposerQueueItemActionsProps
>(function ChatComposerQueueItemActions({ className, ...props }, ref) {
  return (
    <div
      {...props}
      className={classNames(styles.actions, className)}
      data-openbitfun-component="chat-composer-queue"
      data-openbitfun-part="actions"
      ref={ref}
    />
  );
});
