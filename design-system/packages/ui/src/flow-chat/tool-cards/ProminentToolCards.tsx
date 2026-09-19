import { OverflowText } from '../../primitives/OverflowText';
import type {
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  ArrowUpRight,
  FileText,
  GitBranch,
  GitCompare,
  Rocket,
  SearchCheck,
  Square,
  Sparkles,
} from "lucide-react";
import { IconButton } from "../../components/IconButton/IconButton";
import { Icon } from "../../components/Icon/Icon";
import {
  ProminentToolCard,
  ProminentToolCardSummary,
  ToolCardChangeSummary,
  ToolCardActions,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import {
  hasVisibleToolCardStatusGlyph,
  ToolCardStatusSlot,
} from "./ToolCardStatusSlot";
import { ToolProcessingDots } from "./ToolProcessingDots";
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
          icon={<GitBranch aria-hidden="true" />}
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
      {textPreview && <pre className={styles.textPreview}>{textPreview}</pre>}
    </div>
  ) : undefined;
  return (
    <ProminentToolCard
      {...props}
      data-openbitfun-tool-card="file-diff"
      errorContent={error ? <div className={styles.error}>{error}</div> : undefined}
      expandedContent={body}
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
          icon={<GitCompare aria-hidden="true" />}
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
  const Icon = kind === "deep-review" ? Sparkles : SearchCheck;
  return (
    <ProminentToolCard
      {...props}
      data-openbitfun-tool-card="review-summary"
      expandedContent={(
        <div className={styles.reviewDetails} data-openbitfun-part="details">
          <p className={styles.reviewSummary}>{summary}</p>
          {changedFiles.length > 0 && (
            <div>
              {filesLabel && <div className={styles.sectionLabel}>{filesLabel}</div>}
              <ul className={styles.fileList}>
                {changedFiles.map((file) => <li key={file}>{file}</li>)}
              </ul>
            </div>
          )}
          {action && <div className={styles.actions}>{action}</div>}
        </div>
      )}
      summary={(
        <ProminentToolCardSummary
          action={title}
          extra={changedFiles.length > 0 && fileCountLabel ? (
            <span className={styles.fileCount}><FileText aria-hidden="true" />{fileCountLabel}</span>
          ) : undefined}
          icon={<Icon aria-hidden="true" />}
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
  toolCard,
  version,
  ...props
}: PageLifecycleToolCardBaseProps) {
  const hasDetails = fields.length > 0 || Boolean(actions || error);
  const body = hasDetails ? (
    <div className={styles.lifecycleDetails} data-openbitfun-part="details">
      {fields.map((field, index) => (
        <div className={styles.field} key={index}>
          <span className={styles.fieldLabel}>{field.label}</span>
          <span className={styles.fieldValue}>{field.value}</span>
        </div>
      ))}
      {error && <div className={styles.error}>{error}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
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
          content={<OverflowText className={styles.command}>{subject}{version ? ` @ ${version}` : ""}</OverflowText>}
          icon={<Rocket aria-hidden="true" />}
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

export interface AgentControlToolCardProps extends ProminentCardProps {
  agentName: ReactNode;
  agentModel?: ReactNode;
  avatar?: ReactNode;
  details?: ReactNode;
  error?: ReactNode;
  summaryExpandAffordance?: boolean;
  interruptAction?: AgentControlToolCardAction;
  isFailed?: boolean;
  onOpenAgent?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  openAgentLabel?: string;
  openAgentTestId?: string;
  prompt?: ReactNode;
  requiresConfirmation?: boolean;
  statusLabel?: ReactNode;
  statusMeta?: ReactNode;
  statusTone?: "danger" | "neutral" | "success" | "warning";
  summary?: ReactNode;
  toggleTestId?: string;
}

export interface AgentControlToolCardAction {
  disabled?: boolean;
  label: string;
  onPress: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  pending?: boolean;
  testId?: string;
}

export function AgentControlToolCard({
  agentName,
  agentModel,
  avatar,
  className,
  details,
  error,
  summaryExpandAffordance,
  interruptAction,
  isExpanded = false,
  isFailed = false,
  onOpenAgent,
  onToggle,
  openAgentLabel,
  openAgentTestId,
  prompt,
  requiresConfirmation = false,
  status,
  statusLabel,
  statusMeta,
  statusTone = "neutral",
  summary,
  toggleTestId,
  ...props
}: AgentControlToolCardProps) {
  const expandedContent = details ?? (prompt ? (
    <div className={styles.agentPrompt} data-openbitfun-part="prompt">{prompt}</div>
  ) : undefined);
  const expandable = Boolean(onToggle && (
    expandedContent || summaryExpandAffordance || isExpanded
  ));
  const hasActions = Boolean(interruptAction);
  const hasTrailingActions = Boolean(onOpenAgent && openAgentLabel);
  const hasExtra = Boolean(statusMeta || statusLabel);
  const showStatusGlyph = status !== "completed"
    && status !== "confirmed"
    && hasVisibleToolCardStatusGlyph(status);

  const identity = (
    <span className={styles.agentIdentity} data-openbitfun-part="agentIdentity">
      <OverflowText className={styles.agentName} data-openbitfun-part="agentName">{agentName}</OverflowText>
      {agentModel !== undefined && agentModel !== null && agentModel !== false && (
        <OverflowText className={styles.agentModel} data-openbitfun-part="agentModel">{agentModel}</OverflowText>
      )}
    </span>
  );

  return (
    <ProminentToolCard
      {...props}
      className={className}
      data-openbitfun-tool-card="agent-control"
      errorContent={error ? <div className={styles.error}>{error}</div> : undefined}
      expandedContent={expandedContent}
      summary={(
        <ProminentToolCardSummary
          action={identity}
          actions={hasActions ? (
            <ToolCardActions>
              <IconButton
                aria-label={interruptAction!.label}
                data-openbitfun-part="interruptAgentButton"
                disabled={interruptAction!.disabled}
                icon={interruptAction!.pending
                  ? <ToolProcessingDots size={12} />
                  : <Square aria-hidden="true" fill="currentColor" />}
                onClick={interruptAction!.onPress}
                size="sm"
                data-testid={interruptAction!.testId}
                title={interruptAction!.label}
                tone="danger"
                variant="quiet"
              />
            </ToolCardActions>
          ) : undefined}
          content={summary !== undefined && summary !== null && summary !== false ? (
            <OverflowText className={styles.agentSummary} data-openbitfun-part="agentSummary">{summary}</OverflowText>
          ) : undefined}
          extra={hasExtra ? (
            <span className={styles.agentExtra} data-openbitfun-part="agentExtra">
              {statusMeta !== undefined && statusMeta !== null && statusMeta !== false && (
                <OverflowText className={styles.agentMeta} data-openbitfun-part="agentMeta">{statusMeta}</OverflowText>
              )}
              {statusLabel !== undefined && statusLabel !== null && statusLabel !== false && (
                <OverflowText className={styles.agentStatus} data-openbitfun-part="agentStatus" data-tone={statusTone}>
                  {statusLabel}
                </OverflowText>
              )}
            </span>
          ) : undefined}
          icon={(
            <span className={styles.agentAvatar} data-openbitfun-part="avatar">
              {avatar ?? <Icon name="user" aria-hidden="true" />}
            </span>
          )}
          statusIcon={showStatusGlyph
            ? <ToolCardStatusSlot size={16} status={status} />
            : undefined}
          trailingActions={hasTrailingActions ? (
            <ToolCardActions>
              <IconButton
                aria-label={openAgentLabel!}
                data-openbitfun-affordance="open-panel-right"
                data-openbitfun-part="openAgentButton"
                icon={<ArrowUpRight aria-hidden="true" data-openbitfun-icon="open-panel-right" />}
                onClick={onOpenAgent!}
                size="sm"
                data-testid={openAgentTestId}
                title={openAgentLabel!}
                variant="quiet"
              />
            </ToolCardActions>
          ) : undefined}
        />
      )}
      summaryExpandAffordance={summaryExpandAffordance ?? Boolean(expandedContent && onToggle)}
      isExpanded={Boolean(isExpanded && expandedContent)}
      isFailed={isFailed}
      onToggle={expandable ? onToggle : undefined}
      requiresConfirmation={requiresConfirmation}
      status={status}
      toggleTestId={toggleTestId}
    />
  );
}
