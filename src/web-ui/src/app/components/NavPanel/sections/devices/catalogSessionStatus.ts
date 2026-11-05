import { useCallback, useSyncExternalStore } from 'react';
import type { DeviceSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { sessionActivityStore } from '@/flow_chat/store/sessionActivityStore';
import { crossDeviceActivity } from '@/flow_chat/services/crossDeviceSessions';
import type { SessionNavStatus } from '@/flow_chat/utils/sessionNavStatus';
import type { SessionActivitySummary } from '@/shared/types/session-history';

const IDLE: SessionNavStatus = { kind: 'idle', pendingCount: 0 };

/**
 * Nav status of a session that has no live container on this window. Only the
 * host's activity summary is known, so the projection is the summary's.
 */
export function catalogSessionStatus(summary: SessionActivitySummary | undefined): SessionNavStatus {
  if (!summary) return IDLE;
  if (summary.pendingApprovals > 0) return { kind: 'approval', pendingCount: summary.pendingApprovals };
  if (summary.pendingQuestions > 0) return { kind: 'input', pendingCount: summary.pendingQuestions };
  if (summary.execution === 'running') return { kind: 'running', pendingCount: 0 };
  if (summary.execution === 'queued') return { kind: 'queued', pendingCount: 0 };
  if (summary.execution === 'error' || summary.unreadCompletion === 'error') return { kind: 'error', pendingCount: 0 };
  if (summary.unreadCompletion === 'interrupted') return { kind: 'stopped', pendingCount: 0 };
  if (summary.unreadCompletion === 'completed') return { kind: 'unread', pendingCount: 0 };
  return IDLE;
}

/**
 * The host's catalog summary is refreshed on every lifecycle invalidation, so
 * it wins; observed events only fill a session the catalog has no summary for.
 */
export function useCatalogSessionStatus(
  surfaceId: DeviceSurfaceId,
  sessionId: string,
  pageSummary: SessionActivitySummary | undefined,
): SessionNavStatus {
  const subscribe = useCallback((notify: () => void) => sessionActivityStore.subscribe((changedSurface, changedSession) => {
    if (changedSurface === surfaceId && changedSession === sessionId) notify();
  }), [sessionId, surfaceId]);
  const read = useCallback(() => crossDeviceActivity(surfaceId, sessionId, pageSummary), [pageSummary, sessionId, surfaceId]);
  return catalogSessionStatus(useSyncExternalStore(subscribe, read, read));
}
