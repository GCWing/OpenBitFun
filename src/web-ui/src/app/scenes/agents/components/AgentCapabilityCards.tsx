import { Card, CardBody, CardHeader, Icon, type IconName } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

export type CapabilitySection = 'model' | 'tools' | 'skills' | 'subagents';
export interface AgentCapabilityEntry {
  key: CapabilitySection;
  label: string;
  count?: string;
}

const PRESENTATION: Record<CapabilitySection, { icon: IconName; description: string }> = {
  tools: { icon: 'wrench', description: 'agentsOverview.detail.cards.tools' },
  skills: { icon: 'spark', description: 'agentsOverview.detail.cards.skills' },
  subagents: { icon: 'users', description: 'agentsOverview.detail.cards.subagents' },
  model: { icon: 'thinking', description: 'agentsOverview.detail.cards.model' },
};

export function AgentCapabilityCards({ entries, onOpen }: {
  entries: AgentCapabilityEntry[]; onOpen: (section: CapabilitySection) => void;
}) {
  const { t } = useI18n('scenes/agents');
  if (!entries.length) return null;
  return (
    <div className="agent-detail-dialog__capability-cards" role="group" aria-label={t('agentsOverview.detail.configuration')}
      data-testid="agent-detail-capability-cards" data-openbitfun-scene="agents" data-openbitfun-part="capabilityCards">
      {entries.map(entry => (
        <Card key={entry.key} appearance="subtle" padding="md" gap="sm"
          className="agent-detail-dialog__capability-card" role="button" tabIndex={0}
          aria-label={entry.label} data-detail-section={entry.key}
          onClick={() => onOpen(entry.key)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen(entry.key);
            }
          }}>
          <CardHeader align="center" leading={<Icon name={PRESENTATION[entry.key].icon} size="md" aria-hidden />}
            title={entry.label} actions={(
              <span className="agent-detail-dialog__card-actions">
                {entry.count && <span className="agent-detail-dialog__card-count">{entry.count}</span>}
                <Icon name="chevron-right" size="sm" aria-hidden />
              </span>
            )} />
          <CardBody>{t(PRESENTATION[entry.key].description)}</CardBody>
        </Card>
      ))}
    </div>
  );
}
