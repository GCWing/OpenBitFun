import { OverflowText } from '../../primitives/OverflowText';
import { Icon } from '../../components/Icon/Icon';
import type { HTMLAttributes, ReactNode } from "react";
import {
  AmbientToolCard,
  AmbientToolCardHeader,
  type FlowChatToolStatus,
} from "./FlowChatToolCard";
import {
  ToolCardStatusSlot,
  type ToolCardStatusSlotProps,
} from "./ToolCardStatusSlot";
import styles from "./ActivityToolCards.module.css";
import type { ToolCardInteraction } from './ToolCardInteraction';
import { ToolRelationRow } from './ToolRelationRow';
import { AgentWaitTargetRail, type AgentWaitTargets } from './AgentWaitTargetRail';

interface ActivityToolCardBaseProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onClick"> {
  action?: ReactNode;
  defaultIcon?: ToolCardStatusSlotProps["defaultIcon"];
  extra?: ReactNode;
  icon: ReactNode;
  interaction?: ToolCardInteraction;
  status: FlowChatToolStatus;
  statusDescription?: string;
  resultSummary?: ReactNode;
  details?: ReactNode;
  detailsTitle?: ReactNode;
  resultLabel?: string;
  summary?: ReactNode;
  summaryTitle?: string;
  toolCard: string;
}

function ActivityToolCardBase({
  action,
  defaultIcon,
  extra,
  icon,
  interaction,
  status,
  statusDescription,
  resultSummary,
  details,
  detailsTitle,
  resultLabel,
  summary,
  summaryTitle,
  toolCard,
  ...props
}: ActivityToolCardBaseProps) {
  const summaryContent = summary !== undefined && summary !== null ? (
    <OverflowText className={styles.summary} data-openbitfun-part="summary"
      title={summaryTitle}>
      {summary}
    </OverflowText>
  ) : undefined;
  if (interaction) return <ToolRelationRow {...props} data-openbitfun-tool-card={toolCard}
    interaction={interaction} status={status} result={resultSummary ?? summary ?? action}
    details={details} detailsTitle={detailsTitle ?? action} resultLabel={resultLabel} />;
  return (
    <AmbientToolCard
      {...props}
      data-openbitfun-tool-card={toolCard}
      header={(
        <AmbientToolCardHeader
          action={action}
          content={summaryContent}
          result={resultSummary}
          statusDescription={statusDescription ?? summaryTitle}
          extra={extra}
          icon={(
            <ToolCardStatusSlot
              size={14}
              defaultIcon={defaultIcon}
              status={status}
              toolIcon={icon}
            />
          )}
        />
      )}
      status={status}
    />
  );
}

export type ActivityToolCardProps = Omit<
  ActivityToolCardBaseProps,
  "icon" | "toolCard"
>;

export function AgentWaitToolCard({ agents, ...props }: ActivityToolCardProps & { agents?: AgentWaitTargets }) {
  return (
    <ActivityToolCardBase
      {...props}
      interaction={props.interaction && agents?.items.length ? { ...props.interaction,
        targets: agents.items.map(item => ({ id: item.id, label: item.name, kind: 'agent',
          avatar: item.avatar, openLabel: item.openLabel, onOpen: item.onOpen })) } : props.interaction}
      extra={!props.interaction && agents?.items.length ? <AgentWaitTargetRail {...agents} /> : props.extra}
      icon={<Icon name="users" size="sm" />}
      toolCard="agent-wait"
    />
  );
}

export function GetToolSpecToolCard(props: ActivityToolCardProps) {
  return (
    <ActivityToolCardBase
      {...props}
      icon={<Icon name="book-search" size="sm" />}
      toolCard="get-tool-spec"
    />
  );
}

export function SkillToolCard(props: ActivityToolCardProps) {
  return (
    <ActivityToolCardBase
      {...props}
      defaultIcon={props.status === "completed" || props.status === "confirmed" ? "tool" : props.defaultIcon}
      icon={<Icon name="book-open" size="sm" />}
      toolCard="skill"
    />
  );
}

export function TerminalControlToolCard(props: ActivityToolCardProps) {
  return (
    <ActivityToolCardBase
      {...props}
      icon={<Icon name="square-terminal" size="sm" />}
      toolCard="terminal-control"
    />
  );
}
