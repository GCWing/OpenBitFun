import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Card, OverflowText } from '@openbitfun/ui';
import './OverviewSplitCard.scss';

interface PaneContentProps {
  title: ReactNode;
  value?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

function PaneContent({ title, value, description, children }: PaneContentProps) {
  return <>
    <OverflowText className="overview-split-card__title">{title}</OverflowText>
    {value !== undefined && <span className="overview-split-card__value">{value}</span>}
    {description && <span className="overview-split-card__description">{description}</span>}
    {children && <div className="overview-split-card__content">{children}</div>}
  </>;
}

export function OverviewSplitCard({ children }: { children: ReactNode }) {
  return <Card appearance="subtle" radius="lg" clip>
    <div className="overview-split-card__grid" data-openbitfun-scene="personal-overview" data-openbitfun-part="catalog">{children}</div>
  </Card>;
}

export function OverviewSplitCardAction({ title, value, description, children, ...props }:
  PaneContentProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children' | 'value'>) {
  return <button {...props} className="overview-split-card__pane overview-split-card__pane--action" type="button" data-overflow-trigger>
    <PaneContent title={title} value={value} description={description}>{children}</PaneContent>
  </button>;
}

export function OverviewSplitCardSection(props: PaneContentProps) {
  return <div className="overview-split-card__pane"><PaneContent {...props} /></div>;
}
