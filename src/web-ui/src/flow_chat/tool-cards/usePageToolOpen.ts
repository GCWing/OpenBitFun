import { useCallback, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { pageAPI } from '@/infrastructure/api/service-api/PageAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { notificationService } from '@/shared/notification-system';
import { flowChatStore } from '../store/FlowChatStore';

function subscribeToPageOwner(listener: () => void): () => void {
  const unsubscribeSessions = flowChatStore.subscribe(listener);
  const unsubscribeSurface = onSurfaceActivated(listener);
  return () => { unsubscribeSessions(); unsubscribeSurface(); };
}

/** Access links belong to the executing account; a dispatch observer cannot mint them locally. */
export function usePageToolOpen(sessionId?: string) {
  const { t } = useI18n('flow-chat');
  const peer = usePeerDeviceModeOptional();
  // Desktop peers implement Pages commands; CLI and unclassified peers cannot
  // mint account access links through HostInvoke.
  const hostSupportsOpen = !peer?.peerMode.active || peer.currentPeerCapabilities?.hostKind === 'desktop';
  const [surface] = useState(getActiveSurfaceScope);
  const isCurrentOwner = useCallback(() => {
    if (!surface.isCurrent() || !hostSupportsOpen) return false;
    if (!sessionId) return true;
    const { sessions } = flowChatStore.getState();
    const visited = new Set<string>();
    let currentId: string | undefined = sessionId;
    while (currentId) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      const session = sessions.get(currentId);
      if (!session || session.config?.dispatchTarget || session.config?.dispatchJobId) return false;
      currentId = session.parentSessionId;
    }
    return true;
  }, [hostSupportsOpen, sessionId, surface]);
  const canOpen = useSyncExternalStore(subscribeToPageOwner, isCurrentOwner, isCurrentOwner);

  const openPage = async (slug: string, knownGeneration?: string, versionId?: string) => {
    if (!slug || !isCurrentOwner()) return;
    try {
      const generation = knownGeneration ?? (await pageAPI.listPages()).find(page => page.slug === slug)?.generation;
      if (!isCurrentOwner()) return;
      if (generation == null) throw new Error('Page no longer exists');
      const link = await pageAPI.createOpenLink(slug, generation, versionId);
      if (isCurrentOwner()) await systemAPI.openExternal(link.open_url);
    } catch {
      if (isCurrentOwner()) notificationService.error(t('toolCards.pagePublish.openFailed'));
    }
  };

  return {
    canOpen, openPage,
    unavailableReason: hostSupportsOpen
      ? t('toolCards.pagePublish.openOnExecutingDevice') : t('toolCards.pagePublish.hostUnsupported'),
  };
}
