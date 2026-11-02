import type { ReactNode } from 'react';
import { Card, OverflowText } from '@openbitfun/ui';
import './ProjectResourceSummary.scss';

export function ProjectResourceSummary({ title, value, description, listTitle, boundedList = false, onOpen, children }: {
  title: string;
  value: ReactNode;
  description?: ReactNode;
  listTitle?: string;
  boundedList?: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return <div data-openbitfun-scene="project-resources" data-openbitfun-part="summary">
    <Card appearance="subtle" radius="lg" clip>
      <div className="project-resource-summary">
        <button type="button" className="project-resource-summary__pane project-resource-summary__pane--action" onClick={onOpen} aria-haspopup="dialog" data-overflow-trigger>
          <OverflowText className="project-resource-summary__title">{title}</OverflowText>
          <span className="project-resource-summary__value">{value}</span>
          {description && <span className="project-resource-summary__description">{description}</span>}
        </button>
        <div className={`project-resource-summary__pane${boundedList ? ' project-resource-summary__pane--bounded' : ''}`}>
          {listTitle && <span className="project-resource-summary__title">{listTitle}</span>}
          <div className="project-resource-summary__list">{children}</div>
        </div>
      </div>
    </Card>
  </div>;
}
