import { useId, useRef, useState } from 'react';
import { CornerDownRight, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button, Icon, IconButton, MenuPopover, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';

interface PendingQueueMessageActionsProps {
  sendLabel: string;
  sendTooltip?: string;
  sendAriaLabel?: string;
  sendDisabled: boolean;
  sending?: boolean;
  onSend: () => void;
  editLabel: string;
  editDisabled: boolean;
  onEdit: () => void;
  removeLabel: string;
  removeDisabled: boolean;
  onRemove: () => void;
  onCollapse?: () => void;
  onAbout?: () => void;
}

export function PendingQueueMessageActions({
  sendLabel, sendTooltip, sendAriaLabel, sendDisabled, sending, onSend,
  editLabel, editDisabled, onEdit, removeLabel, removeDisabled, onRemove,
  onCollapse, onAbout,
}: PendingQueueMessageActionsProps) {
  const { t } = useI18n('flow-chat');
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const moreLabel = t('pendingQueue.actions.more');

  return <>
    <Tooltip content={sendTooltip ?? sendLabel}>
      <Button data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="action"
        variant="text" size="xs" labelBehavior="static" aria-label={sendAriaLabel ?? sendLabel}
        leadingIcon={<Icon glyph={CornerDownRight} size="sm" />} disabled={sendDisabled} loading={sending} onClick={onSend}>
        {sendLabel}
      </Button>
    </Tooltip>
    <Tooltip content={removeLabel}>
      <IconButton data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="action"
        variant="annotation" size="xs" aria-label={removeLabel} icon={<Icon glyph={Trash2} size="sm" />}
        disabled={removeDisabled} onClick={onRemove} />
    </Tooltip>
    <Tooltip content={moreLabel} disabled={open}>
      <IconButton data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="action"
        ref={anchorRef} variant="annotation" size="xs" aria-label={moreLabel}
        icon={<Icon glyph={MoreHorizontal} size="sm" />} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)} />
    </Tooltip>
    <MenuPopover id={menuId} aria-label={moreLabel} anchorRef={anchorRef} open={open} onClose={() => setOpen(false)}
      placement="top" inlineSize="content" items={[
        { id: 'edit', label: editLabel, icon: <Icon name="edit" size="sm" />, disabled: editDisabled, onSelect: onEdit },
        ...(onCollapse ? [{ id: 'collapse', label: t('pendingQueue.actions.collapse'), icon: <Icon name="chevron-up" size="sm" />, onSelect: onCollapse }] : []),
        ...(onAbout ? [{ id: 'about', label: t('hostQueue.about'), icon: <Icon name="info" size="sm" />, onSelect: onAbout }] : []),
      ]} />
  </>;
}
