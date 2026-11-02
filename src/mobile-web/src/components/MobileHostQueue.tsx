import React, { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { MobileButton, MobileBanner, MobileIconButton } from '@openbitfun/ui/mobile';
import { HostDialogQueue, observeHostQueue } from '../../../shared/dialog-queue/HostDialogQueue';
import { useI18n } from '../i18n';
import { ArrowUp, ChevronDown, ChevronUp, Info, X } from 'lucide-react';
import '../styles/host-queue.scss';

export function MobileHostQueue({ queue, onRestore }: { queue: HostDialogQueue; onRestore: (text: string) => void }) {
  const { t } = useI18n();
  const view = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [expanded, setExpanded] = useState(true);
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
      {showHelp && <p id={helpId} className="host-message-queue__help">{t('queue.memoryNotice')}</p>}
      {(error || view.error) && <MobileBanner tone="danger" role="alert">{error || view.error}</MobileBanner>}
      {(error || view.error) && <MobileButton appearance="plain" size="sm" disabled={busy} onClick={() => void run(() => queue.refresh())}>{t('queue.refresh')}</MobileButton>}
      <ul id={listId} hidden={!expanded} className="host-message-queue__list">
        {view.snapshot?.items.map(item => <li key={item.turnId} className="host-message-queue__row">
          <div className="host-message-queue__message">
            <p className="host-message-queue__preview">{item.displayContent}</p>
            {item.status !== 'queued' && <span className="host-message-queue__status">{item.status === 'steering_pending' ? t('queue.steeringPending') : t('queue.blocked')}</span>}
            {item.attachmentCount > 0 && <span>{t('queue.attachments', { count: item.attachmentCount })}</span>}
            {item.reason && <p>{item.reason}</p>}
          </div>
          <div className="host-message-queue__actions">
            <MobileIconButton appearance="plain" size="sm" className="host-message-queue__icon" aria-label={t('queue.sendNow')} title={t('queue.sendNow')} disabled={busy || !!view.error || item.status === 'steering_pending'} icon={<ArrowUp size={16} aria-hidden="true" />} onClick={() => void run(() => queue.act(item, 'promote'))} />
            <MobileIconButton appearance="plain" size="sm" className="host-message-queue__icon" aria-label={t('queue.cancel')} title={t('queue.cancel')} disabled={busy || !!view.error || item.status === 'steering_pending'} icon={<X size={16} aria-hidden="true" />} onClick={() => void run(() => queue.act(item, 'cancel'))} />
          </div>
        </li>)}
        {view.pending.map(record => <li key={record.key}>
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
  </section>;
}
