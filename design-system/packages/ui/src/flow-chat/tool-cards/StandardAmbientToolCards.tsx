import { OverflowText } from '../../primitives/OverflowText';
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton';
import { classNames } from '../../internal/classNames';
import { isValidElement } from "react";
import type {
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from "../../components/Dialog";
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  ProminentToolCard,
  ProminentToolCardSummary,
  ToolCardActions,
  ToolCardIconSlot,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import {
  ToolCardStatusSlot,
} from "./ToolCardStatusSlot";
import { ToolCardDisclosure, ToolCardSection as Section, ToolCardText } from "./ToolCardDetails";
import { ScrollArea } from "../../components/ScrollArea";
import styles from "./StandardAmbientToolCards.module.css";

interface AmbientCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "content" | "onClick" | "title"> {
  isExpanded?: boolean;
  onToggle?: () => void;
  status: FlowChatToolStatus;
  statusDescription?: string;
  resultSummary?: ReactNode;
}



export interface RunCodeToolCardProps extends AmbientCardProps {
  action: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  output?: ReactNode;
  outputLabel?: ReactNode;
  program?: ReactNode;
  programLabel?: ReactNode;
  summary: ReactNode;
}

export function RunCodeToolCard({
  action,
  actions,
  error,
  isExpanded = false,
  onToggle,
  output,
  outputLabel,
  program,
  programLabel,
  status,
  statusDescription,
  resultSummary,
  summary,
  ...props
}: RunCodeToolCardProps) {
  const hasDetails = Boolean(program || output || error);
  return (
    <AmbientToolCard
      {...props}
      data-openbitfun-tool-card="run-code"
      expandedContent={hasDetails ? (
        <div className={styles.sections} data-openbitfun-part="details">
          {program && <Section label={programLabel}>{program}</Section>}
          {(output || error) && (
            <Section label={outputLabel}>
              {error
                ? <div className={styles.error}>{error}</div>
                : <ToolCardText data-openbitfun-part="output">{output}</ToolCardText>}
            </Section>
          )}
        </div>
      ) : undefined}
      header={(
        <AmbientToolCardHeader
          action={action}
          content={summary}
          result={resultSummary}
          statusDescription={statusDescription}
          contentActions={actions ? <ToolCardActions>{actions}</ToolCardActions> : undefined}
          icon={<ToolCardStatusSlot size={14} status={status} toolIcon={<Icon name="code" size="sm" />} />}
        />
      )}
      isExpanded={Boolean(isExpanded && hasDetails)}
      onClick={hasDetails && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export interface WebFetchToolCardProps extends AmbientCardProps {
  action?: ReactNode;
  content?: ReactNode;
  copyAction?: ReactNode;
  contentLabel?: ReactNode;
  details?: readonly ReactNode[];
  emptyContent?: ReactNode;
  error?: ReactNode;
  onOpenUrl?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  openUrlLabel?: string;
  title: ReactNode;
  url?: string;
}

export function WebFetchToolCard({
  action,
  content,
  copyAction,
  contentLabel,
  details = [],
  emptyContent,
  error,
  isExpanded = false,
  onOpenUrl,
  onToggle,
  openUrlLabel,
  status,
  statusDescription,
  resultSummary,
  title,
  url,
  ...props
}: WebFetchToolCardProps) {
  const hasDetails = Boolean(url || content || emptyContent || error);
  return (
    <AmbientToolCard
      {...props}
      data-openbitfun-tool-card="web-fetch"
      expandedContent={hasDetails ? (
        <div className={styles.fetchMeta} data-openbitfun-part="details">
          {url && <span className={styles.openLinkText} data-openbitfun-part="sourceLink">{url}</span>}
          {details.length > 0 && (
            <div className={styles.detailsRow} data-openbitfun-part="detailsRow">
              <span className={styles.pills}>
                {details.map((detail, index) => (
                  <span className={styles.pill} data-openbitfun-part="detail" key={index}>{detail}</span>
                ))}
              </span>
            </div>
          )}
          {error ? (
            <div className={styles.error} data-openbitfun-part="error">{error}</div>
          ) : (
            <Section label={contentLabel} actions={copyAction}>
              <ToolCardText variant="prose" data-openbitfun-part="content">{content || emptyContent}</ToolCardText>
            </Section>
          )}
        </div>
      ) : undefined}
      header={(
        <AmbientToolCardHeader
          action={action}
          content={<OverflowText className={styles.fetchTitle} title={typeof title === "string" ? title : undefined}>{title}</OverflowText>}
          contentActions={url && onOpenUrl && openUrlLabel ? <IconButton size="sm" variant="quiet"
            aria-label={openUrlLabel} title={openUrlLabel} icon={<Icon name="arrow-up-right" size="sm" />}
            onClick={onOpenUrl} /> : undefined}
          result={resultSummary}
          statusDescription={statusDescription}
          icon={(
            <ToolCardStatusSlot size={14}
              status={status}
              toolIcon={<Icon name="browser" size="sm" />}
            />
          )}
        />
      )}
      isExpanded={Boolean(isExpanded && hasDetails)}
      onClick={hasDetails && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export interface DefaultToolCardProps extends AmbientCardProps {
  description?: ReactNode;
  displayName: ReactNode;
  error?: ReactNode;
  hasDetails?: boolean;
  icon?: ReactNode;
  inputLabel?: ReactNode;
  inputPreview?: ReactNode;
  onInputOpenChange?: (open: boolean) => void;
  requiresConfirmation?: boolean;
  resultLabel?: ReactNode;
  resultPreview?: ReactNode;
  summary: ReactNode;
  toolName: ReactNode;
}

export function DefaultToolCard({
  description,
  displayName,
  error,
  hasDetails,
  icon,
  inputLabel,
  inputPreview,
  onInputOpenChange,
  isExpanded = false,
  onToggle,
  requiresConfirmation = false,
  resultLabel,
  resultPreview,
  status,
  statusDescription,
  resultSummary,
  summary,
  toolName,
  ...props
}: DefaultToolCardProps) {
  const detailsAvailable = hasDetails ?? Boolean(inputPreview || resultPreview || error);
  const toolIcon = isValidElement(icon) ? icon : <Icon name="wrench" size="sm" />;
  return (
    <AmbientToolCard
      {...props}
      data-openbitfun-confirmation={requiresConfirmation ? "true" : "false"}
      data-openbitfun-tool-card="default"
      requiresConfirmation={requiresConfirmation}
      expandedContent={detailsAvailable ? (
        <div className={styles.sections} data-openbitfun-part="details">
          {(toolName !== displayName || description) && (
            <div className={styles.meta} data-openbitfun-part="meta">
              {toolName !== displayName && <span className={styles.metaLabel}>{toolName}</span>}
              {description && <span className={styles.metaDescription}>{description}</span>}
            </div>
          )}
          {(resultPreview || error) && (
            <Section label={resultLabel}>
              {error
                ? <div className={styles.error} data-openbitfun-part="error">{error}</div>
                : <ToolCardText data-openbitfun-part="result">{resultPreview}</ToolCardText>}
            </Section>
          )}
          {inputPreview && (
            <ToolCardDisclosure defaultOpen={!resultPreview && !error} onOpenChange={onInputOpenChange} summary={inputLabel}>
              <ToolCardText data-openbitfun-part="input">{inputPreview}</ToolCardText>
            </ToolCardDisclosure>
          )}
        </div>
      ) : undefined}
      header={(
        <AmbientToolCardHeader
          action={displayName}
          content={summary}
          result={resultSummary}
          statusDescription={statusDescription}
          icon={<ToolCardStatusSlot size={14} status={status} toolIcon={toolIcon} />}
        />
      )}
      isExpanded={Boolean(isExpanded && detailsAvailable)}
      onClick={detailsAvailable && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export interface ViewImageToolCardProps extends AmbientCardProps {
  action?: ReactNode;
  alt: string;
  errorText?: ReactNode;
  height?: number;
  imageFailed?: boolean;
  lightboxOpen?: boolean;
  lightboxTitle?: ReactNode;
  onImageError?: () => void;
  onLightboxClose?: () => void;
  onOpenPreview?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  previewLabel: string;
  source?: string;
  statusText: ReactNode;
  width?: number;
}

export function ViewImageToolCard({
  action,
  alt,
  errorText,
  height,
  imageFailed = false,
  isExpanded = false,
  lightboxOpen = false,
  lightboxTitle,
  onImageError,
  onLightboxClose,
  onOpenPreview,
  onToggle,
  previewLabel,
  source,
  status,
  statusDescription,
  resultSummary,
  statusText,
  width,
  ...props
}: ViewImageToolCardProps) {
  return (
    <>
      <AmbientToolCard
        {...props}
        data-openbitfun-tool-card="view-image"
        expandedContent={source ? (
          <div className={styles.imageContent} data-openbitfun-part="imageContent">
            {imageFailed ? (
              <div className={styles.imageError} data-openbitfun-part="imageError" role="alert">{errorText}</div>
            ) : (
              <button
                aria-label={previewLabel}
                className={styles.imageButton}
                data-openbitfun-part="imagePreview"
                onClick={onOpenPreview}
                type="button"
              >
                <img
                  alt={alt}
                  height={height}
                  onError={onImageError}
                  src={source}
                  width={width}
                />
              </button>
            )}
          </div>
        ) : undefined}
        header={(
          <AmbientToolCardHeader
            action={action}
            content={statusText}
          result={resultSummary}
          statusDescription={statusDescription}
            icon={<ToolCardStatusSlot size={14} status={status} toolIcon={<Icon name="image" size="sm" />} />}
          />
        )}
        isExpanded={Boolean(source && isExpanded)}
        onClick={source && onToggle ? onToggle : undefined}
        status={status}
      />
      <Dialog
        open={Boolean(lightboxOpen && source && !imageFailed)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onLightboxClose?.();
        }}
        size="lg"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{lightboxTitle ?? alt}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          <div className={styles.lightbox} data-openbitfun-part="lightbox">
            <img alt={alt} src={source ?? ""} />
          </div>
        </DialogBody>
      </Dialog>
    </>
  );
}

export type TodoToolCardItemStatus = "cancelled" | "completed" | "in_progress" | "pending";

export interface TodoToolCardItem {
  content: ReactNode;
  key: string;
  status: TodoToolCardItemStatus;
}

export interface TodoToolCardProps extends AmbientCardProps {
  allCompleted?: boolean;
  compactCountLabel?: ReactNode;
  compactProgressLabel?: ReactNode;
  completedCount: number;
  items: readonly TodoToolCardItem[];
  loading?: boolean;
  mode?: "compact" | "standard";
  progressLabel?: ReactNode;
  summary?: ReactNode;
  title: ReactNode;
  totalCount: number;
}

function TodoStatusIcon({ status }: { status: TodoToolCardItemStatus }) {
  if (status === "completed") return <Icon name="check-line" size="sm" />;
  if (status === "cancelled") return <Icon name="xmark" size="sm" />;
  if (status === "in_progress") return <Icon name="progress-25" size="sm" />;
  return <span aria-hidden="true" className={styles.todoPendingDot} />;
}

function TodoProgressBar({
  completedCount,
  totalCount,
  title,
  valueText,
}: {
  completedCount: number;
  totalCount: number;
  title: ReactNode;
  valueText?: ReactNode;
}) {
  const total = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0;
  const completed = Number.isFinite(completedCount)
    ? Math.min(total, Math.max(0, Math.floor(completedCount)))
    : 0;
  const progress = total > 0 ? completed / total : 0;
  const progressAttributes = {
    "aria-label": total > 0 && typeof title === "string" ? title : undefined,
    "aria-valuemax": total > 0 ? total : undefined,
    "aria-valuemin": total > 0 ? 0 : undefined,
    "aria-valuenow": total > 0 ? completed : undefined,
    "aria-valuetext": total > 0 && typeof valueText === "string" ? valueText : undefined,
    "aria-hidden": total === 0 ? true : undefined,
    "data-openbitfun-part": "todoProgress",
    role: total > 0 ? "progressbar" : undefined,
  };

  return (
    <div {...progressAttributes} className={styles.todoProgressTrack}>
      <span className={styles.todoProgressFill} style={{ inlineSize: `${progress * 100}%` }} />
    </div>
  );
}

export function TodoToolCard({
  allCompleted = false,
  compactCountLabel,
  compactProgressLabel,
  completedCount,
  isExpanded = false,
  items,
  loading = false,
  mode = "standard",
  onToggle,
  progressLabel,
  status,
  summary,
  title,
  totalCount,
  ...props
}: TodoToolCardProps) {
  const taskIcon = (
    <Icon
      label={typeof title === "string" ? title : undefined}
      name="list-todo"
      size="sm"
    />
  );

  if (mode === "compact") {
    return (
      <div
        {...props}
        className={styles.todoCompact}
        data-openbitfun-state={[loading && "loading", allCompleted && "completed"].filter(Boolean).join(" ") || undefined}
        data-openbitfun-tool-card="todo"
        data-openbitfun-view="compact"
      >
        <span className={styles.todoCompactIcon}>{taskIcon}</span>
        <OverflowText className={styles.todoCompactText}>{summary ?? compactCountLabel ?? title}</OverflowText>
      </div>
    );
  }

  const hasItems = items.length > 0;
  const expanded = Boolean(isExpanded && hasItems);
  const countLabel = progressLabel ?? `${completedCount} / ${totalCount}`;
  const headerSummary = (
    <span className={styles.todoSummary} data-openbitfun-part="summary">
      <OverflowText>{summary ?? title}</OverflowText>
    </span>
  );

  return (
    <ProminentToolCard
      {...props}
      allowExpandedWhenFailed
      className={classNames(styles.todoRoot, props.className)}
      data-openbitfun-tool-card="todo"
      expandedContentLayout="flush"
      expandedContent={hasItems ? (
        <div className={styles.todoExpanded}>
          <TodoProgressBar
            completedCount={completedCount}
            title={title}
            totalCount={totalCount}
            valueText={compactProgressLabel ?? countLabel}
          />
          <ScrollArea className={styles.todoList} data-openbitfun-part="todoList" edgeFade="vertical" overscrollBehaviorY="auto" role="list">
            {items.map((item) => (
              <div
                aria-current={item.status === "in_progress" ? "step" : undefined}
                className={styles.todoItem}
                data-openbitfun-part="todoItem"
                data-status={item.status}
                key={item.key}
                role="listitem"
              >
                <ToolCardIconSlot
                  className={styles.todoIcon}
                  expandable={false}
                  icon={<TodoStatusIcon status={item.status} />}
                />
                <span className={styles.todoContent}>{item.content}</span>
              </div>
            ))}
          </ScrollArea>
        </div>
      ) : undefined}
      summary={(
        <ProminentToolCardSummary
          action={expanded ? title : undefined}
          content={expanded ? undefined : headerSummary}
          extra={expanded ? <span className={styles.todoCount} data-openbitfun-part="todoCount">{countLabel}</span> : undefined}
          icon={expanded ? undefined : taskIcon}
        />
      )}
      isExpanded={expanded}
      onToggle={hasItems && onToggle ? onToggle : undefined}
      status={status}
      toggleTestId="todo-tool-card-toggle"
    />
  );
}
