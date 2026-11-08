import React from 'react';
import { Card, OverflowText, type CardProps } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { AgentWithCapabilities } from '../agentsStore';

interface AgentCatalogCardProps extends Omit<CardProps, 'onClick' | 'onKeyDown'> {
  agent: AgentWithCapabilities;
  onOpenDetails: (agent: AgentWithCapabilities) => void;
}

/** Shared catalog interaction and public Card layout; adapters own identity slots. */
const AgentCatalogCard: React.FC<AgentCatalogCardProps> = ({ agent, onOpenDetails, children, ...props }) => {
  const openDetails = () => onOpenDetails(agent);

  return (
    <Card
      {...props}
      className="agent-catalog-card__surface"
      appearance="subtle"
      radius="md"
      padding="md"
      gap="sm"
      data-overflow-trigger
      role="button"
      tabIndex={0}
      aria-label={agent.name}
      onClick={openDetails}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetails();
        }
      }}
      data-testid="agent-list-item"
      data-agent-id={agent.id}
      data-agent-name={agent.name}
      data-agent-kind={agent.agentKind}
      data-subagent-source={agent.subagentSource ?? ''}
    >
      {children}
    </Card>
  );
};

export interface AgentCatalogMetricsProps extends React.HTMLAttributes<HTMLDivElement> {
  agent: AgentWithCapabilities;
  toolCount?: number;
  skillCount?: number | null;
  subagentCount?: number | null;
  countsLoading?: boolean;
}

export const AgentCatalogMetrics: React.FC<AgentCatalogMetricsProps> = ({
  agent,
  toolCount,
  skillCount = 0,
  subagentCount = 0,
  countsLoading = false,
  ...props
}) => {
  const { t } = useI18n('scenes/agents');
  const metrics = [
    { key: 'tools', label: t('agentCard.metrics.tools'), value: toolCount ?? agent.toolCount ?? agent.defaultTools?.length ?? 0 },
    ...(agent.agentKind !== 'subagent' ? [
      { key: 'skills', label: t('agentCard.metrics.skills'), value: skillCount },
      { key: 'collaboration', label: t('agentCard.metrics.collaboration'), value: subagentCount },
    ] : []),
  ];

  return (
    <div {...props} className="agent-catalog-card__metrics" data-agent-counts-loading={(skillCount === null || subagentCount === null) && countsLoading || undefined} aria-busy={(skillCount === null || subagentCount === null) && countsLoading || undefined}>
      {metrics.map(({ key, label, value }) => (
        <span key={key} className="agent-catalog-card__metric">
          <span className="agent-catalog-card__metric-value">{value ?? (countsLoading ? "…" : "—")}</span>
          <span>{label}</span>
        </span>
      ))}
      {agent.agentKind === 'subagent' && agent.subagentModelDisplayName ? (
        <OverflowText className="agent-catalog-card__model" title={`${t('agentCard.metrics.model')}: ${agent.subagentModelDisplayName}`}>
          {agent.subagentModelDisplayName}
        </OverflowText>
      ) : null}
    </div>
  );
};

export default AgentCatalogCard;
