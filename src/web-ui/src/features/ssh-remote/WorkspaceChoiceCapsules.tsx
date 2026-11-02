import type { ReactNode } from 'react';
import { Button, Capsule, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import './WorkspaceChoiceCapsules.scss';

export interface WorkspaceChoice {
  id: string;
  label: string;
  description?: string;
  action?: ReactNode;
}

/** Keeps connection selection and editing in separate hit areas. */
export function WorkspaceChoiceCapsules({ choices, value, disabled, label, onValueChange, onEdit }: {
  choices: readonly WorkspaceChoice[];
  value?: string;
  disabled?: boolean;
  label: string;
  onValueChange: (id: string | undefined) => void;
  onEdit?: (id: string) => void;
}) {
  const { t } = useI18n('common');
  return <div className="workspace-choice-capsules" role="group" aria-label={label}
    data-openbitfun-component="ssh-remote" data-openbitfun-part="sourceOptions">
    {choices.map(choice => <Capsule size="xs" actionPlacement="reserved" key={choice.id} data-workspace-choice={choice.id}
      action={onEdit ? <Tooltip content={t('actions.edit')}><IconButton size="xs" shape="circle" variant="quiet"
        disabled={disabled} icon={<Icon name="edit" size="xs" />} aria-label={`${t('actions.edit')} · ${choice.label}`}
        onClick={() => onEdit(choice.id)} /></Tooltip> : choice.action}>
      <Button variant={choice.id === value ? 'fill' : 'outline'} size="xs" className="workspace-choice-capsules__button"
        leadingIcon={choice.id === value ? <Icon name="check-line" size="xs" tone="success" /> : undefined}
        aria-pressed={choice.id === value} disabled={disabled} title={choice.description}
        onClick={() => onValueChange(choice.id === value ? undefined : choice.id)}>{choice.label}</Button>
    </Capsule>)}
  </div>;
}
