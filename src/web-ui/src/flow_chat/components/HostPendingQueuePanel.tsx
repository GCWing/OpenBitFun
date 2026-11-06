import { pendingQueueManager } from '../services/flow-chat-manager/PendingQueueModule';
import type { QueuedMessage } from '../types/flow-chat';
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { Button, Icon, IconButton, OverflowText, Tooltip } from '@openbitfun/ui';
import { Paperclip, RotateCw } from 'lucide-react';
import './HostPendingQueuePanel.scss';
import { hostQueuePresentation, observePresentedHostQueue } from '../services/hostQueuePresentation';
import { HostDialogQueue, type QueueOutboxRecord, type QueueItem } from '../../../../shared/dialog-queue/HostDialogQueue';
import {
  ChatComposerQueue, ChatComposerQueueHeader, ChatComposerQueueTitle, ChatComposerQueueToggle,
  ChatComposerQueueList, ChatComposerQueueItem, ChatComposerQueueItemContent, ChatComposerQueueItemActions,
  ChatComposerQueueItemStatus, ChatComposerQueueAttachmentBadge,
} from '@openbitfun/ui/flow-chat';

function QueueAction({ label, icon, disabled, onClick }: { label: string; icon: ReactNode; disabled: boolean; onClick: () => void }) {
  return <Tooltip content={label}>
    <IconButton data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="action" size="xs" aria-label={label} icon={icon} disabled={disabled} onClick={onClick} />
  </Tooltip>;
}

export function HostPendingQueuePanel({ queue, onRestore }: { queue: HostDialogQueue; onRestore: (item: QueuedMessage) => boolean }) {
  const { t } = useI18n('flow-chat');
  const view = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const presentation = hostQueuePresentation(queue);
  const projected = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot, presentation.getSnapshot);
  const [expanded, setExpanded] = useState(true);
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
  const visibleError = error || (view.error?.includes('Session is not loaded') ? null : view.error);
  if (!items.length && !view.pending.length && !visibleError) return null;
  const locked = busy || !!view.error;
  const renderPreview = (text: string) => <OverflowText data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="preview"
    behavior="fade" data-overflow-trigger tabIndex={0}>{text}</OverflowText>;
  const renderItem = (item: QueueItem) => {
    const steering = item.status === 'steering_pending';
    const blocked = item.status === 'blocked';
    return <ChatComposerQueueItem data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="item" key={item.turnId}
      state={blocked ? 'failed' : steering ? 'sending' : 'default'}>
      <ChatComposerQueueItemContent data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="content">
        {renderPreview(item.displayContent || t('pendingQueue.emptyPlaceholder'))}
        {(blocked || steering) && <ChatComposerQueueItemStatus data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" tone={blocked ? 'warning' : 'neutral'}>
          {blocked ? t('hostQueue.blocked') : t('hostQueue.steeringPending')}
        </ChatComposerQueueItemStatus>}
        {item.reason && <ChatComposerQueueItemStatus data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" tone={blocked ? 'warning' : 'neutral'}>{item.reason}</ChatComposerQueueItemStatus>}
      </ChatComposerQueueItemContent>
      <ChatComposerQueueAttachmentBadge count={item.attachmentCount} icon={<Icon glyph={Paperclip} size="xs" />}
        label={t('hostQueue.attachments', { count: item.attachmentCount })} />
      <ChatComposerQueueItemActions data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="actions">
        <QueueAction label={t('hostQueue.edit')} icon={<Icon name="edit" />} disabled={locked || steering} onClick={() => void run(async () => {
          const saved = await queue.savedDraft(item.turnId);
          if (!saved || saved.request.action !== 'submit') throw new Error(t('hostQueue.noDraft'));
          await restoreDraft(saved, item);
        })} />
        <QueueAction label={t('hostQueue.sendNow')} icon={<Icon name="arrow-up" />} disabled={locked || steering} onClick={() => void run(() => queue.act(item, 'promote'))} />
        <QueueAction label={t('hostQueue.cancel')} icon={<Icon name="xmark" />} disabled={locked || steering} onClick={() => void run(() => queue.act(item, 'cancel'))} />
      </ChatComposerQueueItemActions>
    </ChatComposerQueueItem>;
  };
  const renderPending = (record: QueueOutboxRecord) => {
    const message = record.request.action === 'submit' ? record.request.message : null;
    return <ChatComposerQueueItem data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="item" key={record.key} state="failed">
      <ChatComposerQueueItemContent data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="content">
        {message && renderPreview(message.displayContent ?? message.content)}
        <ChatComposerQueueItemStatus data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" tone="warning">{t('hostQueue.unknown')}</ChatComposerQueueItemStatus>
      </ChatComposerQueueItemContent>
      <ChatComposerQueueItemActions data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="actions">
        {record.restoreIntent && message
          ? <QueueAction label={t('hostQueue.edit')} icon={<Icon name="edit" />} disabled={busy} onClick={() => void run(() => restoreDraft(record))} />
          : <QueueAction label={t('hostQueue.checkRetry')} icon={<Icon glyph={RotateCw} />} disabled={busy} onClick={() => void run(() => queue.retry(record))} />}
        {message && <QueueAction label={t('hostQueue.copyDraft')} icon={<Icon name="duplicate" />} disabled={busy} onClick={() => {
          const cache = record.draft as Partial<QueuedMessage> | undefined;
          // Copy locally even after an owner restart. Keep the unresolved
          // receipt: copying is neither a cancellation nor a resend.
          onRestore({ ...cache, id: message.turnId, sessionId: queue.sessionId,
            content: message.content, displayMessage: message.displayContent,
            agentType: message.agentType, timestamp: cache?.timestamp ?? Date.now(),
            status: 'queued', retryCount: cache?.retryCount ?? 0,
            userMessageMetadata: message.metadata });
        }} />}
        <QueueAction label={t('hostQueue.dismiss')} icon={<Icon name="xmark" />} disabled={busy} onClick={() => void run(() => queue.dismiss(record))} />
      </ChatComposerQueueItemActions>
    </ChatComposerQueueItem>;
  };
  // Collapsing hides the controlled list. Rows that still need a decision
  // (blocked or unconfirmed) move to a recovery list outside the disclosure.
  const recoveryItems = expanded ? [] : items.filter(item => item.status === 'blocked');
  const recoveryPending = expanded ? [] : view.pending;
  return <ChatComposerQueue data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="root" className="host-pending-queue" aria-label={t('hostQueue.title')}>
    <ChatComposerQueueHeader data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="header">
      <ChatComposerQueueToggle className="host-pending-queue__toggle" expanded={expanded} aria-controls={listId}
        onClick={() => setExpanded(value => !value)}>
        <ChatComposerQueueTitle data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="title" count={items.length + view.pending.length}>{t('hostQueue.title')}</ChatComposerQueueTitle>
      </ChatComposerQueueToggle>
      <Tooltip content={t('hostQueue.about')}><IconButton size="xs" variant="annotation" aria-label={t('hostQueue.about')} aria-expanded={showHelp}
        icon={<Icon name="info" />} onClick={() => setShowHelp(value => !value)} /></Tooltip>
    </ChatComposerQueueHeader>
    {showHelp && <p data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" className="host-pending-queue__note">{t('hostQueue.memoryNotice')}</p>}
    {visibleError && <div data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status" role="alert" className="host-pending-queue__error">
      <span className="host-pending-queue__error-text">{visibleError}</span>
      <Button size="xs" variant="text" disabled={busy} onClick={() => void run(() => queue.refresh())}>{t('hostQueue.refresh')}</Button>
    </div>}
    <ChatComposerQueueList data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="list" id={listId} hidden={!expanded}>
      {expanded && <>{items.map(renderItem)}{view.pending.map(renderPending)}</>}
    </ChatComposerQueueList>
    {(recoveryItems.length > 0 || recoveryPending.length > 0) && <ChatComposerQueueList data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="list">
      {recoveryItems.map(renderItem)}{recoveryPending.map(renderPending)}
    </ChatComposerQueueList>}
  </ChatComposerQueue>;
}
