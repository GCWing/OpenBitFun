 

import { OverlayLayer, OverlayRegion, ScrollArea, useHasModalOverlay } from '@openbitfun/ui';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Notification } from '../types';
import { useActiveNotifications } from '../hooks/useNotificationState';
import { NotificationItem } from './NotificationItem';
import { notificationService } from '../services/NotificationService';
import './NotificationContainer.scss';

const NOTIFICATION_EXIT_DURATION_MS = 140;

interface NotificationPresenceProps {
  notification: Notification;
  isExiting: boolean;
}

const NotificationPresence: React.FC<NotificationPresenceProps> = ({ notification, isExiting }) => {
  const presenceRef = useRef<HTMLDivElement>(null);
  const [exitAccessibilityApplied, setExitAccessibilityApplied] = useState(false);
  const modalOpen = useHasModalOverlay();
  const remainingDuration = useRef(notification.duration ?? 0);

  useEffect(() => {
    if (isExiting || modalOpen || remainingDuration.current <= 0) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => notificationService.dismiss(notification.id), remainingDuration.current);
    return () => {
      window.clearTimeout(timer);
      remainingDuration.current = Math.max(0, remainingDuration.current - (Date.now() - startedAt));
    };
  }, [isExiting, modalOpen, notification.id]);

  useLayoutEffect(() => {
    if (!isExiting) {
      setExitAccessibilityApplied(false);
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof window.HTMLElement && presenceRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
    setExitAccessibilityApplied(true);
  }, [isExiting]);

  const isAccessibilityHidden = isExiting && exitAccessibilityApplied;

  return (
    <div
      ref={presenceRef}
      className={`notification-container__presence${isExiting ? ' notification-container__presence--exiting' : ''}`}
      aria-hidden={isAccessibilityHidden || undefined}
      {...(isAccessibilityHidden ? { inert: '' } : {})}
    >
      <NotificationItem
        notification={notification}
        isExiting={isExiting}
      />
    </div>
  );
};

export const NotificationContainer: React.FC<React.PropsWithChildren> = ({ children }) => {
  const activeNotifications = useActiveNotifications();

  const visibleNotifications = useMemo(() => activeNotifications.filter(
    n => n.variant !== 'silent' && n.variant !== 'progress' && n.variant !== 'loading'
  ), [activeNotifications]);
  const [presentedNotifications, setPresentedNotifications] = useState<Notification[]>(visibleNotifications);
  const exitTimersRef = useRef(new Map<string, number>());
  const visibleIds = useMemo(
    () => new Set(visibleNotifications.map(notification => notification.id)),
    [visibleNotifications],
  );

  useEffect(() => {
    setPresentedNotifications(current => {
      const nextById = new Map(visibleNotifications.map(notification => [notification.id, notification]));
      let changed = false;
      const merged = current.map(notification => {
        const next = nextById.get(notification.id) ?? notification;
        changed ||= next !== notification;
        return next;
      });
      const currentIds = new Set(current.map(notification => notification.id));

      visibleNotifications.forEach(notification => {
        if (!currentIds.has(notification.id)) {
          merged.push(notification);
          changed = true;
        }
      });

      return changed ? merged : current;
    });
  }, [visibleNotifications]);

  useEffect(() => {
    visibleIds.forEach(id => {
      const timer = exitTimersRef.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        exitTimersRef.current.delete(id);
      }
    });

    presentedNotifications.forEach(notification => {
      if (visibleIds.has(notification.id) || exitTimersRef.current.has(notification.id)) {
        return;
      }

      const timer = window.setTimeout(() => {
        setPresentedNotifications(current => current.filter(item => item.id !== notification.id));
        exitTimersRef.current.delete(notification.id);
      }, NOTIFICATION_EXIT_DURATION_MS);
      exitTimersRef.current.set(notification.id, timer);
    });
  }, [presentedNotifications, visibleIds]);

  useEffect(() => () => {
    exitTimersRef.current.forEach(timer => window.clearTimeout(timer));
    exitTimersRef.current.clear();
  }, []);

  if (presentedNotifications.length === 0 && !children) {
    return null;
  }

  return (
    <OverlayRegion>
      <div
        className="notification-container"
        data-openbitfun-component="notification"
        data-openbitfun-part="container"
      >
        <ScrollArea className="notification-container__viewport" scrollbarVisibility="hidden">
          {children}
          {presentedNotifications.map(notification => {
            const isExiting = !visibleIds.has(notification.id);
            return (
              <OverlayLayer key={notification.id} passive open={!isExiting}>
                <NotificationPresence notification={notification} isExiting={isExiting} />
              </OverlayLayer>
            );
          })}
        </ScrollArea>
      </div>
    </OverlayRegion>
  );
};
