import { isTauriRuntime } from '@/infrastructure/runtime';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { createLogger } from '@/shared/utils/logger';
import { flowChatStore } from '../store/FlowChatStore';
import type { Session } from '../types/flow-chat';

const log = createLogger('TrayUnread');

export function countUnreadSessions(sessions: Iterable<Session>): number {
  let count = 0;
  for (const session of sessions) {
    if (!session.isTransient && session.sessionKind !== 'subagent' && session.hasUnreadCompletion) count++;
  }
  return count;
}

/** Reuse persisted receipts and the selected surface's session projection. */
export function installTrayUnreadService(): () => void {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let sent: number | undefined;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    if (disposed || running) return;
    running = true;
    try {
      while (!disposed) {
        const count = countUnreadSessions(flowChatStore.getState().sessions.values());
        if (count === sent) break;
        await systemAPI.setTrayUnreadCount(count);
        sent = count;
      }
    } catch (error) {
      log.warn('Failed to update tray unread count', { error });
      if (!disposed) timer = setTimeout(() => { timer = undefined; void flush(); }, 5_000);
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    if (timer !== undefined) return;
    // Coalesce terminal events and foreground read receipts before native IO.
    timer = setTimeout(() => { timer = undefined; void flush(); }, 100);
  };
  const unsubscribe = flowChatStore.subscribe(schedule);
  // The tray only forwards the intent; read receipts stay owned by the store.
  const unlistenMarkAllRead = systemAPI.onTrayMarkAllRead(() => {
    flowChatStore.clearAllSessionUnreadCompletions();
  });
  schedule();
  return () => {
    disposed = true;
    unsubscribe();
    unlistenMarkAllRead();
    if (timer) clearTimeout(timer);
  };
}
