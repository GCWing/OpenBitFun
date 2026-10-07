import { OverflowText } from '../../primitives/OverflowText';
import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../components/Icon/Icon";
import { classNames } from "../../internal/classNames";
import {
  ProminentToolCard,
  ProminentToolCardSummary,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolProcessingDots } from "./ToolProcessingDots";
import styles from "./ContextCompressionToolCard.module.css";

export interface ContextCompressionToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> {
  error?: ReactNode;
  isExpanded?: boolean;
  onToggle?: () => void;
  processingText?: ReactNode;
  status: FlowChatToolStatus;
  summary?: ReactNode;
  title: ReactNode;
}

const ACTIVE_STATUSES = new Set<FlowChatToolStatus>([
  "preparing",
  "receiving",
  "running",
  "streaming",
]);

export function ContextCompressionToolCard({
  className,
  error,
  isExpanded = false,
  onToggle,
  processingText,
  status,
  summary,
  title,
  ...props
}: ContextCompressionToolCardProps) {
  const loading = ACTIVE_STATUSES.has(status);
  const failed = status === "error";
  const content = summary ?? processingText;

  return (
    <div
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="context-compression-tool-card"
      data-openbitfun-part="root"
      data-openbitfun-status={status}
    >
      <ProminentToolCard
        collapsibleErrorContent
        isExpanded={isExpanded}
        onToggle={error ? onToggle : undefined}
        errorContent={error ? <div className={styles.error}>{error}</div> : undefined}
        summary={(
          <ProminentToolCardSummary
            action={title}
            content={content !== undefined && content !== null ? (
              <OverflowText
                className={summary !== undefined && summary !== null ? styles.summary : styles.processing}
                data-openbitfun-part={summary !== undefined && summary !== null ? "summary" : "processing"}
                title={typeof summary === "string" ? summary : undefined}
              >
                {content}
              </OverflowText>
            ) : undefined}
            icon={<Icon name="session" size="sm" />}
            statusIcon={loading ? <ToolProcessingDots size={16} /> : undefined}
          />
        )}
        isFailed={failed}
        status={status}
      />
    </div>
  );
}
