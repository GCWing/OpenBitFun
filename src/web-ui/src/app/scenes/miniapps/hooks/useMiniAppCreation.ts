import { useCallback, useRef, useState } from 'react';
import { flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useNotification } from '@/shared/notification-system';
import { isRemoteWorkspace } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('MiniAppCreation');

/** Shared entry into the existing Creative session flow. */
export function useMiniAppCreation() {
  const { workspace } = useCurrentWorkspace();
  const { t } = useI18n('scenes/miniapp');
  const notification = useNotification();
  const [creating, setCreating] = useState(false);
  const pending = useRef(false);

  const createMiniApp = useCallback(async () => {
    if (pending.current) return;
    if (!workspace) {
      notification.error(t('creationMode.noWorkspace'));
      return;
    }
    if (isRemoteWorkspace(workspace)) {
      notification.error(t('creationMode.remoteUnsupported'));
      return;
    }

    const scope = getActiveSurfaceScope();
    pending.current = true;
    setCreating(true);
    try {
      const [{ flowChatManager }, { openMainSession }] = await Promise.all([
        import('@/flow_chat/services/FlowChatManager'),
        import('@/flow_chat/services/sessionActivation'),
      ]);
      scope.assertCurrent('start MiniApp creation');
      const sessionId = await flowChatManager.createChatSession(
        flowChatSessionConfigForWorkspace(workspace),
        'Creative',
      );
      scope.assertCurrent('open MiniApp creation session');
      await openMainSession(sessionId);
      if (scope.isCurrent()) notification.success(t('creationMode.started'));
    } catch (error) {
      if (scope.isCurrent()) {
        log.error('Failed to start Creative MiniApp session', error);
        notification.error(t('creationMode.startFailed'));
      }
    } finally {
      pending.current = false;
      setCreating(false);
    }
  }, [notification, t, workspace]);

  return { creating, createMiniApp };
}
