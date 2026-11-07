import { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Icon, MenuItem } from '@openbitfun/ui';
import type { Session } from '@/flow_chat/types/flow-chat';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { requireSessionOwningWorkspaceId } from '@/flow_chat/utils/sessionOrdering';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import SessionDeleteMenuItem from './SessionDeleteMenuItem';

const log = createLogger('ArchivedSessionMenuItems');

interface Props {
  session: Session;
  title: string;
  workspaceName: string;
  onClose: () => void;
  onChanged: () => void;
  /**
   * Render the session's device before acting (device catalog rows). Resolves
   * false when a newer switch won; the action then does nothing.
   */
  activate?: () => Promise<boolean>;
}

export default function ArchivedSessionMenuItems({ session, title, workspaceName, onClose, onChanged, activate }: Props) {
  const { t } = useI18n('common');
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  const runAction = async (action: 'restore' | 'delete') => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    let scope = getActiveSurfaceScope();
    const labels = { name: title, workspace: workspaceName };
    const sourceView = session.externalHistory?.mode === 'follow';
    try {
      if (action === 'delete') {
        scope.assertCurrent('delete archived session');
        if (activate) {
          if (!await activate()) return;
          scope = getActiveSurfaceScope();
        }
        await flowChatManager.deleteChatSession(session.sessionId);
        scope.assertCurrent('finish deleting archived session');
        notificationService.success(t(sourceView ? 'nav.sessions.removedSourceSucceeded' : 'nav.sessions.deleteArchivedSucceeded', labels));
      } else {
        if (activate) {
          if (!await activate()) return;
          scope = getActiveSurfaceScope();
        }
        const workspaceId = requireSessionOwningWorkspaceId(session);
        await sessionAPI.unarchiveSession(session.sessionId, workspaceId);
        scope.assertCurrent('finish restoring archived session');
        // Ordinary metadata refresh retains loaded records. Apply the host's
        // acknowledged status without replacing an open conversation's content.
        flowChatStore.setState(state => {
          const restored = state.sessions.get(session.sessionId);
          if (!restored || restored.persistedStatus !== 'archived') return state;
          const sessions = new Map(state.sessions);
          sessions.set(session.sessionId, { ...restored, persistedStatus: 'active' });
          return { ...state, sessions };
        });
        notificationService.success(t('nav.sessions.restoreSucceeded', labels));
        try {
          await flowChatManager.refreshWorkspaceSessions({ id: workspaceId });
          scope.assertCurrent('refresh restored session');
        } catch (error) {
          if (!scope.isCurrent() || isSurfaceChangedError(error)) return;
          log.warn('Restored session but failed to refresh workspace sessions', { error, workspaceId });
          notificationService.warning(t('nav.sessions.restoreRefreshFailed'));
        }
      }
      onChanged();
      onClose();
    } catch (error) {
      if (!scope.isCurrent() || isSurfaceChangedError(error)) return;
      log.error('Failed to update archived session', { action, sessionId: session.sessionId, error });
      notificationService.error(t(action === 'restore' ? 'nav.sessions.restoreFailed' : 'nav.sessions.deleteArchivedFailed'));
    } finally {
      pendingRef.current = false;
      if (scope.isCurrent()) setPending(false);
    }
  };

  return <>
    <MenuItem
      leading={<Icon glyph={RotateCcw} size="sm" />}
      disabled={pending}
      data-testid="nav-session-menu-restore"
      data-session-id={session.sessionId}
      onClick={event => { event.stopPropagation(); void runAction('restore'); }}
    >
      {t('nav.sessions.restore')}
    </MenuItem>
    <SessionDeleteMenuItem
      sessionId={session.sessionId}
      label={t('nav.sessions.deleteArchived')}
      description={t(session.externalHistory?.mode === 'follow' ? 'nav.sessions.removeSourceConfirmMessage' : 'nav.sessions.deleteArchivedConfirmMessage', { name: title, workspace: workspaceName })}
      disabled={pending}
      testId="nav-session-menu-delete-archived"
      onConfirm={() => runAction('delete')}
    />
  </>;
}
