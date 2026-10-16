import { useRef, useState } from 'react';
import { useSceneStore } from '@/app/stores/sceneStore';
import { hasLocalMiniAppPresentation, miniAppPresentationAPI, type MiniAppViewKind } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useNotification } from '@/shared/notification-system';
import { isRemoteWorkspace } from '@/shared/types';
import { getMiniAppSceneId } from '../miniAppActivity';
import { useMiniAppPresentationStore } from '../miniAppPresentationStore';
import { isMiniAppClosing } from '../miniAppLifecycle';
import { renderMiniAppSystemIcon } from '../utils/miniAppSystemIcon';

interface Transfer {
  appId: string;
  kind: MiniAppViewKind;
  workspacePath: string | null;
  iconSvg?: string;
}

/** Launch choice belongs to the catalog, before either presentation is created. */
export function useMiniAppLaunch() {
  const [scope] = useState(getActiveSurfaceScope);
  const { workspace, workspacePath } = useCurrentWorkspace();
  const { t } = useI18n('scenes/miniapp');
  const notification = useNotification();
  const supported = hasLocalMiniAppPresentation() && !(workspace && isRemoteWorkspace(workspace));
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const pending = useRef(new Set<string>());
  const [busyAppIds, setBusyAppIds] = useState<string[]>([]);

  const run = async (appId: string, action: () => Promise<void>) => {
    if (!scope.isCurrent() || pending.current.has(appId) || isMiniAppClosing(appId, scope)) return;
    pending.current.add(appId);
    setBusyAppIds([...pending.current]);
    try {
      await action();
    } catch (error) {
      if (scope.isCurrent()) notification.error(t('presentation.openFailed', { error: String(error) }));
    } finally {
      pending.current.delete(appId);
      setBusyAppIds([...pending.current]);
    }
  };

  const launch = async (request: Transfer) => {
    const ticket = await miniAppPresentationAPI.open(request.appId, request.kind, request.workspacePath, request.iconSvg);
    if (!scope.isCurrent()) return;
    if (request.kind === 'tab') {
      useMiniAppPresentationStore.getState().bind(ticket);
      useSceneStore.getState().openScene(getMiniAppSceneId(request.appId));
    }
  };

  const openApp = (appId: string, kind: MiniAppViewKind = 'tab', icon?: string) => run(appId, async () => {
    if (!supported) {
      if (kind === 'window') {
        notification.error(t('presentation.unsupported'));
        return;
      }
      // Preserve the existing embedded path on browser and remote surfaces.
      useSceneStore.getState().openScene(getMiniAppSceneId(appId));
      return;
    }
    // A system-launched app may have appeared before the periodic observer runs.
    const snapshot = await miniAppPresentationAPI.snapshot();
    if (!scope.isCurrent()) return;
    if (snapshot.protocolVersion !== 1) throw new Error('Unsupported MiniApp presentation protocol');
    useMiniAppPresentationStore.getState().apply(snapshot);
    const instance = snapshot.instances.find(candidate => candidate.appId === appId);
    const request = {
      appId, kind, workspacePath: instance ? instance.workspacePath : workspacePath || null,
      iconSvg: kind === 'window' && icon ? renderMiniAppSystemIcon(icon) : undefined,
    };
    if (instance?.primaryView && instance.primaryView.kind !== kind) {
      setTransfer(request);
      return;
    }
    await launch(request);
  });

  return {
    supported,
    busyAppIds,
    transfer,
    openApp,
    cancelTransfer: () => setTransfer(null),
    confirmTransfer: () => {
      if (!transfer) return Promise.resolve();
      const request = transfer;
      setTransfer(null);
      return run(request.appId, () => launch(request));
    },
  };
}
