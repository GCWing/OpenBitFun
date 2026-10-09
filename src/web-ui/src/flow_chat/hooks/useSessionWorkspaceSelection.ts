import { useCallback, useMemo } from 'react';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import { WorkspaceKind, type WorkspaceInfo } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';
import { FlowChatManager } from '../services/FlowChatManager';
import { canSelectSessionWorkspace } from '../services/sessionDraftService';
import type { Session } from '../types/flow-chat';
import { sessionOwningWorkspaceId } from '../utils/sessionOrdering';

const log = createLogger('SessionWorkspaceSelection');

export interface SessionWorkspaceControl {
  selectedId: string;
  options: WorkspaceInfo[];
  locked: boolean;
  onSelect: (workspaceId: string) => void;
}

/** Both empty-session surfaces select the same draft without navigating the shell. */
export function useSessionWorkspaceSelection(session: Session | null | undefined, submitting = false) {
  const { openedWorkspaces } = useWorkspaceContext();
  const { t } = useI18n('flow-chat');
  const scope = getActiveSurfaceScope();
  const sessionId = session?.sessionId;
  const draftWorkspaceId = session?.draft?.workspaceId;
  const selectedId = draftWorkspaceId ?? (session ? sessionOwningWorkspaceId(session) : undefined) ?? '';
  const selectedWorkspace = openedWorkspaces.get(selectedId);
  const locked = !canSelectSessionWorkspace(session ?? undefined, submitting);
  const onSelect = useCallback((workspaceId: string) => {
    if (!sessionId || locked || !scope.isCurrent()) return;
    try {
      // The service rechecks live lifecycle state, including stale menu clicks.
      FlowChatManager.getInstance().selectDraftWorkspace(sessionId, workspaceId);
    } catch (error) {
      log.warn('Failed to select draft workspace', { sessionId, workspaceId, error });
      notificationService.error(t('workspaceStrip.unavailable'));
    }
  }, [sessionId, locked, scope, t]);

  const options = useMemo(() => [...openedWorkspaces.values()]
    .filter(item => item.workspaceKind !== WorkspaceKind.Assistant), [openedWorkspaces]);
  const workspaceControl: SessionWorkspaceControl = {
    selectedId,
    options,
    locked,
    onSelect,
  };
  return { draftWorkspaceId, selectedWorkspace, workspaceControl };
}
