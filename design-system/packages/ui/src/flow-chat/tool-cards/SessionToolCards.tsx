import { OverflowText } from '../../primitives/OverflowText';
import { Icon } from '../../components/Icon/Icon';
import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { IconButton } from '../../components/IconButton/IconButton';
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  ToolCardActions,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import { ToolCardStatusSlot } from "./ToolCardStatusSlot";
import { ToolCardFields, ToolCardSection, ToolCardText } from "./ToolCardDetails";
import { ScrollArea } from "../../components/ScrollArea";
import type { ToolCardInteraction } from './ToolCardInteraction';
import { ToolRelationRow } from './ToolRelationRow';
import styles from "./SessionToolCards.module.css";

export interface SessionToolCardField {
  label: ReactNode;
  value: ReactNode;
}

export interface SessionToolCardRecord {
  key: string;
  title: ReactNode;
  fields: readonly SessionToolCardField[];
}

export interface SessionToolCardSession {
  agentType?: ReactNode;
  id: ReactNode;
  key: string;
  name?: ReactNode;
}

interface SessionToolCardBaseProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick"> {
  action?: ReactNode;
  emptyState?: ReactNode;
  error?: ReactNode;
  fields?: readonly SessionToolCardField[];
  records?: readonly SessionToolCardRecord[];
  icon: ReactNode;
  interaction?: ToolCardInteraction;
  isExpanded?: boolean;
  message?: ReactNode;
  messageLabel?: ReactNode;
  onToggle?: () => void;
  openAction?: { label: string; onPress: (event: MouseEvent<HTMLButtonElement>) => void };
  sessions?: readonly SessionToolCardSession[];
  status: FlowChatToolStatus;
  statusLabel?: ReactNode;
  statusDescription?: string;
  resultSummary?: ReactNode;
  resultLabel?: string;
  summary: ReactNode;
  toolCard: string;
}

function SessionToolCardBase({
  action,
  emptyState,
  error,
  fields = [],
  records = [],
  icon,
  interaction,
  isExpanded = false,
  message,
  messageLabel,
  onToggle,
  openAction,
  sessions = [],
  status,
  statusLabel,
  statusDescription,
  resultSummary,
  resultLabel,
  summary,
  toolCard,
  ...props
}: SessionToolCardBaseProps) {
  const hasDetails = fields.length > 0 || records.length > 0 || sessions.length > 0 || Boolean(emptyState || message || error || interaction && summary);
  const expandedContent = hasDetails ? (
    <div className={styles.details} data-openbitfun-part="details">
      {interaction && summary && <ToolCardText variant="prose">{summary}</ToolCardText>}
      {fields.length > 0 && <ToolCardFields fields={fields} />}

      {records.length > 0 && (
        <ScrollArea className={styles.sessionList} edgeFade="vertical" overscrollBehaviorY="auto">
          {records.map((record) => (
            <ToolCardSection className={styles.record} label={record.title} key={record.key}>
              <ToolCardFields fields={record.fields} />
            </ToolCardSection>
          ))}
        </ScrollArea>
      )}

      {sessions.length > 0 && (
        <ScrollArea className={styles.sessionList} data-openbitfun-part="sessionList" edgeFade="vertical" overscrollBehaviorY="auto">
          {sessions.map((session) => (
            <div className={styles.session} data-openbitfun-part="session" key={session.key}>
              {session.name && <OverflowText className={styles.sessionName}>{session.name}</OverflowText>}
              <span className={styles.sessionId}>{session.id}</span>
              {session.agentType && <span className={styles.sessionAgent}>{session.agentType}</span>}
            </div>
          ))}
        </ScrollArea>
      )}

      {message && (
        <ToolCardSection label={messageLabel} data-openbitfun-part="messageSection">
          <ToolCardText variant="prose" data-openbitfun-part="message">{message}</ToolCardText>
        </ToolCardSection>
      )}

      {emptyState && <div className={styles.empty} data-openbitfun-part="empty">{emptyState}</div>}
      {error && <div className={styles.error} data-openbitfun-part="error">{error}</div>}
    </div>
  ) : undefined;

  if (interaction) {
    const relationDetails = <div className={styles.details} data-openbitfun-part="details">
      {message && <ToolCardText variant="prose" data-openbitfun-part="message">{message}</ToolCardText>}
      {fields.length > 0 && <ToolCardFields fields={fields} />}
      {error && <ToolCardText variant="prose" data-openbitfun-part="error">{error}</ToolCardText>}
      {!message && !error && fields.length === 0 && <ToolCardText variant="prose">{summary}</ToolCardText>}
    </div>;
    return <ToolRelationRow {...props} data-openbitfun-tool-card={toolCard}
      interaction={{ ...interaction, target: openAction ? { ...interaction.target,
        onOpen: openAction.onPress, openLabel: openAction.label } : interaction.target }}
      status={status} result={statusLabel ?? resultSummary ?? summary}
      details={relationDetails} detailsTitle={message ? messageLabel ?? action : action ?? summary} resultLabel={resultLabel} />;
  }

  return (
    <AmbientToolCard
      {...props}
      data-openbitfun-tool-card={toolCard}
      expandedContent={expandedContent}
      header={(
        <AmbientToolCardHeader
          action={action}
          content={summary}
          result={resultSummary}
          statusDescription={statusDescription ?? (status === 'error' && typeof error === 'string'
            ? error : typeof statusLabel === 'string' ? statusLabel : undefined)}
          icon={<ToolCardStatusSlot status={status} toolIcon={icon} />}
          contentActions={openAction ? <ToolCardActions><IconButton size="sm" variant="quiet"
              icon={<Icon name="arrow-up-right" size="sm" />} aria-label={openAction.label}
              title={openAction.label} onClick={openAction.onPress} /></ToolCardActions> : undefined}
        />
      )}
      isExpanded={Boolean(isExpanded && hasDetails)}
      onClick={hasDetails && onToggle ? onToggle : undefined}
      status={status}
    />
  );
}

export interface SessionControlToolCardProps
  extends Omit<SessionToolCardBaseProps, "icon" | "message" | "messageLabel" | "toolCard" | "records"> {}

export function SessionControlToolCard(props: SessionControlToolCardProps) {
  return <SessionToolCardBase {...props} icon={<Icon name="session" size="sm" />} toolCard="session-control" />;
}

export interface SessionMessageToolCardProps
  extends Omit<SessionToolCardBaseProps, "emptyState" | "icon" | "sessions" | "toolCard" | "records"> {}

export function SessionMessageToolCard(props: SessionMessageToolCardProps) {
  return <SessionToolCardBase {...props} icon={<Icon name="session" size="sm" />} toolCard="session-message" />;
}

export interface CronToolCardProps
  extends Omit<SessionToolCardBaseProps, "icon" | "sessions" | "toolCard"> {
  timeQuery?: boolean;
}

export function CronToolCard({ timeQuery = false, ...props }: CronToolCardProps) {
  return <SessionToolCardBase {...props} icon={<Icon name={timeQuery ? "clock" : "calendar-clock"} size="sm" />} toolCard="cron" />;
}
