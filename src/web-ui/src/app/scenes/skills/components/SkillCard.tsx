import React from 'react';
import { Button, Card, CardBody, CardFooter, CardHeader, Icon, OverflowText } from '@openbitfun/ui';
import './SkillCard.scss';

type SkillCardActionTone = 'primary' | 'danger' | 'success' | 'muted';

export interface SkillCardAction {
  id: string;
  icon: React.ReactNode;
  ariaLabel: string;
  label?: string;
  loading?: boolean;
  title?: string;
  disabled?: boolean;
  tone?: SkillCardActionTone;
  onClick: () => void;
}

interface SkillCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  name: string;
  description?: string;
  source?: string;
  index?: number;
  accentSeed?: string;
  iconKind?: 'skill' | 'market';
  badges?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: SkillCardAction[];
  onOpenDetails?: () => void;
}

const SkillCard: React.FC<SkillCardProps> = ({
  name,
  description,
  source,
  index = 0,
  accentSeed: _accentSeed,
  iconKind = 'skill',
  badges,
  meta,
  actions = [],
  onOpenDetails,
  className,
  style,
  ...rootProps
}) => {
  return (
    <div data-openbitfun-component="skill-card" data-openbitfun-part="root"
      {...rootProps}
      className={['skill-card', className].filter(Boolean).join(' ')}
      style={{
        ...style,
        '--surface-stagger-index': index,
      } as React.CSSProperties}
      data-openbitfun-variant={iconKind}
      data-overflow-trigger
    >
      <Card appearance="subtle" padding="md" gap="md" className="skill-card__surface">
        {onOpenDetails && (
          <button
            type="button"
            className="skill-card__open"
            aria-label={name}
            onClick={onOpenDetails}
          />
        )}
        <CardHeader
          align="center"
          className="skill-card__header"
          leading={(
            <div className="skill-card__icon-area" data-openbitfun-component="skill-card" data-openbitfun-part="iconArea">
              <div className="skill-card__icon" data-openbitfun-component="skill-card" data-openbitfun-part="icon">
                <Icon name="book-open" size="md" />
              </div>
            </div>
          )}
          title={(
            <div className="skill-card__title-row" data-openbitfun-component="skill-card" data-openbitfun-part="titleRow">
              <span className="skill-card__name" data-openbitfun-component="skill-card" data-openbitfun-part="name">
                <OverflowText>{name}</OverflowText>
              </span>
              {badges && <div className="skill-card__badges" data-openbitfun-component="skill-card" data-openbitfun-part="badges">{badges}</div>}
            </div>
          )}
          description={source?.trim() ? (
            <span className="skill-card__source" data-openbitfun-component="skill-card" data-openbitfun-part="source">
              <OverflowText>{source.trim()}</OverflowText>
            </span>
          ) : undefined}
          data-openbitfun-component="skill-card"
          data-openbitfun-part="header"
        />

        <CardBody data-openbitfun-component="skill-card" data-openbitfun-part="body">
          {description?.trim() && (
            <OverflowText as="p" lines={2} className="skill-card__desc" data-openbitfun-component="skill-card" data-openbitfun-part="description">{description.trim()}</OverflowText>
          )}
        </CardBody>

        {(meta || actions.length > 0) && (
          <CardFooter align="between" className="skill-card__footer" data-openbitfun-component="skill-card" data-openbitfun-part="footer">
            {meta && (
              <div className="skill-card__meta" data-openbitfun-component="skill-card" data-openbitfun-part="meta">
                {meta}
              </div>
            )}
            <div className="skill-card__actions" data-openbitfun-component="skill-card" data-openbitfun-part="actions">
              {actions.map((action) => (
                <span
                  key={action.id}
                  className="skill-card__action"
                  data-openbitfun-component="skill-card"
                  data-openbitfun-part="action"
                  data-openbitfun-tone={action.tone}
                  data-openbitfun-state={action.disabled || action.loading ? 'disabled' : undefined}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    tone={action.tone === 'danger' ? 'danger' : 'neutral'}
                    leadingIcon={action.icon}
                    onClick={action.onClick}
                    disabled={action.disabled}
                    loading={action.loading}
                    aria-label={action.ariaLabel}
                    title={action.title ?? action.ariaLabel}
                    data-testid="skills-card-action"
                    data-skill-action={action.id}
                  >
                    {action.label ?? action.ariaLabel}
                  </Button>
                </span>
              ))}
            </div>
          </CardFooter>
        )}
      </Card>
    </div>
  );
};

export default SkillCard;
