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

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, ListEnd, Paperclip } from 'lucide-react';
import { IconButton, OverflowText } from '@openbitfun/ui';
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
import { useQueueReorder } from '@openbitfun/ui/flow-chat';
import { PendingQueueMessageActions } from './PendingQueueMessageActions';
import { usePendingQueueDisclosure } from './usePendingQueueDisclosure';
import { Icon } from '@openbitfun/ui';
import {
  ChatComposerQueue,
  ChatComposerQueueAttachmentBadge,
  ChatComposerQueueHeader,
  ChatComposerQueueItem,
  ChatComposerQueueItemActions,
  ChatComposerQueueItemContent,
  ChatComposerQueueItemMessage,
  ChatComposerQueueItemStatus,
  ChatComposerQueueList,
  ChatComposerQueueTitle,
  ChatComposerQueueToggle,
  type ChatComposerQueueItemState,
} from '@openbitfun/ui/flow-chat';

const log = createLogger('PendingQueuePanel');

interface PendingQueuePanelProps {
  sessionId: string | undefined;
  className?: string;
  onRestoreToComposer: (item: QueuedMessage) => boolean;
}

function isSendingQueuedMessage(item: QueuedMessage): boolean {
  return item.status === 'sending' || item.status === 'sending_now';
}

/** A send in progress outranks a failure from an earlier attempt. */
function isFailedQueuedMessage(item: QueuedMessage): boolean {
  return !isSendingQueuedMessage(item)
    && (item.status === 'failed' || (item.retryCount ?? 0) > 0);
}

function LegacyPendingQueuePanel({
  sessionId,
  className,
  onRestoreToComposer,
}: PendingQueuePanelProps): JSX.Element | null {
  const { t } = useTranslation('flow-chat');
  const sendNowInFlightIdsRef = useRef(new Set<string>());
  const listId = useId();
  const { expanded, setExpanded, toggle, toggleRef, listRef } = usePendingQueueDisclosure();
  useSyncExternalStore(
    interruptedTurnRecoveryGate.subscribe,
    interruptedTurnRecoveryGate.getSnapshot,
    interruptedTurnRecoveryGate.getSnapshot,
  );
  const recoveryInFlight = interruptedTurnRecoveryGate.isSessionInFlight(sessionId);
  const [items, setItems] = useState<QueuedMessage[]>(() =>
    sessionId ? pendingQueueManager.list(sessionId) : [],
  );
  const reorderIds = items.map(item => item.id);
  const reorderEnabled = !recoveryInFlight && !items.some(isSendingQueuedMessage);
  const move = (id: string, before: string | null) => {
    if (sessionId) pendingQueueManager.reorder(sessionId, id, before);
  };
  const reorder = useQueueReorder(reorderIds, reorderEnabled, sessionId ?? '', move);
  const [isAcpSession, setIsAcpSession] = useState<boolean>(() => {
    if (!sessionId) return false;
    return isAcpFlowSession(FlowChatStore.getInstance().getState().sessions.get(sessionId));
  });
  useEffect(() => {
    setExpanded(true);
    if (!sessionId) {
      setItems([]);
      return;
    }
    setItems(pendingQueueManager.list(sessionId));
    const unsubscribe = pendingQueueManager.subscribe((sid, snapshot) => {
      if (sid === sessionId) setItems(snapshot);
    });
    return unsubscribe;
  }, [sessionId, setExpanded]);

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

  const renderItem = (item: QueuedMessage) => {
    const isSendingNow = item.status === 'sending_now';
    const isSending = isSendingQueuedMessage(item);
    const isFailed = isFailedQueuedMessage(item);
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
        {...reorder.rowProps(item.id)}
        leadingControl={<IconButton variant="annotation" size="xs"
          aria-label={t('pendingQueue.reorder')} icon={<Icon glyph={GripVertical} size="sm" />} {...reorder.handleProps(item.id)} />}
        state={itemState}
        leadingIcon={<Icon glyph={ListEnd} size="sm" />}
      >
        <ChatComposerQueueItemContent
          data-openbitfun-product-component="pending-queue-panel"
          data-openbitfun-product-part="content"
        >
          <ChatComposerQueueItemMessage>
            {/* Focusable only so keyboard users can read a truncated preview;
                it never starts editing. */}
            <OverflowText
              behavior="fade"
              className="openbitfun-pending-queue-panel__preview"
              data-openbitfun-product-component="pending-queue-panel"
              data-openbitfun-product-part="preview"
              data-overflow-trigger
              tabIndex={0}
            >
              {previewText || t('pendingQueue.emptyPlaceholder')}
            </OverflowText>
            <ChatComposerQueueAttachmentBadge
              count={attachmentCount}
              icon={<Icon glyph={Paperclip} size="sm" />}
              label={t('pendingQueue.attachmentCount', { count: attachmentCount })}
            />
          </ChatComposerQueueItemMessage>
          {isSending ? (
            <ChatComposerQueueItemStatus
              data-openbitfun-product-component="pending-queue-panel"
              data-openbitfun-product-part="status"
            >
              {isSendingNow ? t('pendingQueue.statusSending') : t('pendingQueue.statusQueuedSending')}
            </ChatComposerQueueItemStatus>
          ) : isFailed ? (
            <ChatComposerQueueItemStatus
              data-openbitfun-product-component="pending-queue-panel"
              data-openbitfun-product-part="status"
              tone="danger"
            >
              {t('pendingQueue.statusFailed')}
            </ChatComposerQueueItemStatus>
          ) : null}
        </ChatComposerQueueItemContent>

        <ChatComposerQueueItemActions
          data-openbitfun-product-component="pending-queue-panel"
          data-openbitfun-product-part="actions"
        >
          <PendingQueueMessageActions
            onMoveUp={() => move(item.id, reorderIds[reorderIds.indexOf(item.id) - 1])}
            onMoveDown={() => move(item.id, reorderIds[reorderIds.indexOf(item.id) + 2] ?? null)}
            moveUpDisabled={!reorderEnabled || reorderIds.indexOf(item.id) <= 0}
            moveDownDisabled={!reorderEnabled || reorderIds.indexOf(item.id) === reorderIds.length - 1}
            sendLabel={t('pendingQueue.actions.sendNowLabel')}
            sendAriaLabel={t('pendingQueue.actions.sendNow')}
            sendTooltip={t('pendingQueue.tooltip.sendNow')}
            sendDisabled={isSending || recoveryInFlight}
            sending={isSendingNow}
            onSend={() => void handleSendNow(item)}
            editLabel={t('pendingQueue.actions.edit')}
            editDisabled={isSending}
            onEdit={() => handleRestoreToComposer(item)}
            removeLabel={t('pendingQueue.actions.delete')}
            removeDisabled={isSending}
            onRemove={() => handleDelete(item)}
            onCollapse={expanded ? toggle : undefined}
          />
        </ChatComposerQueueItemActions>
      </ChatComposerQueueItem>
    );
  };

  // Collapsing hides the controlled list. Failed rows still need a decision,
  // so they move to a recovery list outside the disclosure.
  const recoveryItems = expanded ? [] : visibleItems.filter(isFailedQueuedMessage);

  return (
    <ChatComposerQueue
      aria-label={t('pendingQueue.label', { count: visibleItems.length })}
      className={`openbitfun-pending-queue-panel ${className ?? ''}`.trim()}
      data-openbitfun-product-component="pending-queue-panel"
      data-openbitfun-product-part="root"
      data-testid="pending-queue-panel"
      onClick={e => {
        e.stopPropagation();
      }}
    >
      {!expanded && <ChatComposerQueueHeader
        data-openbitfun-product-component="pending-queue-panel"
        data-openbitfun-product-part="header"
      >
        <ChatComposerQueueToggle
          ref={toggleRef}
          aria-controls={listId}
          expanded={expanded}
          onClick={toggle}
        >
          <ChatComposerQueueTitle
            count={visibleItems.length}
            data-openbitfun-product-component="pending-queue-panel"
            data-openbitfun-product-part="title"
          >
            {t('pendingQueue.title')}
          </ChatComposerQueueTitle>
        </ChatComposerQueueToggle>
      </ChatComposerQueueHeader>}
      <ChatComposerQueueList
        data-openbitfun-product-component="pending-queue-panel"
        data-openbitfun-product-part="list"
        ref={listRef}
        hidden={!expanded}
        id={listId}
      >
        {expanded && visibleItems.map(renderItem)}
      </ChatComposerQueueList>
      {recoveryItems.length > 0 && (
        <ChatComposerQueueList
          data-openbitfun-product-component="pending-queue-panel"
          data-openbitfun-product-part="list"
        >
          {recoveryItems.map(renderItem)}
        </ChatComposerQueueList>
      )}
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
    {supported && props.sessionId && pendingQueueManager.list(props.sessionId).length > 0 && <p className="openbitfun-pending-queue-panel__legacy-note" data-openbitfun-product-component="pending-queue-panel" data-openbitfun-product-part="status">{t('hostQueue.legacy')}</p>}
    {supported && props.sessionId && <HostPendingQueuePanel key={`${scope.surfaceId}:${scope.epoch}:${props.sessionId}`} queue={hostDialogQueue(props.sessionId)} onRestore={props.onRestoreToComposer} />}
    <LegacyPendingQueuePanel {...props} />
  </>;
}
