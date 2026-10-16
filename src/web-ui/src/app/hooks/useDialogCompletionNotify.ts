import { useEffect, useRef } from 'react';
import type { AgenticEvent } from '@/infrastructure/api/service-api/AgentAPI';
import { agentAPI } from '@/infrastructure/api';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import {
  buildDialogCompletionNotificationCopy,
  shouldSendDialogCompletionNotification,
} from './dialogCompletionNotifyPolicy';

const log = createLogger('useDialogCompletionNotify');

/**
 * Listens for dialog turn completion events and sends an OS-level desktop
 * notification (Windows toast / macOS notification center) when the window
 * is not focused and the feature is enabled in config.
 *
 * Notification title = session title (or short session id fallback).
 * Notification body  = fixed "task completed" message.
 *
 * "Not focused" means: the page is hidden (minimized / tab switched) OR
 * the window has lost focus to another OS-level application.
 */
export const useDialogCompletionNotify = () => {
  const { t } = useI18n('common');
  // Track whether the window currently has OS-level focus
  const windowFocusedRef = useRef(true);

  useEffect(() => {
    const handleFocus = () => { windowFocusedRef.current = true; };
    const handleBlur = () => { windowFocusedRef.current = false; };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    const notified = new Map<string, string>();
    const notify = async (event: AgenticEvent) => {
      // Send notification if page is hidden OR window lost OS focus
      const isBackground = document.hidden || !windowFocusedRef.current;

      let enabled = true;
      try {
        enabled = await configManager.getConfig<boolean>(
          'app.notifications.dialog_completion_notify'
        );
      } catch (error) {
        log.warn('Failed to read dialog_completion_notify config', error);
      }

      // Resolve session title from store; fall back to short session id
      const sessionId: string = event?.sessionId ?? '';
      const session = sessionId
        ? flowChatStore.getState().sessions.get(sessionId)
        : undefined;
      if (
        !shouldSendDialogCompletionNotification({
          event,
          session,
          isBackground,
          notificationsEnabled: enabled,
        })
      ) {
        return;
      }

      const notificationCopy = buildDialogCompletionNotificationCopy({
        sessionTitle: session?.title,
        success: event?.success,
        finishReason: event?.finishReason ?? event?.finish_reason,
        t,
      });

      const turnId = event.turnId ?? event.turn_id;
      const turn = session?.dialogTurns.find(turn => turn.id === turnId);
      const receipt = `${turnId}:${turn?.recovery?.executionGeneration ?? turn?.recoveryEpoch ?? 0}:${event.success === false ? 'failed' : 'completed'}`;
      if (notified.get(sessionId) === receipt) return;
      notified.set(sessionId, receipt);
      try {
        await systemAPI.sendSystemNotification(notificationCopy.title, notificationCopy.body);
      } catch (error) {
        if (notified.get(sessionId) === receipt) notified.delete(sessionId);
        log.warn('Failed to send dialog result notification', { sessionId, turnId, error });
      }
    };
    const unlisten = agentAPI.onDialogTurnCompleted(notify);
    const unlistenFailed = agentAPI.onDialogTurnFailed(event => notify({ ...event, success: false }));

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      unlisten();
      unlistenFailed();
    };
  }, [t]);
};
