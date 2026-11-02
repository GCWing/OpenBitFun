import { Icon } from '@openbitfun/ui';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CircleDashed } from 'lucide-react';

import type { AcpPlanEntry } from '@/infrastructure/api/service-api/ACPClientAPI';
import './AcpPlanPanel.scss';

export interface AcpPlanPanelProps {
  entries: AcpPlanEntry[];
}

function statusIcon(status: string): React.ReactNode {
  switch (status) {
    case 'completed':
      return <Icon name="check-line" size="sm" className="openbitfun-acp-plan__icon openbitfun-acp-plan__icon--done" />;
    case 'in_progress':
      return (
        <Icon name="progress-25" size="sm" className="openbitfun-acp-plan__icon openbitfun-acp-plan__icon--active" />
      );
    default:
      return (
        <Icon glyph={CircleDashed} size="sm" className="openbitfun-acp-plan__icon openbitfun-acp-plan__icon--pending" />
      );
  }
}

export const AcpPlanPanel: React.FC<AcpPlanPanelProps> = ({ entries }) => {
  const { t } = useTranslation('flow-chat');
  if (entries.length === 0) return null;

  const done = entries.filter((entry) => entry.status === 'completed').length;

  return (
    <div data-openbitfun-component="acp-plan-panel" data-openbitfun-part="root" className="openbitfun-acp-plan" data-testid="acp-plan-panel">
      <div data-openbitfun-component="acp-plan-panel" data-openbitfun-part="header" className="openbitfun-acp-plan__header">
        <span data-openbitfun-component="acp-plan-panel" data-openbitfun-part="title" className="openbitfun-acp-plan__title">{t('chatInput.acpPlan.title')}</span>
        <span data-openbitfun-component="acp-plan-panel" data-openbitfun-part="progress" className="openbitfun-acp-plan__progress">
          {done}/{entries.length}
        </span>
      </div>
      <ul data-openbitfun-component="acp-plan-panel" data-openbitfun-part="list" className="openbitfun-acp-plan__list">
        {entries.map((entry, index) => (
          <li
            key={`${index}-${entry.content}`}
            data-openbitfun-component="acp-plan-panel"
            data-openbitfun-part="item"
            data-openbitfun-status={entry.status}
            className={`openbitfun-acp-plan__item openbitfun-acp-plan__item--${entry.status}`}
          >
            {statusIcon(entry.status)}
            <span data-openbitfun-component="acp-plan-panel" data-openbitfun-part="content" className="openbitfun-acp-plan__content">{entry.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

AcpPlanPanel.displayName = 'AcpPlanPanel';
