import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Icon, type IconName } from "../../components/Icon/Icon";
import { ScrollArea } from "../../components/ScrollArea";
import { StatusPill, type StatusPillTone } from "../../components/StatusPill";
import { OverflowText } from "../../primitives/OverflowText";
import {
  AmbientToolCard, AmbientToolCardHeader, ProminentToolCard, ProminentToolCardSummary,
  ToolCardActions, ToolCardSubject, type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolCardDisclosure, ToolCardFields, ToolCardSection, ToolCardText, type ToolCardField } from "./ToolCardDetails";
import { ToolCardStatusSlot } from "./ToolCardStatusSlot";
import styles from "./SemanticToolCards.module.css";

export interface SemanticToolCardAction {
  key: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Blocking decisions such as authorization stay visible and labelled. */
  intent?: "auxiliary" | "primary";
  onPress: () => void;
}

export interface SemanticToolCardRecord {
  key: string;
  title: ReactNode;
  leading?: ReactNode;
  description?: ReactNode;
  state?: ReactNode;
  fields?: readonly SemanticToolCardField[];
  actions?: readonly SemanticToolCardAction[];
}

export interface SemanticToolCardField extends ToolCardField {
  controls?: readonly SemanticToolCardAction[];
}

export interface SemanticToolCardSection {
  key: string;
  label: ReactNode;
  content: ReactNode;
  variant?: "code" | "prose";
}

/** Host adapters supply recorded facts and callbacks; the public view owns all anatomy. */
export interface SemanticToolCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "onClick" | "children"> {
  action: ReactNode;
  summary?: ReactNode;
  resultSummary?: ReactNode;
  status: FlowChatToolStatus;
  statusDescription?: string;
  attention?: "ambient" | "prominent";
  outcome?: { label: ReactNode; tone: StatusPillTone };
  fields?: readonly SemanticToolCardField[];
  sections?: readonly SemanticToolCardSection[];
  records?: readonly SemanticToolCardRecord[];
  recordsLabel?: ReactNode;
  ordered?: boolean;
  emptyContent?: ReactNode;
  notice?: ReactNode;
  error?: ReactNode;
  media?: ReactNode;
  connection?: { from: ReactNode; to: ReactNode };
  actions?: readonly SemanticToolCardAction[];
  paramsText?: string;
  paramsLabel?: ReactNode;
  resultText?: string;
  resultLabel?: ReactNode;
  /** Details may be formatted lazily after the first expansion. */
  detailsAvailable?: boolean;
  isExpanded?: boolean;
  requiresConfirmation?: boolean;
  onToggle?: () => void;
  onDetailsChange?: () => void;
}

function Actions({ actions }: { actions: readonly SemanticToolCardAction[] }) {
  return <ToolCardActions>{actions.map(action => (
    action.intent === "primary" ? <Button key={action.key} size="sm" variant="primary" disabled={action.disabled}
      leadingIcon={action.icon ? <Icon name={action.icon} size="sm" /> : undefined}
      onClick={event => { event.stopPropagation(); action.onPress(); }}>{action.label}</Button>
      : <IconButton key={action.key} size="sm" variant="quiet" disabled={action.disabled}
          aria-label={action.label} title={action.label} icon={<Icon name={action.icon ?? "arrow-up-right"} size="sm" />}
          onClick={event => { event.stopPropagation(); action.onPress(); }} />
  ))}</ToolCardActions>;
}

function recordFields(fields: readonly SemanticToolCardField[]): ToolCardField[] {
  return fields.map(({ controls, ...field }) => ({ ...field,
    actions: controls?.length ? <Actions actions={controls} /> : field.actions }));
}

function SemanticToolCard({
  identity, iconName, action, summary, resultSummary, status, statusDescription,
  attention = "ambient", outcome, fields = [], sections = [], records = [], recordsLabel, ordered = false,
  emptyContent, notice, error, media, connection, actions = [], paramsText, paramsLabel, resultText, resultLabel,
  detailsAvailable, isExpanded = false, requiresConfirmation, onToggle, onDetailsChange, ...props
}: SemanticToolCardProps & { identity: string; iconName: IconName }) {
  const hasDetails = Boolean(detailsAvailable || fields.length || sections.length || records.length || emptyContent || notice || error || media
    || connection || paramsText || resultText);
  const icon = <ToolCardStatusSlot status={requiresConfirmation ? "pending_confirmation" : status}
    toolIcon={<Icon name={iconName} size="sm" />} />;
  const outcomeContent = outcome && <StatusPill tone={outcome.tone} shape="rounded">{outcome.label}</StatusPill>;
  const result = outcomeContent && resultSummary
    ? <span className={styles.result}>{resultSummary}{outcomeContent}</span> : outcomeContent ?? resultSummary;
  const List = ordered ? "ol" : "ul";
  const auxiliaryActions = actions.filter(item => item.intent !== "primary");
  const primaryActions = actions.filter(item => item.intent === "primary");
  const controls = auxiliaryActions.length > 0 ? <Actions actions={auxiliaryActions} /> : undefined;
  const primaryControls = primaryActions.length > 0 ? <Actions actions={primaryActions} /> : undefined;
  const details = hasDetails ? <div className={styles.details} data-openbitfun-part="details">
    {error && <ToolCardText variant="prose" className={styles.error} data-openbitfun-part="error">{error}</ToolCardText>}
    {notice && <ToolCardText variant="prose" data-openbitfun-part="notice">{notice}</ToolCardText>}
    {connection && <div className={styles.connection} data-openbitfun-part="connection">
      <span className={styles.endpoint}>{connection.from}</span><Icon name="arrow-right" size="sm" />
      <span className={styles.endpoint}>{connection.to}</span>
    </div>}
    {media && <div className={styles.media} data-openbitfun-part="media">{media}</div>}
    {fields.length > 0 && <ToolCardFields fields={recordFields(fields)} />}
    {(records.length > 0 || emptyContent) && <ToolCardSection label={recordsLabel}>
      {records.length > 0 ? <ScrollArea className={styles.viewport} edgeFade="vertical" overscrollBehaviorY="auto">
        <List className={styles.records} data-ordered={ordered || undefined} data-openbitfun-part="records">
          {records.map(record => <li className={styles.record} key={record.key} data-openbitfun-part="record">
            <div className={styles.identity} data-overflow-trigger data-tool-card-action-scope>
              {record.leading && <span className={styles.leading}>{record.leading}</span>}
              <ToolCardSubject actions={record.actions && record.actions.length > 0 ? <Actions actions={record.actions} /> : undefined}>
                <OverflowText className={styles.name}>{record.title}</OverflowText>
              </ToolCardSubject>
              {record.state && <span className={styles.state}>{record.state}</span>}
            </div>
            {record.description && <div className={styles.description}>{record.description}</div>}
            {record.fields && record.fields.length > 0 && <ToolCardFields fields={recordFields(record.fields)} />}
          </li>)}
        </List>
      </ScrollArea> : <ToolCardText variant="prose" data-openbitfun-part="empty">{emptyContent}</ToolCardText>}
    </ToolCardSection>}
    {sections.map(section => <ToolCardSection key={section.key} label={section.label}>
      <ToolCardText variant={section.variant ?? "prose"}>{section.content}</ToolCardText>
    </ToolCardSection>)}
    {resultText && <ToolCardDisclosure summary={resultLabel} onOpenChange={onDetailsChange}>
      <ToolCardText data-openbitfun-part="result">{resultText}</ToolCardText>
    </ToolCardDisclosure>}
    {paramsText && <ToolCardDisclosure summary={paramsLabel} onOpenChange={onDetailsChange}>
      <ToolCardText data-openbitfun-part="params">{paramsText}</ToolCardText>
    </ToolCardDisclosure>}
  </div> : undefined;
  const common = { ...props, "data-openbitfun-tool-card": identity, status, requiresConfirmation,
    isExpanded: isExpanded && hasDetails, expandedContent: details };
  return attention === "prominent"
    ? <ProminentToolCard {...common} allowExpandedWhenFailed onToggle={hasDetails ? onToggle : undefined}
        summary={<ProminentToolCardSummary icon={icon} action={action} content={summary}
          extra={result} primaryActions={primaryControls} contentActions={controls} />} />
    : <AmbientToolCard {...common} onClick={hasDetails ? onToggle : undefined}
        header={<AmbientToolCardHeader icon={icon} action={action} content={summary}
          result={result} statusDescription={statusDescription}
          contentActions={controls} extra={primaryControls} />} />;
}

export function GoalToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="goal" iconName="target" />;
}
export function AgentRosterToolCard({ deleting: _deleting, ...props }: SemanticToolCardProps & { deleting?: boolean }) {
  return <SemanticToolCard {...props} identity="agent-roster" iconName="users" />;
}
export function SessionHistoryToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="session-history" iconName="session" />;
}
export function ImageAnalysisToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="image-analysis" iconName="scan-eye" />;
}
export function TimeToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="time" iconName="clock" />;
}
export function McpResourceToolCard({ kind = "resources", ...props }: SemanticToolCardProps & {
  kind?: "resources" | "resource" | "prompts" | "prompt";
}) {
  const icons = { resources: "folder-search", resource: "file-text", prompts: "book-search", prompt: "book-open" } as const;
  return <SemanticToolCard {...props} identity="mcp-resource" iconName={icons[kind]} />;
}
export function WorktreeToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="worktree" iconName="git" />;
}
export function PortForwardToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="port-forward" iconName="route" />;
}
export function ReviewPlatformToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="review-platform" iconName="git-pull-request" />;
}
export function FrontendWorkbenchToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="frontend-workbench" iconName="panels-top-left" />;
}
export function MiniAppFinalizeToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="miniapp-finalize" iconName="mini-app" />;
}
export function MarketplacePublishToolCard({ appearance = false, ...props }: SemanticToolCardProps & { appearance?: boolean }) {
  return <SemanticToolCard {...props} identity="marketplace-publish" iconName={appearance ? "palette" : "mini-app"} />;
}
export function PlaybookToolCard(props: SemanticToolCardProps) {
  return <SemanticToolCard {...props} identity="playbook" iconName="workflow" />;
}
