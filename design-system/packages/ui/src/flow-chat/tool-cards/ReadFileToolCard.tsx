import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../components/Icon/Icon";
import { IconButton } from "../../components/IconButton/IconButton";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolCardStatusSlot } from "./ToolCardStatusSlot";

export interface ReadFileToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "content" | "onClick"> {
  accessibleLabel?: string;
  action?: ReactNode;
  content?: ReactNode;
  interactive?: boolean;
  onOpen?: () => void;
  status: FlowChatToolStatus;
  statusDescription?: string;
}

export function ReadFileToolCard({
  accessibleLabel,
  action,
  className,
  content,
  interactive = false,
  onOpen,
  status,
  statusDescription,
  ...props
}: ReadFileToolCardProps) {
  const { messages } = useDesignSystem();
  const canOpen = interactive && Boolean(onOpen);

  return (
    <AmbientToolCard
      {...props}
      aria-label={accessibleLabel}
      className={className}
      data-openbitfun-tool-card="read-file"
      header={(
        <AmbientToolCardHeader
          action={action}
          content={content}
          contentActions={canOpen ? (
            <IconButton
              aria-label={messages.toolCardOpenDetails}
              title={messages.toolCardOpenDetails}
              data-openbitfun-affordance="open-panel-right"
              data-openbitfun-part="affordanceButton"
              icon={<Icon name="arrow-up-right" size="sm" />}
              onClick={onOpen}
              size="sm"
              variant="quiet"
            />
          ) : undefined}
          statusDescription={statusDescription}
          icon={(
            <ToolCardStatusSlot
              status={status}
              toolIcon={<Icon name="file-text" size="sm" />}
            />
          )}
        />
      )}
      isExpanded={false}
      onClick={canOpen ? () => onOpen?.() : undefined}
      status={status}
    />
  );
}
