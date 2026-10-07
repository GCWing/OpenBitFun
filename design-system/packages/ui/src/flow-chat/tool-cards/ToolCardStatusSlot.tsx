import { isValidElement } from "react";
import { Icon, type IconSize } from "../../components/Icon/Icon";
import { classNames } from "../../internal/classNames";
import type { FlowChatToolStatus } from "./FlowChatToolCard";
import {
  ToolProcessingDots,
  type ToolProcessingDotsSize,
} from "./ToolProcessingDots";
import styles from "./ToolCardStatusSlot.module.css";
import { useToolCapsulePresentation } from './ToolCapsulePresentation';

export interface ToolCardStatusSlotProps {
  className?: string;
  defaultIcon?: "status" | "tool";
  size?: ToolProcessingDotsSize;
  status: FlowChatToolStatus;
  toolIcon?: React.ReactNode;
}

export function hasVisibleToolCardStatusGlyph(status: FlowChatToolStatus): boolean {
  return status !== "cancelled" && status !== "rejected";
}

function StatusGlyph({
  size,
  status,
}: {
  size: ToolProcessingDotsSize;
  status: FlowChatToolStatus;
}) {
  const iconSize: IconSize = size === 16 ? "md" : size === 14 ? "sm" : size === 12 ? "xs" : "2xs";

  switch (status) {
    case "completed":
    case "confirmed":
      return <Icon name="check-line" size={iconSize} className={styles.success} />;
    case "error":
      return <Icon name="xmark" size={iconSize} className={styles.danger} />;
    case "pending_confirmation":
      return <Icon name="clock" size={iconSize} />;
    case "queued":
    case "waiting":
      return <Icon name="clock" size={iconSize} className={styles.muted} />;
    default:
      return <ToolProcessingDots className={styles.processing} size={size} />;
  }
}

export function ToolCardStatusSlot({
  className,
  defaultIcon,
  size = 16,
  status,
  toolIcon,
}: ToolCardStatusSlotProps) {
  const capsule = useToolCapsulePresentation();
  const hasStatusGlyph = hasVisibleToolCardStatusGlyph(status);
  const hasToolIcon = isValidElement(toolIcon);

  // A capsule's glyph communicates its type; status lives beside its label.
  if (capsule && hasToolIcon) {
    return <span aria-hidden="true" className={classNames(styles.root, className)}
      data-openbitfun-component="flow-chat-tool-card" data-openbitfun-part="statusSlot" data-default-icon="tool">
      <span className={styles.iconLayer} data-openbitfun-icon-slot="true" data-openbitfun-component="flow-chat-tool-card" data-openbitfun-part="toolIconLayer">{toolIcon}</span>
    </span>;
  }

  if (!hasStatusGlyph && !hasToolIcon) {
    return null;
  }

  // Successful and approval-pending rows keep their operation identity; progress and failure
  // still lead with their status unless a card explicitly chooses otherwise.
  const resolvedDefaultIcon = hasStatusGlyph
    ? defaultIcon ?? (hasToolIcon && (status === "completed" || status === "confirmed" || status === "pending_confirmation") ? "tool" : "status")
    : "tool";

  return (
    <span
      className={classNames(styles.root, className)}
      data-openbitfun-component="flow-chat-tool-card"
      data-openbitfun-part="statusSlot"
      data-default-icon={resolvedDefaultIcon}
    >
      {hasStatusGlyph && (
        <span
          className={styles.statusLayer}
          data-openbitfun-icon-slot="true"
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="statusLayer"
        >
          <StatusGlyph size={size} status={status} />
        </span>
      )}
      {hasToolIcon && (
        <span
          aria-hidden="true"
          className={styles.iconLayer}
          data-openbitfun-icon-slot="true"
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="toolIconLayer"
        >
          {toolIcon}
        </span>
      )}
    </span>
  );
}
