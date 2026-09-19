import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, IconButton, OverflowText, useHasModalOverlay } from '@openbitfun/ui';
import type { AnnouncementCard } from '../types';
import { useAnnouncementStore } from '../store/announcementStore';
import { useAnnouncementI18n } from '../hooks/useAnnouncementI18n';

interface Props {
  card: AnnouncementCard;
}

const ANNOUNCEMENT_TOAST_EXIT_MS = 220;

/**
 * Bottom-left toast: compact fixed-width card.
 * Layout (top → bottom): title row (+ close) → description → action buttons.
 */
const AnnouncementToastItem: React.FC<Props> = ({ card }) => {
  const { t } = useAnnouncementI18n();
  const { openModalFor, dismissToast } = useAnnouncementStore();
  const [exiting, setExiting] = useState(false);
  const modalOpen = useHasModalOverlay();
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { toast, card_type, modal } = card;
  const hasModal = card_type !== 'tip' && modal !== null;
  const autoDismissMs = toast.auto_dismiss_ms;
  const remainingMs = useRef(autoDismissMs ?? 0);

  const resolve = (key: string) => (key.startsWith('announcements.') ? t(key) : key);

  function triggerExit(callback: () => void) {
    if (exiting) return;
    if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    setExiting(true);
    exitTimer.current = setTimeout(callback, ANNOUNCEMENT_TOAST_EXIT_MS);
  }

  function handleDismiss() {
    triggerExit(() => dismissToast(card));
  }

  function handleAction() {
    if (hasModal) {
      triggerExit(() => openModalFor(card));
    } else {
      handleDismiss();
    }
  }

  useEffect(() => {
    if (exiting || modalOpen || remainingMs.current <= 0) return;
    const startedAt = Date.now();
    autoDismissTimer.current = setTimeout(handleDismiss, remainingMs.current);
    return () => {
      if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
      remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, exiting, modalOpen]);

  useEffect(() => () => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
  }, []);

  const actionLabel =
    resolve(toast.action_label) ||
    (hasModal ? t('announcements.common.learn_more') : t('announcements.common.got_it'));

  return (
    <div
      className={`announcement-toast ${exiting ? 'announcement-toast--exiting' : 'announcement-toast--entering'}`}
      role="alert"
      aria-live="polite"
      aria-hidden={exiting}
      {...(exiting ? { inert: '' } : {})}
    >
      {/* Row 1: title + close with optional countdown ring */}
      <div className="announcement-toast__header">
        <OverflowText as="div" lines={2} className="announcement-toast__title">{resolve(toast.title)}</OverflowText>
        {toast.dismissible && (
          <div className="announcement-toast__close-wrap">
            {autoDismissMs != null && autoDismissMs > 0 && (
              <svg
                className="announcement-toast__ring"
                viewBox="0 0 28 28"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="14" cy="14" r="13.25"
                  className="announcement-toast__ring-track" />
                <circle cx="14" cy="14" r="13.25" pathLength="100"
                  className="announcement-toast__ring-fill"
                  style={{ animationDuration: `${autoDismissMs}ms`, animationPlayState: modalOpen ? 'paused' : 'running' }} />
              </svg>
            )}
            <IconButton
              className="announcement-toast__close"
              shape="circle"
              size="xs"
              variant="quiet"
              icon={<Icon name="xmark" />}
              onClick={handleDismiss}
              aria-label={t('announcements.common.close')}
            />
          </div>
        )}
      </div>

      {/* Row 2: description */}
      <OverflowText as="p" lines={3} className="announcement-toast__desc">{resolve(toast.description)}</OverflowText>

      {/* Row 3: action buttons */}
      <div className="announcement-toast__actions">
        <Button
          variant="primary"
          size="sm"
          onClick={handleAction}
        >
          {actionLabel}
        </Button>
      </div>

    </div>
  );
};

export default AnnouncementToastItem;
