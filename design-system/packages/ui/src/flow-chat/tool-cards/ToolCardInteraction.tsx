import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../../components/Icon/Icon';
import { OverflowText } from '../../primitives/OverflowText';
import { SubagentHatch } from '../../brand/subagent/SubagentHatch';
import styles from './ToolCardInteraction.module.css';

export interface ToolCardParticipant {
  id?: string;
  label: string;
  kind: 'agent' | 'session' | 'process';
  /** Host-owned identity artwork, shared with the corresponding agent card. */
  avatar?: ReactNode;
  openLabel?: string;
  onOpen?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Recorded evidence for targets that have no live navigation surface. */
  details?: ReactNode;
}

export interface ToolCardInteraction {
  operation: 'send' | 'receive' | 'create' | 'interrupt' | 'terminate' | 'delete' | 'rename' | 'list';
  source?: ToolCardParticipant;
  target: ToolCardParticipant;
  targets?: readonly ToolCardParticipant[];
}

/** An operation participant is an identity, not a result or status badge. */
export function ToolCardParticipantLabel({ label, icon, part }: {
  label: string;
  icon: ReactNode;
  part?: 'source' | 'target';
}) {
  return (
    <span className={styles.participant} data-openbitfun-part={part}>
      <span className={styles.participantIcon} aria-hidden="true">{icon}</span>
      <OverflowText>{label}</OverflowText>
    </span>
  );
}

/** Shared header anatomy; hosts supply identities and the recorded operation. */
export function ToolCardInteractionSummary({ interaction, targetContent }: {
  interaction: ToolCardInteraction;
  /** Existing multi-agent identity/navigation rails can occupy the target slot. */
  targetContent?: ReactNode;
}) {
  const receiving = interaction.operation === 'receive';
  const participant = (value: ToolCardParticipant, part: 'source' | 'target') => (
    <ToolCardParticipantLabel label={value.label} part={part} icon={value.avatar ?? (value.kind === 'agent'
        ? <SubagentHatch phase="stopped" size={16} active={false} />
        : <Icon name={value.kind === 'process' ? 'square-terminal' : 'session'} size="sm" />)} />
  );

  return (
    <span className={styles.root} data-openbitfun-part="interaction" data-operation={interaction.operation}>
      {interaction.source && <>
        {participant(interaction.source, 'source')}
        <Icon name={receiving ? 'arrow-left' : 'arrow-right'} size="sm" className={styles.direction}
          data-openbitfun-part="direction" aria-hidden="true" />
      </>}
      {targetContent ?? participant(interaction.target, 'target')}
    </span>
  );
}

/** The target owns the domain; the adjacent action label describes the operation. */
export function ToolCardInteractionIcon({ target }: Pick<ToolCardInteraction, 'operation' | 'target'>) {
  if (target.kind === 'process') return <Icon name="square-terminal" size="sm" />;
  if (target.kind === 'agent') return <Icon name="users" size="sm" />;
  return <Icon name="session" size="sm" />;
}
