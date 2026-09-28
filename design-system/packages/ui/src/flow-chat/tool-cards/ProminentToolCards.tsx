import { OverflowText } from '../../primitives/OverflowText';
import type {
  HTMLAttributes,
  ReactNode,
} from "react";
import {
  GitCompare,
  SearchCheck,
} from "lucide-react";
import { Icon } from "../../components/Icon/Icon";
import {
  ProminentToolCard,
  ProminentToolCardSummary,
  ToolCardChangeSummary,
  ToolCardActions,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolProcessingDots } from "./ToolProcessingDots";
import { ToolCardFields, ToolCardSection, ToolCardText } from "./ToolCardDetails";
import { ScrollArea } from "../../components/ScrollArea";
import styles from "./ProminentToolCards.module.css";

interface ProminentCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick" | "title"> {
  isExpanded?: boolean;
  onToggle?: () => void;
  status: FlowChatToolStatus;
}

export interface GitToolCardFooterItem {
  grow?: boolean;
  label?: ReactNode;
  tone?: "danger" | "neutral" | "success";
  value: ReactNode;
}

export interface GitToolCardProps extends ProminentCardProps {
  action: ReactNode;
  command: ReactNode;
  error?: ReactNode;
  errorMeta?: ReactNode;
  footerItems?: readonly GitToolCardFooterItem[];
  actions?: ReactNode;
  loading?: boolean;
  statusSummary?: ReactNode;
  statusTone?: "danger" | "neutral" | "warning";
  stderr?: ReactNode;
  stderrLabel?: ReactNode;
  stderrTone?: "danger" | "warning";
  stdout?: ReactNode;
}

export function GitToolCard({
  action,
  actions,
  command,
  error,
  errorMeta,
  footerItems = [],
  isExpanded = false,
  loading = false,
  onToggle,
  status,
  statusSummary,
  statusTone = "neutral",
  stderr,
  stderrLabel,
  stderrTone = "danger",
  stdout,
  ...props
}: GitToolCardProps) {
  const hasDetails = Boolean(stdout || stderr || error || footerItems.length > 0);
  const body = hasDetails ? (
    <div className={styles.output} data-openbitfun-part="details">
      {stdout && <pre className={styles.outputBlock} data-openbitfun-part="stdout">{stdout}</pre>}
      {stderr && (
        <div className={styles.outputGroup} data-openbitfun-part="stderr" data-tone={stderrTone}>
          {stderrLabel && <span className={styles.outputLabel}>{stderrLabel}</span>}
          <pre className={styles.outputBlock}>{stderr}</pre>
        </div>
      )}
      {error && (
        <div className={styles.error} data-openbitfun-part="error">
          {error}
          {errorMeta && <div className={styles.errorMeta}>{errorMeta}</div>}
        </div>
      )}
      {footerItems.length > 0 && (
        <div className={styles.footer} data-openbitfun-part="footer">
          {footerItems.map((item, index) => (
            <span
              className={styles.footerItem}
              data-grow={item.grow ? "true" : "false"}
              data-tone={item.tone ?? "neutral"}
              key={index}
            >
              {item.label && <span className={styles.footerLabel}>{item.label}</span>}
              <OverflowText className={styles.footerValue}>{item.value}</OverflowText>
            </span>
          ))}
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <ProminentToolCard
      {...props}
      data-openbitfun-tool-card="git"
      errorContent={status === "error" ? body : undefined}
      expandedContent={status === "error" ? undefined : body}
      summary={(
        <ProminentToolCardSummary
          action={action}
          actions={actions ? <ToolCardActions>{actions}</ToolCardActions> : undefined}
          content={<code className={styles.command}><OverflowText>{command}</OverflowText></code>}
          extra={statusSummary ? (
            <OverflowText className={styles.summary} data-tone={statusTone}>{statusSummary}</OverflowText>
          ) : undefined}
          icon={<Icon name="git" size="sm" />}
          statusIcon={loading ? <ToolProcessingDots size={16} /> : undefined}
        />
      )}
      summaryExpandAffordance={hasDetails}
      isExpanded={Boolean(isExpanded && hasDetails && status !== "error")}
      onToggle={hasDetails && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export interface FileDiffToolCardProps extends ProminentCardProps {
  action: ReactNode;
  changeSummary?: {
    additions: number | string;
    deletions: number | string;
    label: string;
  };
  error?: ReactNode;
  loading?: boolean;
  message?: ReactNode;
  path: string;
  pathLabel: ReactNode;
  preview?: ReactNode;
  textPreview?: ReactNode;
}

export function FileDiffToolCard({
  action,
  changeSummary,
  error,
  isExpanded = false,
  loading = false,
  message,
  onToggle,
  path,
  pathLabel,
  preview,
  status,
  textPreview,
  ...props
}: FileDiffToolCardProps) {
  const body = preview || textPreview || message ? (
    <div className={styles.diffBody} data-openbitfun-part="details">
      {message && <div className={styles.message}>{message}</div>}
      {preview}
      {textPreview && <ToolCardText className={styles.textPreview}>{textPreview}</ToolCardText>}
    </div>
  ) : undefined;
  return (
    <ProminentToolCard
      {...props}
      data-openbitfun-tool-card="file-diff"
      errorContent={error ? <div className={styles.error}>{error}</div> : undefined}
      expandedContent={body}
      expandedContentLayout="flush"
      summary={(
        <ProminentToolCardSummary
          action={action}
          content={(
            <OverflowText
              className={styles.diffPath}
              data-path={path}
              data-openbitfun-part="path"
              title={path}
            >
              {pathLabel}
            </OverflowText>
          )}
          extra={changeSummary ? (
            <ToolCardChangeSummary
              additions={changeSummary.additions}
              aria-label={changeSummary.label}
              deletions={changeSummary.deletions}
            />
          ) : undefined}
          icon={<Icon glyph={GitCompare} size="sm" />}
          statusIcon={loading ? <ToolProcessingDots size={16} /> : undefined}
        />
      )}
      summaryExpandAffordance={Boolean(body)}
      isExpanded={Boolean(isExpanded && body && status !== "error")}
      onToggle={body && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export interface ReviewSummaryToolCardProps extends ProminentCardProps {
  action?: ReactNode;
  changedFiles?: readonly string[];
  fileCountLabel?: ReactNode;
  filesLabel?: ReactNode;
  kind?: "deep-review" | "review";
  loading?: boolean;
  summary: ReactNode;
  title: ReactNode;
}

export function ReviewSummaryToolCard({
  action,
  changedFiles = [],
  fileCountLabel,
  filesLabel,
  isExpanded = false,
  kind = "review",
  loading = false,
  onToggle,
  status,
  summary,
  title,
  ...props
}: ReviewSummaryToolCardProps) {
  return (
    <ProminentToolCard
      {...props}
      allowExpandedWhenFailed
      data-openbitfun-tool-card="review-summary"
      data-openbitfun-review-kind={kind}
      expandedContent={(
        <div className={styles.reviewDetails} data-openbitfun-part="details">
          <p className={styles.reviewSummary}>{summary}</p>
          {changedFiles.length > 0 && (
            <ToolCardSection label={filesLabel}>
              <ScrollArea className={styles.fileViewport} edgeFade="vertical" overscrollBehaviorY="auto">
                <ul className={styles.fileList}>
                  {changedFiles.map((file) => <li key={file}>{file}</li>)}
                </ul>
              </ScrollArea>
            </ToolCardSection>
          )}
        </div>
      )}
      summary={(
        <ProminentToolCardSummary
          action={title}
          actions={action}
          extra={changedFiles.length > 0 && fileCountLabel ? (
            <span className={styles.fileCount} data-openbitfun-icon-slot="true"><Icon name="file-text" size="sm" />{fileCountLabel}</span>
          ) : undefined}
          icon={<Icon glyph={SearchCheck} size="sm" />}
          statusIcon={loading ? <ToolProcessingDots size={16} /> : undefined}
        />
      )}
      isExpanded={isExpanded}
      onToggle={onToggle}
      status={status}
    />
  );
}

export interface PageLifecycleToolCardField {
  label: ReactNode;
  value: ReactNode;
}

interface PageLifecycleToolCardBaseProps extends ProminentCardProps {
  action: ReactNode;
  actions?: ReactNode;
  error?: ReactNode;
  fields?: readonly PageLifecycleToolCardField[];
  loading?: boolean;
  subject: ReactNode;
  toolCard: "page-deploy" | "page-publish";
  preview?: boolean;
  statusLabel?: ReactNode;
  version?: ReactNode;
}

function PageLifecycleToolCardBase({
  action,
  actions,
  error,
  fields = [],
  isExpanded = false,
  loading = false,
  onToggle,
  status,
  subject,
  preview: _preview = false,
  statusLabel,
  toolCard,
  version,
  ...props
}: PageLifecycleToolCardBaseProps) {
  const hasDetails = fields.length > 0 || Boolean(error);
  const body = hasDetails ? (
    <div className={styles.lifecycleDetails} data-openbitfun-part="details">
      {fields.length > 0 && <ToolCardFields fields={fields} />}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  ) : undefined;
  return (
    <ProminentToolCard
      {...props}
      data-openbitfun-tool-card={toolCard}
      errorContent={status === "error" ? body : undefined}
      expandedContent={status === "error" ? undefined : body}
      summary={(
        <ProminentToolCardSummary
          action={action}
          actions={actions}
          content={<OverflowText className={styles.command}>{subject}{version ? ` @ ${version}` : ""}</OverflowText>}
          extra={statusLabel}
          icon={<Icon name="panels-top-left" size="sm" />}
          statusIcon={loading ? <ToolProcessingDots size={16} /> : undefined}
        />
      )}
      summaryExpandAffordance={hasDetails}
      isExpanded={Boolean(isExpanded && hasDetails && status !== "error")}
      onToggle={hasDetails && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export type PageDeployToolCardProps = Omit<PageLifecycleToolCardBaseProps, "toolCard">;
export function PageDeployToolCard(props: PageDeployToolCardProps) {
  return <PageLifecycleToolCardBase {...props} toolCard="page-deploy" />;
}

export type PagePublishToolCardProps = Omit<PageLifecycleToolCardBaseProps, "toolCard">;
export function PagePublishToolCard(props: PagePublishToolCardProps) {
  return <PageLifecycleToolCardBase {...props} toolCard="page-publish" />;
}

export { AgentControlToolCard, type AgentControlToolCardProps } from "./AgentControlToolCard";
