import React, { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { MobileButton, MobileBanner, MobileIconButton, MobileSheet } from '@openbitfun/ui/mobile';
import { HostDialogQueue, observeHostQueue } from '../../../shared/dialog-queue/HostDialogQueue';
import { useQueueReorder } from '@openbitfun/ui/flow-chat';
import { useI18n } from '../i18n';
import { ArrowUp, ArrowDown, CornerDownRight, GripVertical, MoreHorizontal, Paperclip, Trash2, ChevronDown, ChevronUp, Info } from 'lucide-react';
import '../styles/host-queue.scss';

export function MobileHostQueue({ queue, onRestore }: { queue: HostDialogQueue; onRestore: (text: string) => void }) {
  const { t } = useI18n();
  const view = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [expanded, setExpanded] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const listId = useId();
  const helpId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => observeHostQueue(queue), [queue]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const items = view.snapshot?.items ?? [];
  const reorderIds = items.filter(item => item.status === 'queued').map(item => item.turnId);
  const reorderEnabled = !busy && !view.error && view.snapshot?.supportsReorder === true;
  const reorder = useQueueReorder(reorderIds, reorderEnabled, `${view.snapshot?.queueEpoch}:${view.snapshot?.revision}`,
    (id, before) => void run(() => queue.reorder(id, before)));
  const selected = items.find(item => item.turnId === selectedId);
  const selectedIndex = selected ? reorderIds.indexOf(selected.turnId) : -1;
  const rawError = error || view.error;
  const visibleError = rawError?.includes('queue_conflict:') ? t('queue.orderChanged') : rawError;
  const count = (view.snapshot?.items.length ?? 0) + view.pending.length;
  if (!view.snapshot?.items.length && !view.pending.length && !view.error && !error) return null;
  return <section className="host-message-queue" aria-label={t('queue.title')}>
    <div className="host-message-queue__header">
      <MobileButton appearance="plain" size="sm" className="host-message-queue__toggle" aria-expanded={expanded} aria-controls={listId}
        onClick={() => setExpanded(value => !value)}>
        <span>{t('queue.title')}</span>
        <span className="host-message-queue__count">{t('common.itemCount', { count })}</span>
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
      </MobileButton>
      <MobileIconButton appearance="plain" size="sm" className="host-message-queue__icon" aria-label={t('queue.about')} aria-expanded={showHelp} aria-controls={helpId}
        icon={<Info size={16} aria-hidden="true" />} onClick={() => setShowHelp(value => !value)} />
    </div>
    <div className="host-message-queue__body">
      {showHelp && <p id={helpId} className="host-message-queue__help">{t('queue.memoryNotice')}{!view.snapshot?.supportsReorder && ` ${t('queue.reorderUnsupported')}`}</p>}
      {visibleError && <MobileBanner tone="danger" role="alert">{visibleError}</MobileBanner>}
      {(error || view.error) && <MobileButton appearance="plain" size="sm" disabled={busy} onClick={() => void run(() => queue.refresh())}>{t('queue.refresh')}</MobileButton>}
      <ul id={listId} hidden={!expanded && !items.some(item => item.status === 'blocked') && !view.pending.length} className="host-message-queue__list">
        {items.filter(item => expanded || item.status === 'blocked').map(item => <li key={item.turnId} className="host-message-queue__row" {...reorder.rowProps(item.turnId)}>
          {item.status === 'queued' && view.snapshot?.supportsReorder && <MobileIconButton appearance="plain" size="sm" className="host-message-queue__handle"
            aria-label={t('queue.reorder')} icon={<GripVertical size={16} aria-hidden="true" />} {...reorder.handleProps(item.turnId)} />}
          <div className="host-message-queue__message">
            <div className="host-message-queue__line"><p className="host-message-queue__preview">{item.displayContent}</p>
              {item.attachmentCount > 0 && <span className="host-message-queue__attachments" aria-label={t('queue.attachments', { count: item.attachmentCount })}>
                <Paperclip size={14} aria-hidden="true" />{item.attachmentCount}</span>}
            </div>
            {item.status !== 'queued' && <span className="host-message-queue__status">{item.status === 'steering_pending' ? t('queue.steeringPending') : t('queue.blocked')}</span>}
            {item.reason && <p>{item.reason}</p>}
          </div>
          <div className="host-message-queue__actions">
            <MobileIconButton appearance="plain" size="sm" className="host-message-queue__icon" aria-label={t('queue.sendNow')} title={t('queue.sendNow')} disabled={busy || !!view.error || item.status === 'steering_pending'} icon={<CornerDownRight size={16} aria-hidden="true" />} onClick={() => void run(() => queue.act(item, 'promote'))} />
            <MobileIconButton appearance="plain" size="sm" className="host-message-queue__icon" aria-label={t('common.more')} icon={<MoreHorizontal size={16} aria-hidden="true" />} onClick={() => setSelectedId(item.turnId)} />
          </div>
        </li>)}
        {view.pending.map(record => <li key={record.key} className="host-message-queue__recovery">
          <p>{t('queue.unknown')}</p>
          {record.request.action === 'submit' && <p className="host-message-queue__preview">{record.request.message.displayContent ?? record.request.message.content}</p>}
          <div className="host-message-queue__actions">
            <MobileButton appearance="plain" size="sm" disabled={busy} onClick={() => void run(() => queue.retry(record))}>{t('queue.checkRetry')}</MobileButton>
            {record.request.action === 'submit' && <MobileButton appearance="plain" size="sm" disabled={busy} onClick={() => {
              if (record.request.action === 'submit') onRestore(record.request.message.content);
            }}>{t('queue.copyDraft')}</MobileButton>}
            <MobileButton appearance="plain" size="sm" disabled={busy} onClick={() => void run(() => queue.dismiss(record))}>{t('queue.dismiss')}</MobileButton>
          </div>
        </li>)}
      </ul>
    </div>
    <MobileSheet open={!!selected} title={t('queue.title')} onOpenChange={open => { if (!open) setSelectedId(null); }}>
      {selected && <>
        <p className="host-message-queue__full-preview">{selected.displayContent}</p>
        {!view.snapshot?.supportsReorder && <p>{t('queue.reorderUnsupported')}</p>}
        <div className="host-message-queue__sheet-actions">
          <MobileButton appearance="plain" disabled={busy || !!view.error || selected.status === 'steering_pending'} onClick={() => void run(() => queue.act(selected, 'cancel'))}><Trash2 size={16} />{t('queue.cancel')}</MobileButton>
          <MobileButton appearance="plain" disabled={!reorderEnabled || selectedIndex <= 0} onClick={() => void run(() => queue.reorder(selected.turnId, reorderIds[selectedIndex - 1]))}><ArrowUp size={16} />{t('queue.moveUp')}</MobileButton>
          <MobileButton appearance="plain" disabled={!reorderEnabled || selectedIndex < 0 || selectedIndex === reorderIds.length - 1} onClick={() => void run(() => queue.reorder(selected.turnId, reorderIds[selectedIndex + 2] ?? null))}><ArrowDown size={16} />{t('queue.moveDown')}</MobileButton>
        </div>
      </>}
    </MobileSheet>
  </section>;
}
