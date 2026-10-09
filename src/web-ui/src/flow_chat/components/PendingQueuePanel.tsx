import { HostPendingQueuePanel } from './HostPendingQueuePanel';
import { hostQueueSupported, hostDialogQueue } from '../services/hostDialogQueue';
import { getActiveSurfaceScope, isSurfaceChangedError, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
/**
 * Pending queue panel
 *
 * Renders the per-session list of "queued" user messages above the chat input.
 * Each row supports restoring its draft to ChatInput, optional "send now"
 * (mid-turn steering), and delete.
 *
 * UX notes:
 * - Message content is display-only; editing starts only from the edit action.
 * - ChatInput owns restoration and overwrite protection. The queue item is
 *   removed only after ChatInput accepts the draft.
 * - Clicking "send now" eagerly inserts a steering message into the live round
 *   so the user sees feedback instantly; the backend confirmation event is
 *   deduped via `steeringId`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ListEnd } from 'lucide-react';
import { OverflowText, Tooltip } from '@openbitfun/ui';
import { stateMachineManager } from '../state-machine';
import { FlowChatStore } from '../store/FlowChatStore';
import { pendingQueueManager } from '../services/flow-chat-manager/PendingQueueModule';
import { FlowChatManager } from '../services/FlowChatManager';
import { interruptedTurnRecoveryGate } from '../services/interruptedTurnRecoveryGate';
import { submitSteeringMessage } from '../services/steeringSubmission';
import { notificationService } from '../../shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import type { QueuedMessage, SteeringImage } from '../types/flow-chat';
import { isAcpFlowSession } from '../utils/acpSession';
import { getQueuedMessageAttachmentCount } from '../utils/pendingQueuePresentation';
import './PendingQueuePanel.scss';
import { IconButton, Icon } from '@openbitfun/ui';
import {
  ChatComposerQueue,
  ChatComposerQueueAttachmentBadge,
  ChatComposerQueueHeader,
  ChatComposerQueueItem,
  ChatComposerQueueItemActions,
  ChatComposerQueueItemContent,
  ChatComposerQueueList,
  ChatComposerQueueTitle,
  type ChatComposerQueueItemState,
} from '@openbitfun/ui/flow-chat';

const log = createLogger('PendingQueuePanel');

interface PendingQueuePanelProps {
  sessionId: string | undefined;
  className?: string;
  onRestoreToComposer: (item: QueuedMessage) => boolean;
}

function LegacyPendingQueuePanel({
  sessionId,
  className,
  onRestoreToComposer,
}: PendingQueuePanelProps): JSX.Element | null {
  const { t } = useTranslation('flow-chat');
  const sendNowInFlightIdsRef = useRef(new Set<string>());
  useSyncExternalStore(
    interruptedTurnRecoveryGate.subscribe,
    interruptedTurnRecoveryGate.getSnapshot,
    interruptedTurnRecoveryGate.getSnapshot,
  );
  const recoveryInFlight = interruptedTurnRecoveryGate.isSessionInFlight(sessionId);
  const [items, setItems] = useState<QueuedMessage[]>(() =>
    sessionId ? pendingQueueManager.list(sessionId) : [],
  );
  const [isAcpSession, setIsAcpSession] = useState<boolean>(() => {
    if (!sessionId) return false;
    return isAcpFlowSession(FlowChatStore.getInstance().getState().sessions.get(sessionId));
  });
  useEffect(() => {
    if (!sessionId) {
      setItems([]);
      return;
    }
    setItems(pendingQueueManager.list(sessionId));
    const unsubscribe = pendingQueueManager.subscribe((sid, snapshot) => {
      if (sid === sessionId) setItems(snapshot);
    });
    return unsubscribe;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setIsAcpSession(false);
      return;
    }

    const store = FlowChatStore.getInstance();
    const sync = () => {
      setIsAcpSession(isAcpFlowSession(store.getState().sessions.get(sessionId)));
    };

    sync();
    const unsubscribe = store.subscribe(sync);
    return unsubscribe;
  }, [sessionId]);

  const handleRestoreToComposer = useCallback(
    (item: QueuedMessage) => {
      if (!sessionId) return;
      if (onRestoreToComposer(item)) {
        pendingQueueManager.remove(sessionId, item.id);
      }
    },
    [onRestoreToComposer, sessionId],
  );

  const handleDelete = useCallback(
    (item: QueuedMessage) => {
      if (!sessionId) return;
      pendingQueueManager.remove(sessionId, item.id);
    },
    [sessionId],
  );

  const handleSendNow = useCallback(
    async (item: QueuedMessage) => {
      if (!sessionId || recoveryInFlight) return;
      if (sendNowInFlightIdsRef.current.has(item.id)) return;
      sendNowInFlightIdsRef.current.add(item.id);
      const surfaceScope = getActiveSurfaceScope();

      try {
        const machine = stateMachineManager.get(sessionId);
        const dialogTurnId = machine?.getContext().currentDialogTurnId ?? null;

        // A running turn takes the message through the steering channel, which
        // carries the whole payload — text, attachments and metadata alike.
        // ACP agents own their execution loop and expose no mid-turn injection
        // point, so they take the drain path below instead.
        if (dialogTurnId && !isAcpSession) {
          pendingQueueManager.setStatus(sessionId, item.id, 'sending_now');
          try {
            await submitSteeringMessage({
              sessionId,
              dialogTurnId,
              content: item.content,
              displayContent: item.displayMessage ?? item.content,
              imageContexts: item.imageContexts,
              userMessageMetadata: item.userMessageMetadata,
            }, item.imageDisplayData as SteeringImage[] | undefined);
            pendingQueueManager.remove(sessionId, item.id);
            return;
          } catch (err) {
            if (isSurfaceChangedError(err)) return;
            // Most often the turn finished between the click and the request.
            // Fall through to the drain path rather than reporting a failure the
            // user cannot act on.
            log.warn('Steering rejected, falling back to the drain path', {
              sessionId,
              itemId: item.id,
              err,
            });
            pendingQueueManager.setStatus(sessionId, item.id, 'queued');
          }
        }

        // No turn to inject into. Move the item to the head and send it at the
        // first opportunity: right now if the session is idle, otherwise the
        // IDLE drain listener picks it up the moment the current turn ends.
        try {
          surfaceScope.assertCurrent('promote queued message');
          if (!pendingQueueManager.promoteForExplicitDrain(sessionId, item.id)) {
            log.warn('Send now item is no longer queued', { sessionId, itemId: item.id });
            return;
          }
          await FlowChatManager.getInstance().drainPendingQueueForSession(sessionId, {
            allowInterruptedRecoveryAbandon: true,
          });
        } catch (err) {
          log.error('Send now fallback failed', { sessionId, itemId: item.id, err });
          notificationService.error(t('pendingQueue.errors.sendNowFailed'), { duration: 4000 });
        }
      } finally {
        sendNowInFlightIdsRef.current.delete(item.id);
      }
    },
    [isAcpSession, recoveryInFlight, sessionId, t],
  );

  const visibleItems = useMemo(() => items, [items]);

  if (!sessionId || visibleItems.length === 0) {
    return null;
  }

  return (
    <ChatComposerQueue data-overflow-trigger
      aria-label={t('pendingQueue.label', { count: visibleItems.length })}
      className={`openbitfun-pending-queue-panel ${className ?? ''}`.trim()}
      data-openbitfun-product-component="pending-queue-panel"
      data-openbitfun-product-part="root"
      data-testid="pending-queue-panel"
      onClick={e => {
        e.stopPropagation();
      }}
    >
      <ChatComposerQueueHeader
        data-openbitfun-product-component="pending-queue-panel"
        data-openbitfun-product-part="header"
      >
        <Icon glyph={ListEnd} size="sm" aria-hidden="true" />
        <ChatComposerQueueTitle
          count={visibleItems.length}
          data-openbitfun-product-component="pending-queue-panel"
          data-openbitfun-product-part="title"
        >
          {t('pendingQueue.title')}
        </ChatComposerQueueTitle>
      </ChatComposerQueueHeader>
      <ChatComposerQueueList
        data-openbitfun-product-component="pending-queue-panel"
        data-openbitfun-product-part="list"
      >
        {visibleItems.map(item => {
          const isSendingNow = item.status === 'sending_now';
          const isSending = item.status === 'sending' || isSendingNow;
          const isFailed = item.status === 'failed' || (item.retryCount ?? 0) > 0;
          const previewText = item.displayMessage ?? item.content;
          const attachmentCount = getQueuedMessageAttachmentCount(item);
          const itemState: ChatComposerQueueItemState = isSending
            ? 'sending'
            : isFailed
              ? 'failed'
              : 'default';
          const itemClass = [
            'openbitfun-pending-queue-panel__item',
            isSending && 'openbitfun-pending-queue-panel__item--sending',
            isFailed && 'openbitfun-pending-queue-panel__item--failed',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <ChatComposerQueueItem
              className={itemClass}
              data-openbitfun-product-component="pending-queue-panel"
              data-openbitfun-product-part="item"
              data-openbitfun-state={itemState === 'default' ? undefined : itemState}
              key={item.id}
              state={itemState}
            >
              <ChatComposerQueueItemContent
                className="openbitfun-pending-queue-panel__content"
                data-openbitfun-product-component="pending-queue-panel"
                data-openbitfun-product-part="content"
              >
                {isSendingNow ? (
                  <>
                    <div
                      className="openbitfun-pending-queue-panel__preview"
                      data-openbitfun-product-component="pending-queue-panel"
                      data-openbitfun-product-part="preview"
                      title={previewText}
                    ><OverflowText behavior="marquee">
                      {previewText || (
                        <span className="openbitfun-pending-queue-panel__preview-empty">
                          {t('pendingQueue.emptyPlaceholder')}
                        </span>
                      )}
                    </OverflowText></div>
                    <div
                      className="openbitfun-pending-queue-panel__sending-label"
                      data-openbitfun-product-component="pending-queue-panel"
                      data-openbitfun-product-part="status"
                    >
                      {t('pendingQueue.statusSending')}
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="openbitfun-pending-queue-panel__preview"
                      data-openbitfun-product-component="pending-queue-panel"
                      data-openbitfun-product-part="preview"
                      title={previewText}
                    ><OverflowText behavior="marquee">
                      {previewText || (
                        <span className="openbitfun-pending-queue-panel__preview-empty">
                          {t('pendingQueue.emptyPlaceholder')}
                        </span>
                      )}
                    </OverflowText></div>
                    {isFailed && (
                      <div
                        className="openbitfun-pending-queue-panel__failed-label"
                        data-openbitfun-product-component="pending-queue-panel"
                        data-openbitfun-product-part="status"
                      >
                        {t('pendingQueue.statusFailed')}
                      </div>
                    )}
                  </>
                )}
              </ChatComposerQueueItemContent>

              {attachmentCount > 0 ? (
                <ChatComposerQueueAttachmentBadge
                  count={attachmentCount}
                  label={t('pendingQueue.attachmentCount', { count: attachmentCount })}
                />
              ) : null}

              <ChatComposerQueueItemActions
                className="openbitfun-pending-queue-panel__actions"
                data-openbitfun-product-component="pending-queue-panel"
                data-openbitfun-product-part="actions"
              >
                <Tooltip content={t('pendingQueue.tooltip.sendNow')}>
                  <IconButton
                    aria-label={t('pendingQueue.actions.sendNow')}
                    className="openbitfun-pending-queue-panel__btn"
                    data-openbitfun-product-component="pending-queue-panel"
                    data-openbitfun-product-part="action"
                    disabled={isSending || recoveryInFlight}
                    icon={<Icon name="arrow-up" size="lg" />}
                    loading={isSendingNow}
                    size="xs"
                    onClick={() => {
                      void handleSendNow(item);
                    }}
                  />
                </Tooltip>
                <Tooltip content={t('pendingQueue.actions.delete')}>
                  <IconButton
                    aria-label={t('pendingQueue.actions.delete')}
                    className="openbitfun-pending-queue-panel__btn openbitfun-pending-queue-panel__btn--danger"
                    data-openbitfun-product-component="pending-queue-panel"
                    data-openbitfun-product-part="action"
                    disabled={isSending}
                    icon={<Icon name="delete" size="lg" />}
                    size="xs"
                    onClick={() => handleDelete(item)}
                  />
                </Tooltip>
                <Tooltip content={t('pendingQueue.actions.edit')}>
                  <IconButton
                    aria-label={t('pendingQueue.actions.edit')}
                    className="openbitfun-pending-queue-panel__btn"
                    data-openbitfun-product-component="pending-queue-panel"
                    data-openbitfun-product-part="action"
                    disabled={isSending}
                    icon={<Icon name="edit" size="lg" />}
                    size="xs"
                    onClick={() => handleRestoreToComposer(item)}
                  />
                </Tooltip>
              </ChatComposerQueueItemActions>
            </ChatComposerQueueItem>
          );
        })}
      </ChatComposerQueueList>
    </ChatComposerQueue>
  );
}

export default PendingQueuePanel;


export function PendingQueuePanel(props: PendingQueuePanelProps): JSX.Element | null {
  const [, setRevision] = useState(0);
  useEffect(() => onSurfaceActivated(() => setRevision(value => value + 1)), []);
  const supported = props.sessionId && hostQueueSupported(props.sessionId);
  const scope = getActiveSurfaceScope();
  const { t } = useTranslation('flow-chat');
  return <>
    {supported && props.sessionId && pendingQueueManager.list(props.sessionId).length > 0 && <p>{t('hostQueue.legacy')}</p>}
    {supported && props.sessionId && <HostPendingQueuePanel key={`${scope.surfaceId}:${scope.epoch}:${props.sessionId}`} queue={hostDialogQueue(props.sessionId)} onRestore={props.onRestoreToComposer} />}
    <LegacyPendingQueuePanel {...props} />
  </>;
}
