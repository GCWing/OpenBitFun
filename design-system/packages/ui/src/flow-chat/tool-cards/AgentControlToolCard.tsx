import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import { Icon } from '../../components/Icon/Icon';
import { OverflowText } from '../../primitives/OverflowText';
import { Tooltip } from '../../components/Tooltip';
import { classNames } from '../../internal/classNames';
import type { FlowChatToolStatus } from './FlowChatToolCard';
import { ToolCardStatusSlot } from './ToolCardStatusSlot';
import { ToolCapsulePresentationProvider } from './ToolCapsulePresentation';
import styles from './AgentControlToolCard.module.css';

export interface AgentControlToolCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onClick' | 'title'> {
  agentName: ReactNode;
  action?: string;
  /** Theme-aware identity color for the avatar's hover/focus label. */
  accentColor?: CSSProperties['color'];
  avatar?: ReactNode;
  isFailed?: boolean;
  onOpenAgent?: (event: MouseEvent<HTMLButtonElement>) => void;
  openAgentLabel?: string;
  openAgentTestId?: string;
  /** Localized metadata shown on the card and in its full hover preview. */
  preview?: {
    avatar?: ReactNode;
    agentType: ReactNode;
    model: ReactNode;
    labels: { agentType: string; model: string; description: string };
  };
  requiresConfirmation?: boolean;
  status: FlowChatToolStatus;
  statusLabel?: ReactNode;
  statusTone?: 'danger' | 'neutral' | 'success' | 'warning';
  summary?: ReactNode;
}

/** An identity card with one action: open the agent in the host's detail pane. */
export function AgentControlToolCard({
  agentName,
  action,
  accentColor = 'var(--openbitfun-color-content-primary)',
  avatar,
  className,
  isFailed = false,
  onOpenAgent,
  openAgentLabel,
  openAgentTestId,
  preview,
  requiresConfirmation = false,
  status,
  statusLabel,
  statusTone = 'neutral',
  style,
  summary,
  ...props
}: AgentControlToolCardProps) {
  const title = preview ? agentName : summary || agentName;
  const displayTitle = action
    ? typeof title === 'string' ? `${action} · ${title}` : <>{action} · {title}</>
    : title;
  const failed = isFailed || status === 'error';
  const confirmation = requiresConfirmation
    && !['completed', 'confirmed', 'cancelled', 'rejected', 'error'].includes(status);
  const state = [failed && 'failed', confirmation && 'confirmation'].filter(Boolean).join(' ') || undefined;
  const tone = failed ? 'danger' : confirmation ? 'warning' : statusTone;
  const label = [action, title, preview?.agentType, preview?.model, preview && summary, statusLabel, openAgentLabel]
    .filter(value => typeof value === 'string').join(' · ');
  const tooltipContent = preview ? (
    <div className={styles.preview} data-openbitfun-part="agentPreview">
      <div className={styles.previewHeader}>
        <span className={styles.previewAvatar} data-openbitfun-icon-slot="true" aria-hidden="true">
          {preview.avatar ?? avatar ?? <Icon glyph={UserRound} size="lg" />}
        </span>
        <div className={styles.previewTitle}>
          <strong className={styles.previewName} data-openbitfun-part="previewName">{agentName}</strong>
          {statusLabel && <span className={styles.previewCaption}>{statusLabel}</span>}
        </div>
      </div>
      <dl className={styles.previewMetadata}>
        <dt>{preview.labels.agentType}</dt>
        <dd data-openbitfun-part="previewAgentType">{preview.agentType}</dd>
        <dt>{preview.labels.model}</dt>
        <dd data-openbitfun-part="previewModel">{preview.model}</dd>
      </dl>
      <div className={styles.previewTask}>
        <span className={styles.previewCaption}>{preview.labels.description}</span>
        <p className={styles.previewDescription} data-openbitfun-part="previewDescription">{summary}</p>
      </div>
    </div>
  ) : label || title;

  return (
    <ToolCapsulePresentationProvider>
      <div
        {...props}
        className={classNames(styles.root, className)}
        style={{ '--_agent-accent-color': accentColor, ...style } as CSSProperties}
        data-agent-capsule="true"
        data-openbitfun-tool-card="agent-control"
        data-openbitfun-component="flow-chat-tool-card"
        data-openbitfun-part="root"
        data-openbitfun-attention="prominent"
        data-openbitfun-status={status}
        data-openbitfun-state={state}
        data-openbitfun-expandable="false"
      >
        <Tooltip content={tooltipContent} interactive={Boolean(preview)} placement="bottom" trigger="hover-focus">
        <button
          type="button"
          className={styles.surface}
          disabled={!onOpenAgent && !preview}
          aria-disabled={!onOpenAgent || undefined}
          onClick={onOpenAgent}
          aria-label={label || openAgentLabel}
          data-agent-capsule-trigger="true"
          data-openbitfun-component="flow-chat-tool-card"
          data-openbitfun-part="surface"
          data-openbitfun-affordance="open-panel-right"
          data-openbitfun-attention="prominent"
          data-openbitfun-interactive={onOpenAgent ? 'true' : 'false'}
          data-openbitfun-state={state}
          data-openbitfun-status={status}
          data-overflow-trigger
          data-testid={openAgentTestId}
        >
          <span className={styles.content}>
            <span className={styles.avatar} data-openbitfun-icon-slot="true" data-openbitfun-part="avatar" aria-hidden="true">
              {avatar ?? <Icon glyph={UserRound} size="lg" />}
            </span>
            <span className={styles.details}>
              <span className={styles.name}>
                <OverflowText className={styles.title} data-openbitfun-part="agentSummary">{displayTitle}</OverflowText>
                {statusLabel && preview ? (
                  <span className={styles.statusDot} data-openbitfun-part="agentStatus"
                    data-tone={tone} data-status={status} aria-hidden="true" />
                ) : statusLabel ? (
                  <OverflowText className={styles.status} data-openbitfun-part="agentStatus" data-tone={tone}>
                    {statusLabel}
                  </OverflowText>
                ) : !['completed', 'confirmed', 'cancelled', 'rejected'].includes(status) ? (
                  <ToolCardStatusSlot size={12} status={status} />
                ) : null}
                <Icon name="arrow-up-right" size="xs" className={styles.openIcon} data-openbitfun-icon="open-panel-right" />
              </span>
              {preview && (
                <span className={styles.metadata}>
                  <OverflowText className={styles.agentType} data-openbitfun-part="agentType"
                    aria-label={preview.labels.agentType}>{preview.agentType}</OverflowText>
                  <span className={styles.separator} aria-hidden="true">·</span>
                  <OverflowText className={styles.model} data-openbitfun-part="agentModel"
                    aria-label={preview.labels.model}>{preview.model}</OverflowText>
                </span>
              )}
            </span>
          </span>
        </button>
        </Tooltip>
      </div>
    </ToolCapsulePresentationProvider>
  );
}
