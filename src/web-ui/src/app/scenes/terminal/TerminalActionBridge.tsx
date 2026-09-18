import { useEffect, useRef, type FC } from 'react';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { createManualTerminalSession } from '@/shared/services/createManualTerminalSession';
import { openShellSessionTarget } from '@/shared/services/openShellSessionTarget';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isTerminalPathInside } from '@/tools/terminal/services/terminalWorkspaceScope';
import { notificationService } from '@/shared/notification-system';
import { useI18n } from '@/infrastructure/i18n';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import type { ContentResourceScope } from '@/shared/types/contentResource';

const log = createLogger('TerminalActionBridge');

/** Handles global terminal actions while keeping terminal creation out of NavPanel. */
export const TerminalActionBridge: FC = () => {
  const { t } = useI18n('common');
  const { workspacePath, workspace } = useCurrentWorkspace();
  const creatingRef = useRef(false);
  // Only the workspace ID identifies the active workspace; the path is the cwd
  // projection used below and a connection change is not a workspace change.
  const workspaceKey = workspace?.id ?? '';
  const currentWorkspace = useRef({ workspace, workspacePath, key: workspaceKey });
  currentWorkspace.current = { workspace, workspacePath, key: workspaceKey };

  useEffect(() => {
    let active = true;
    const handleCreate = (event: Event) => {
      const detail = (event as CustomEvent<{
        workingDirectory?: string; workspacePath?: string; surfaceId?: string;
        resourceScope?: ContentResourceScope;
      }>).detail;
      const { workspace: activeWorkspace, workspacePath: activePath, key: activeKey } = currentWorkspace.current;
      const scope = getActiveSurfaceScope();
      if (detail?.surfaceId && detail.surfaceId !== scope.surfaceId) return;
      const origin = detail?.resourceScope;
      // The origin scope selects the workspace by ID only; a scope without an
      // ID cannot name a workspace and is dropped rather than matched by path.
      if (origin && !origin.workspaceId) return;
      const target = origin
        ? workspaceManager.getState().openedWorkspaces.get(origin.workspaceId ?? '')
        : activeWorkspace;
      if (origin && (origin.surfaceId !== scope.surfaceId || !target)) return;
      const targetPath = target?.rootPath ?? activePath;
      const remote = target?.workspaceKind === 'remote';
      // The requested cwd is an IO operand and must stay inside the target root.
      if (detail?.workingDirectory && !isTerminalPathInside(detail.workingDirectory, targetPath, remote)) return;
      if (remote && !target?.connectionId) {
        notificationService.error(t('nav.resources.unavailable'));
        return;
      }
      const browseTarget = useNavSceneStore.getState().resourceWorkspace;
      const isCurrent = () => active && scope.isCurrent() && (origin
        ? useNavSceneStore.getState().resourceWorkspace === browseTarget
          && workspaceManager.getState().openedWorkspaces.get(target!.id) === target
        : currentWorkspace.current.key === activeKey);
      if (creatingRef.current || !target) return;
      creatingRef.current = true;

      void createManualTerminalSession({
        workspaceId: target.id,
        workspacePath: detail?.workingDirectory ?? targetPath,
      })
        .then((session) => {
          if (!isCurrent()) return;
          openShellSessionTarget({ sessionId: session.id, sessionName: session.name, scope: origin ?? {
            surfaceId: scope.surfaceId, workspaceId: target?.id,
            workspacePath: targetPath, remoteConnectionId: target?.connectionId,
          } });
        })
        .catch((error) => {
          log.error('Failed to create terminal from global action', error);
          if (isCurrent()) notificationService.error(t('nav.resources.actionFailed', {
            error: error instanceof Error ? error.message : String(error),
          }));
        })
        .finally(() => {
          creatingRef.current = false;
        });
    };

    window.addEventListener('terminal-create-requested', handleCreate);
    return () => {
      active = false;
      window.removeEventListener('terminal-create-requested', handleCreate);
    };
  }, [t]);

  return null;
};

export default TerminalActionBridge;
