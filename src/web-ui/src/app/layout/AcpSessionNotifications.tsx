import { useEffect, useRef } from 'react';
import { Spinner } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import type { AcpSessionStartupDetail } from '@/flow_chat/services/acpSessionStartup';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('AcpSessionNotifications');

export function AcpSessionNotifications(): null {
  const { t } = useI18n('common');
  const translate = useRef(t);
  translate.current = t;

  useEffect(() => {
    const notifications = new Map<string, string>();
    const clear = () => {
      notifications.forEach(id => notificationService.dismiss(id));
      notifications.clear();
    };
    const unsubscribe = onSurfaceActivated(clear);
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<AcpSessionStartupDetail>).detail;
      if (!detail?.scope?.isCurrent()) return;
      const previous = notifications.get(detail.requestId);
      if (previous) notificationService.dismiss(previous);
      notifications.delete(detail.requestId);

      if (detail.phase === 'start') {
        const message = translate.current(detail.action === 'restore'
          ? 'nav.workspaces.initializingAcpSession' : 'nav.workspaces.startingAcpSession');
        // Loading notifications are center-only. Use a persistent toast so the
        // initial process/adapter startup is visible before a session tab exists.
        const id = notificationService.info(message, {
          title: detail.clientId,
          duration: 0,
          closable: false,
          messageNode: <><Spinner size="xs" /> {message}</>,
          metadata: { source: 'acp-session', requestId: detail.requestId },
        });
        notifications.set(detail.requestId, id);
      } else if (detail.succeeded === false && !detail.cancelled) {
        const id = notificationService.error(
          detail.error || translate.current('nav.workspaces.acpSessionStartFailed'),
          {
            title: `${detail.clientId}: ${translate.current('nav.workspaces.acpSessionStartFailed')}`,
            actions: detail.retry ? [{
              label: translate.current('nav.workspaces.retryAcpSession'),
              onClick: () => {
                notifications.delete(detail.requestId);
                if (!detail.scope.isCurrent()) return;
                void detail.retry!().then(async sessionId => {
                  if (sessionId && detail.scope.isCurrent()) {
                    try {
                      await openMainSession(sessionId, { workspaceId: detail.workspaceId });
                    } catch (error) {
                      if (detail.scope.isCurrent()) {
                        notificationService.error(error instanceof Error ? error.message : String(error));
                      }
                    }
                  }
                }).catch(error => log.warn('ACP session retry failed', { error }));
              },
            }] : undefined,
          },
        );
        notifications.set(detail.requestId, id);
      }
    };
    window.addEventListener('openbitfun:acp-session-creation', handle);
    return () => {
      window.removeEventListener('openbitfun:acp-session-creation', handle);
      unsubscribe();
      clear();
    };
  }, []);
  return null;
}
