import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogHeader, DialogHeading, DialogTitle, type DialogSize } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { OverflowText } from '../../primitives/OverflowText';
import { SubagentHatch } from '../../brand/subagent/SubagentHatch';
import { classNames } from '../../internal/classNames';
import type { FlowChatToolStatus } from './FlowChatToolCard';
import type { ToolCardInteraction, ToolCardParticipant } from './ToolCardInteraction';
import { ToolProcessingDots } from './ToolProcessingDots';
import styles from './ToolRelationRow.module.css';

export interface ToolRelationRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onClick'> {
  interaction: ToolCardInteraction;
  result: ReactNode;
  status: FlowChatToolStatus;
  details?: ReactNode;
  detailsTitle?: ReactNode;
  detailsSize?: DialogSize;
  resultLabel?: string;
}

/** The actor stays left; the arrow follows data flow. Only entities and the outcome are interactive. */
export function ToolRelationRow({ interaction, result, status, details, detailsTitle, detailsSize = 'sm', resultLabel, className, ...props }: ToolRelationRowProps) {
  const [hasOpenedDetails, setHasOpenedDetails] = useState(false);
  const [open, setOpen] = useState(false);
  const targets = interaction.targets?.length ? interaction.targets : [interaction.target];
  const participantKey = (value: ToolCardParticipant, index: number) => `target:${value.id ?? index}`;
  const active = ['pending', 'queued', 'preparing', 'receiving', 'running', 'streaming', 'waiting'].includes(status);
  const resultContent = <>
    {active && <span className={styles.processing} aria-hidden="true"><ToolProcessingDots size={14} /></span>}
    <span className={styles.resultText}>{result}</span>
  </>;
  const inspect = () => { setHasOpenedDetails(true); setOpen(true); };
  const participant = (value: ToolCardParticipant, part: 'source' | 'target', key: string) => {
    const interactive = Boolean(value.onOpen);
    const contents = <>
      <span className={styles.identity} aria-hidden="true" data-openbitfun-icon-slot="true">
        {value.avatar ?? (value.kind === 'agent' ? <SubagentHatch phase="stopped" size={16} active={false} />
          : <Icon name={value.kind === 'process' ? 'square-terminal' : 'session'} size="sm" />)}
      </span>
      <OverflowText>{value.label}</OverflowText>
    </>;
    return interactive || part === 'target' ? <button key={key} type="button" className={styles.participant} disabled={!interactive}
      data-openbitfun-part={part} data-overflow-trigger title={interactive ? value.openLabel : undefined}
      aria-label={interactive && value.openLabel ? `${value.label} · ${value.openLabel}` : value.label}
      onClick={event => { event.stopPropagation(); value.onOpen?.(event); }}>
      {contents}
    </button> : <span key={key} className={styles.participant} data-openbitfun-part={part}>{contents}</span>;
  };

  return <div {...props} className={classNames(styles.root, className)} data-openbitfun-component="tool-relation-row"
    data-openbitfun-part="root" data-openbitfun-status={status} data-operation={interaction.operation}>
    {interaction.source && participant(interaction.source, 'source', 'source')}
    <span className={styles.direction} aria-hidden="true" data-openbitfun-part="direction" data-openbitfun-icon-slot="true">
      <Icon name={interaction.operation === 'receive' ? 'arrow-left' : 'arrow-right'} size="sm" />
    </span>
    <span className={styles.targets} data-openbitfun-part="targets">
      {targets.map((target, index) => participant(target, 'target', participantKey(target, index)))}
    </span>
    <span className={styles.outcome} data-openbitfun-part="outcome">
      <span className={styles.separator} aria-hidden="true">:</span>
      {details ? <button type="button" className={styles.result} data-openbitfun-part="result"
        aria-haspopup="dialog" title={resultLabel} aria-label={resultLabel && typeof result === 'string' ? `${result} · ${resultLabel}` : resultLabel}
        onClick={event => { event.stopPropagation(); inspect(); }}>{resultContent}</button>
        : <span className={styles.result} data-openbitfun-part="result">{resultContent}</span>}
    </span>
    {hasOpenedDetails && <Dialog open={open} onOpenChange={setOpen} size={detailsSize}
      onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{detailsTitle ?? result}</DialogTitle>
          {interaction.source && <DialogDescription>
            {interaction.source.label} {interaction.operation === 'receive' ? '←' : '→'} {targets.map(target => target.label).join(' · ')}
          </DialogDescription>}
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody><div className={styles.details} data-openbitfun-component="tool-relation-row" data-openbitfun-part="details">{details}</div></DialogBody>
    </Dialog>}
  </div>;
}
