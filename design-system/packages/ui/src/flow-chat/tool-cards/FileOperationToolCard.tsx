import { OverflowText } from '../../primitives/OverflowText';
import type {
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  FileEdit,
  FilePenLine,
  FileX2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Icon } from "../../components/Icon/Icon";
import { IconButton } from "../../components/IconButton/IconButton";
import { classNames } from "../../internal/classNames";
import {
  ProminentToolCard,
  ProminentToolCardSummary,
  ToolCardChangeSummary,
  ToolCardActions,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolProcessingDots } from "./ToolProcessingDots";
import styles from "./FileOperationToolCard.module.css";

export type FileOperationKind = "delete" | "edit" | "write";

export interface FileOperationToolCardAction {
  label: string;
  onPress: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

export interface FileOperationToolCardError {
  guidance?: boolean;
  message: ReactNode;
  title?: ReactNode;
}

export interface FileOperationToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick"> {
  actionLabel: ReactNode;
  actionTestId?: string;
  changeSummary?: {
    additions: number | string;
    deletions: number | string;
    label: string;
  };
  error?: FileOperationToolCardError;
  inlineMessage?: ReactNode;
  isExpanded?: boolean;
  onOpenFile?: FileOperationToolCardAction;
  onToggle?: () => void;
  operation: FileOperationKind;
  path: string;
  pathLabel: ReactNode;
  pathTestId?: string;
  preview?: ReactNode;
  requiresConfirmation?: boolean;
  status: FlowChatToolStatus;
  statusDetail?: ReactNode;
}

const OPERATION_ICONS = {
  delete: FileX2,
  edit: FileEdit,
  write: FilePenLine,
} as const;

const ACTIVE_STATUSES = new Set<FlowChatToolStatus>([
  "preparing",
  "receiving",
  "running",
  "streaming",
]);

export function FileOperationToolCard({
  actionLabel,
  actionTestId,
  changeSummary,
  className,
  error,
  inlineMessage,
  isExpanded = false,
  onOpenFile,
  onToggle,
  operation,
  path,
  pathLabel,
  pathTestId,
  preview,
  requiresConfirmation = false,
  status,
  statusDetail,
  ...props
}: FileOperationToolCardProps) {
  const OperationIcon = OPERATION_ICONS[operation];
  const failed = status === "error";
  const loading = ACTIVE_STATUSES.has(status);
  const generating = loading && operation !== "delete";

  const errorContent = error ? (
    <div className={styles.error} data-guidance={error.guidance ? "true" : "false"}>
      {error.title != null && (
        <div className={styles.errorTitle} data-openbitfun-icon-slot="true">
          {error.guidance ? <Icon name="info" size="sm" /> : <Icon glyph={XCircle} size="sm" />}
          <span>{error.title}</span>
        </div>
      )}
      <div className={styles.errorMessage}>{error.message}</div>
    </div>
  ) : undefined;
  const hasPreview = Boolean(preview);
  const hasExpandedContent = failed ? Boolean(errorContent) : hasPreview;

  return (
    <div
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="file-operation-tool-card"
      data-openbitfun-operation={operation}
      data-openbitfun-part="root"
      data-openbitfun-status={status}
    >
      <ProminentToolCard
        collapsibleErrorContent
        errorContent={errorContent}
        expandedContent={hasPreview ? <div className={styles.preview}>{preview}</div> : undefined}
        expandedContentLayout="flush"
        summary={(
          <ProminentToolCardSummary
            action={actionLabel}
            actionTestId={actionTestId}
            actions={onOpenFile ? (
              <ToolCardActions>
                <IconButton
                  aria-label={onOpenFile.label}
                  data-openbitfun-affordance="open-panel-right"
                  data-openbitfun-part="openPanelButton"
                  icon={<Icon name="arrow-up-right" size="sm" data-openbitfun-icon="open-panel-right" />}
                  onClick={onOpenFile.onPress}
                  size="sm"
                  data-testid={onOpenFile.testId}
                  title={onOpenFile.label}
                  variant="quiet"
                />
              </ToolCardActions>
            ) : undefined}
            content={inlineMessage ? (
              <OverflowText className={styles.inlineMessage}>{inlineMessage}</OverflowText>
            ) : (
              <OverflowText
                behavior="marquee"
                className={styles.path}
                data-openbitfun-operation={operation}
                data-path={path}
                data-testid={pathTestId}
                title={path}
              >
                {pathLabel}
              </OverflowText>
            )}
            extra={statusDetail ? (
              <span className={styles.statusDetail}><OverflowText>{statusDetail}</OverflowText></span>
            ) : changeSummary ? (
              <ToolCardChangeSummary
                additions={changeSummary.additions}
                animated={generating}
                aria-label={changeSummary.label}
                deletions={changeSummary.deletions}
              />
            ) : undefined}
            icon={loading ? <ToolProcessingDots size={16} /> : <Icon glyph={OperationIcon} size="sm" />}
            textShimmer={generating && !inlineMessage}
            statusIcon={failed && !error?.guidance
              ? (
                <Icon
                  glyph={TriangleAlert}
                  size="sm"
                  className={styles.warningStatusIcon}
                  data-openbitfun-icon="warning"
                />
              )
              : undefined}
          />
        )}
        summaryExpandAffordance={hasExpandedContent}
        isExpanded={Boolean(isExpanded && hasExpandedContent)}
        isFailed={failed}
        onToggle={hasExpandedContent && onToggle ? () => onToggle() : undefined}
        requiresConfirmation={requiresConfirmation}
        status={status}
      />
    </div>
  );
}
