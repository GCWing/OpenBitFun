import { Copy as LucideCopy, Edit3 as LucideEdit3, RotateCcw as LucideRotateCcw, RotateCw as LucideRotateCw, Trash2 as LucideTrash2 } from 'lucide-react';
import React from 'react';
import { MobileActionSheet, type MobileActionSheetItem } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import type { ChatMessage } from '../services/RemoteSessionManager';

interface ChatMessageActionsProps {
  deleting: boolean;
  message: ChatMessage | null;
  streaming?: boolean;
  rollbackSupported?: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onResend: () => void;
  onEdit?: () => void;
  onRollback?: () => void;
}

const CopyIcon = () => <LucideCopy width="18" height="18" stroke="currentColor" aria-hidden="true" />;
const ResendIcon = () => <LucideRotateCw width="18" height="18" stroke="currentColor" aria-hidden="true" />;
const EditIcon = () => <LucideEdit3 width="18" height="18" stroke="currentColor" aria-hidden="true" />;
const RollbackIcon = () => <LucideRotateCcw width="18" height="18" stroke="currentColor" aria-hidden="true" />;
const DeleteIcon = () => <LucideTrash2 width="18" height="18" stroke="currentColor" aria-hidden="true" />;

export default function ChatMessageActions({
  deleting,
  message,
  streaming = false,
  rollbackSupported = false,
  onClose,
  onCopy,
  onDelete,
  onResend,
  onEdit,
  onRollback,
}: ChatMessageActionsProps) {
  const { t } = useI18n();
  const hasTurnId = rollbackSupported
    && message?.role === 'user'
    && Boolean(message.turn_id)
    && typeof message.turn_index === 'number';

  const actions: MobileActionSheetItem[] = message ? [
    { id: 'copy', label: t('chat.copyMessage'), leading: <CopyIcon /> },
    ...(message.role === 'user' && !hasTurnId ? [{ id: 'resend', label: t('chat.resendMessage'), leading: <ResendIcon /> }] : []),
    ...(hasTurnId ? [
      {
        id: 'edit',
        label: t('chat.editAndResend'),
        leading: <EditIcon />,
        disabled: streaming,
        description: streaming ? t('chat.rollbackBlockedWhileBusy') : undefined,
      },
      {
        id: 'rollback',
        label: t('chat.rollbackToHere'),
        leading: <RollbackIcon />,
        disabled: streaming,
        description: streaming ? t('chat.rollbackBlockedWhileBusy') : undefined,
      },
    ] : []),
    { disabled: deleting, id: 'delete', label: deleting ? '...' : t('chat.deleteMessage'), leading: <DeleteIcon />, tone: 'danger' },
  ] : [];

  return (
    <MobileActionSheet
      actions={actions}
      cancelLabel={t('common.cancel')}
      closeOnAction={false}
      onAction={(id) => {
        if (id === 'copy') onCopy();
        if (id === 'resend') onResend();
        if (id === 'edit' && onEdit) onEdit();
        if (id === 'rollback' && onRollback) onRollback();
        if (id === 'delete') onDelete();
      }}
      onOpenChange={onClose}
      open={message !== null}
      title={t('common.more')}
    />
  );
}
