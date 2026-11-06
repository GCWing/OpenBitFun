import { pendingQueueManager } from '../services/flow-chat-manager/PendingQueueModule';
import type { QueuedMessage } from '../types/flow-chat';
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Icon, IconButton, OverflowText, Tooltip } from '@openbitfun/ui';
import { GripVertical, ListEnd, Paperclip, RotateCw } from 'lucide-react';
import './HostPendingQueuePanel.scss';
import { useQueueReorder } from '@openbitfun/ui/flow-chat';
import { PendingQueueMessageActions } from './PendingQueueMessageActions';
import { usePendingQueueDisclosure } from './usePendingQueueDisclosure';
import { hostQueuePresentation, observePresentedHostQueue } from '../services/hostQueuePresentation';
import { HostDialogQueue, type QueueOutboxRecord, type QueueItem } from '../../../../shared/dialog-queue/HostDialogQueue';
import {
  ChatComposerQueue, ChatComposerQueueHeader, ChatComposerQueueTitle, ChatComposerQueueToggle,
  ChatComposerQueueList, ChatComposerQueueItem, ChatComposerQueueItemContent, ChatComposerQueueItemMessage, ChatComposerQueueItemActions,
  ChatComposerQueueItemStatus, ChatComposerQueueAttachmentBadge,
} from '@openbitfun/ui/flow-chat';

function QueueAction({ label, icon, disabled, onClick }: { label: string; icon: ReactNode; disabled: boolean; onClick: () => void }) {
  return <Tooltip content={label}>
    <IconButton data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="action" size="xs" variant="annotation" aria-label={label} icon={icon} disabled={disabled} onClick={onClick} />
  </Tooltip>;
}

export function HostPendingQueuePanel({ queue, onRestore }: { queue: HostDialogQueue; onRestore: (item: QueuedMessage) => boolean }) {
  const { t } = useI18n('flow-chat');
  const view = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const presentation = hostQueuePresentation(queue);
  const projected = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot, presentation.getSnapshot);
  const { expanded, toggle, toggleRef, listRef } = usePendingQueueDisclosure();
  const [showHelp, setShowHelp] = useState(false);
  const listId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => observePresentedHostQueue(queue), [queue]);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const restoreDraft = async (saved: QueueOutboxRecord, knownItem?: QueueItem) => {
    if (saved.request.action !== 'submit') return;
    await queue.prepareRestore(saved);
    const message = saved.request.message;
    const item = knownItem ?? await queue.receipt(message.turnId, saved.request.queueEpoch);
    if (!item) throw new Error(t('hostQueue.unknown'));
    if (item.status !== 'cancelled') {
      const result = await queue.act(item, 'cancel');
      if (result.receipt?.status !== 'cancelled') throw new Error(t('hostQueue.unknown'));
    }
    const cache = saved.draft as Partial<QueuedMessage> | undefined;
    const restored = onRestore({ ...cache, id: item.turnId, sessionId: queue.sessionId,
      content: message.content, displayMessage: message.displayContent, agentType: message.agentType,
      timestamp: item.createdAtMs, status: 'queued', retryCount: cache?.retryCount ?? 0,
      userMessageMetadata: message.metadata });
    if (!restored) {
      // Preserve the complete draft if the composer changed during cancellation.
      pendingQueueManager.enqueue({ ...cache, sessionId: queue.sessionId,
        content: message.content, displayMessage: message.displayContent,
        agentType: message.agentType, userMessageMetadata: message.metadata,
        retryCount: 1, initialStatus: 'failed' });
    }
    await queue.dismiss(saved);
  };
  const items = (view.snapshot?.items ?? []).filter(item => item.status === 'blocked' || !projected.has(item.turnId));
  const reorderIds = items.filter(item => item.status === 'queued').map(item => item.turnId);
  const reorder = useQueueReorder(reorderIds, !busy && !view.error && view.snapshot?.supportsReorder === true,
    `${view.snapshot?.queueEpoch}:${view.snapshot?.revision}`, (id, before) => void run(() => queue.reorder(id, before)));
  const rawError = error || (view.error?.includes('Session is not loaded') ? null : view.error);
  const visibleError = rawError?.includes('queue_conflict:') ? t('pendingQueue.orderChanged') : rawError;
  if (!items.length && !view.pending.length && !visibleError) return null;
  const locked = busy || !!view.error;
  const renderPreview = (text: string) => <OverflowText data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="preview"
    behavior="fade" data-overflow-trigger tabIndex={0}>{text}</OverflowText>;
  const renderItem = (item: QueueItem) => {
    const steering = item.status === 'steering_pending';
    const blocked = item.status === 'blocked';
    return <ChatComposerQueueItem data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="item" key={item.turnId} {...reorder.rowProps(item.turnId)}
      leadingControl={item.status === 'queued' && view.snapshot?.supportsReorder ? <IconButton variant="annotation" size="xs"
        aria-label={t('pendingQueue.reorder')} title={t('pendingQueue.reorder')} icon={<Icon glyph={GripVertical} size="sm" />} {...reorder.handleProps(item.turnId)} /> : undefined}
      leadingIcon={<Icon glyph={ListEnd} size="sm" />} state={blocked ? 'failed' : steering ? 'sending' : 'default'}>
      <ChatComposerQueueItemContent data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="content">
        <ChatComposerQueueItemMessage>
          {renderPreview(item.displayContent || t('pendingQueue.emptyPlaceholder'))}
          <ChatComposerQueueAttachmentBadge count={item.attachmentCount} icon={<Icon glyph={Paperclip} size="sm" />}
            label={t('hostQueue.attachments', { count: item.attachmentCount })} />
        </ChatComposerQueueItemMessage>
        {(blocked || steering) && <ChatComposerQueueItemStatus data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" tone={blocked ? 'warning' : 'neutral'}>
          {blocked ? t('hostQueue.blocked') : t('hostQueue.steeringPending')}
        </ChatComposerQueueItemStatus>}
        {item.reason && <ChatComposerQueueItemStatus data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" tone={blocked ? 'warning' : 'neutral'}>{item.reason}</ChatComposerQueueItemStatus>}
      </ChatComposerQueueItemContent>
      <ChatComposerQueueItemActions data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="actions">
        <PendingQueueMessageActions sendLabel={t('hostQueue.sendNow')} sendDisabled={locked || steering}
          onSend={() => void run(() => queue.act(item, 'promote'))}
          editLabel={t('hostQueue.edit')} editDisabled={locked || steering} onEdit={() => void run(async () => {
            const saved = await queue.savedDraft(item.turnId);
            if (!saved || saved.request.action !== 'submit') throw new Error(t('hostQueue.noDraft'));
            await restoreDraft(saved, item);
          })}
          removeLabel={t('hostQueue.cancel')} removeDisabled={locked || steering}
          onRemove={() => void run(() => queue.act(item, 'cancel'))}
          onMoveUp={view.snapshot?.supportsReorder && item.status === 'queued' ? () => void run(() => queue.reorder(item.turnId, reorderIds[reorderIds.indexOf(item.turnId) - 1])) : undefined}
          onMoveDown={view.snapshot?.supportsReorder && item.status === 'queued' ? () => void run(() => queue.reorder(item.turnId, reorderIds[reorderIds.indexOf(item.turnId) + 2] ?? null)) : undefined}
          moveUpDisabled={locked || reorderIds.indexOf(item.turnId) <= 0}
          moveDownDisabled={locked || reorderIds.indexOf(item.turnId) === reorderIds.length - 1}
          onCollapse={expanded ? toggle : undefined} onAbout={() => setShowHelp(value => !value)} />
      </ChatComposerQueueItemActions>
    </ChatComposerQueueItem>;
  };
  const renderPending = (record: QueueOutboxRecord) => {
    const message = record.request.action === 'submit' ? record.request.message : null;
    return <ChatComposerQueueItem data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="item" key={record.key} leadingIcon={<Icon glyph={ListEnd} size="sm" />} state="failed">
      <ChatComposerQueueItemContent data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="content">
        {message && <ChatComposerQueueItemMessage>{renderPreview(message.displayContent ?? message.content)}</ChatComposerQueueItemMessage>}
        <ChatComposerQueueItemStatus data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" tone="warning">{t('hostQueue.unknown')}</ChatComposerQueueItemStatus>
      </ChatComposerQueueItemContent>
      <ChatComposerQueueItemActions data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="actions">
        <Tooltip content={t(record.restoreIntent && message ? 'hostQueue.edit' : 'hostQueue.checkRetry')}>
          <Button data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="action"
            variant="text" size="xs" labelBehavior="static" disabled={busy}
            aria-label={t(record.restoreIntent && message ? 'hostQueue.edit' : 'hostQueue.checkRetry')}
            leadingIcon={record.restoreIntent && message ? <Icon name="edit" size="sm" /> : <Icon glyph={RotateCw} size="sm" />}
            onClick={() => void run(() => record.restoreIntent && message ? restoreDraft(record) : queue.retry(record))}>
            {t(record.restoreIntent && message ? 'hostQueue.edit' : 'hostQueue.retry')}
          </Button>
        </Tooltip>
        {message && <QueueAction label={t('hostQueue.copyDraft')} icon={<Icon name="duplicate" size="sm" />} disabled={busy} onClick={() => {
          const cache = record.draft as Partial<QueuedMessage> | undefined;
          // Copy locally even after an owner restart. Keep the unresolved
          // receipt: copying is neither a cancellation nor a resend.
          onRestore({ ...cache, id: message.turnId, sessionId: queue.sessionId,
            content: message.content, displayMessage: message.displayContent,
            agentType: message.agentType, timestamp: cache?.timestamp ?? Date.now(),
            status: 'queued', retryCount: cache?.retryCount ?? 0,
            userMessageMetadata: message.metadata });
        }} />}
        <QueueAction label={t('hostQueue.dismiss')} icon={<Icon name="xmark" size="sm" />} disabled={busy} onClick={() => void run(() => queue.dismiss(record))} />
      </ChatComposerQueueItemActions>
    </ChatComposerQueueItem>;
  };
  // Collapsing hides the controlled list. Rows that still need a decision
  // (blocked or unconfirmed) move to a recovery list outside the disclosure.
  const recoveryItems = expanded ? [] : items.filter(item => item.status === 'blocked');
  const recoveryPending = expanded ? [] : view.pending;
  return <ChatComposerQueue data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="root" className="host-pending-queue" aria-label={t('pendingQueue.label', { count: items.length + view.pending.length })}>
    {(!expanded || items.length === 0) && <ChatComposerQueueHeader data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="header">
      <ChatComposerQueueToggle ref={toggleRef} className="host-pending-queue__toggle" expanded={expanded} aria-controls={listId}
        onClick={toggle}>
        <ChatComposerQueueTitle data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="title" count={items.length + view.pending.length}>{t('hostQueue.title')}</ChatComposerQueueTitle>
      </ChatComposerQueueToggle>
      <Tooltip content={t('hostQueue.about')}><IconButton size="xs" variant="annotation" aria-label={t('hostQueue.about')} aria-expanded={showHelp}
        icon={<Icon name="info" />} onClick={() => setShowHelp(value => !value)} /></Tooltip>
    </ChatComposerQueueHeader>}
    {showHelp && <p data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" className="host-pending-queue__note">{t('hostQueue.memoryNotice')}{!view.snapshot?.supportsReorder && ` ${t('pendingQueue.reorderUnsupported')}`}</p>}
    {visibleError && <div data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" role="alert" className="host-pending-queue__error">
      <span className="host-pending-queue__error-text">{visibleError}</span>
      <Button size="xs" variant="text" disabled={busy} onClick={() => void run(() => queue.refresh())}>{t('hostQueue.refresh')}</Button>
    </div>}
    <ChatComposerQueueList data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="list" ref={listRef} id={listId} hidden={!expanded}>
      {expanded && <>{items.map(renderItem)}{view.pending.map(renderPending)}</>}
    </ChatComposerQueueList>
    {(recoveryItems.length > 0 || recoveryPending.length > 0) && <ChatComposerQueueList data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="list">
      {recoveryItems.map(renderItem)}{recoveryPending.map(renderPending)}
    </ChatComposerQueueList>}
  </ChatComposerQueue>;
}
