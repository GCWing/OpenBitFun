import { useEffect, useState, useSyncExternalStore } from 'react';
import { gitAPI } from '@/infrastructure/api/service-api/GitAPI';
import { getActiveSurfaceScope, isLocalSurface, onSurfaceActivated, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { BoundedResourceCache } from '@/shared/utils/BoundedResourceCache';
import { gitEventService } from '../services/GitEventService';

const REFRESH_DELAY_MS = 150;
const CACHE_TTL_MS = 30_000;
const ERROR_TTL_MS = 5_000;
type Count = number | null;
type PendingCount = { invalidated: boolean; result: Promise<Count | undefined> };

const cache = new BoundedResourceCache<string, { count: Count; expiresAt: number }>(64, 64);
const pending = new Map<string, PendingCount>();

function invalidate(key: string) {
  cache.delete(key);
  const request = pending.get(key);
  if (request) request.invalidated = true;
}

// A Git action in a different scene can invalidate a cached welcome count.
function invalidateWorkspaceCount({ data }: { data: { repositoryPath: { workspaceId: string } } }) {
  const surface = getActiveSurfaceScope();
  invalidate(surface.key('tracked-changes', surface.epoch, data.repositoryPath.workspaceId));
}

const stopOperationInvalidation = gitEventService.on('operation:completed', invalidateWorkspaceCount);
const stopBranchInvalidation = gitEventService.on('branch:changed', invalidateWorkspaceCount);
import.meta.hot?.dispose(() => {
  stopOperationInvalidation();
  stopBranchInvalidation();
  cache.clear();
});

function readCount(key: string, workspaceId: string, surface: SurfaceScope): Promise<Count | undefined> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.count);
  const existing = pending.get(key);
  if (existing) return existing.result;

  const request: PendingCount = {
    invalidated: false,
    result: gitAPI.getTrackedChangeCount(workspaceId)
      .catch(() => null)
      .then(count => {
        if (request.invalidated || !surface.isCurrent()) return undefined;
        cache.set(key, { count, expiresAt: Date.now() + (count === null ? ERROR_TTL_MS : CACHE_TTL_MS) });
        return count;
      })
      .finally(() => pending.delete(key)),
  };
  pending.set(key, request);
  return request.result;
}

/** A visible welcome page reads one number without registering Git polling demand. */
export function useTrackedChangeCount(workspaceId: string, remoteWorkspace: boolean): Count {
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const peer = usePeerDeviceModeOptional();
  const attachment = peer?.attachments.find(item => item.deviceId === surface.surfaceId);
  const supported = isLocalSurface(surface.surfaceId) ? isTauriRuntime()
    : attachment?.health === 'ready' && attachment.capabilities?.gitTrackedChangeCountV1 === true
      && !(remoteWorkspace && attachment.capabilities.hostKind === 'cli');
  const key = surface.key('tracked-changes', surface.epoch, workspaceId);
  const [snapshot, setSnapshot] = useState<{ key: string; count: Count }>();

  useEffect(() => {
    if (!supported) {
      invalidate(key);
      setSnapshot(undefined);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const canRead = () => active && surface.isCurrent() && document.visibilityState !== 'hidden';
    const refresh = () => {
      clearTimeout(timer);
      const currentRevision = ++revision;
      if (!canRead()) return;
      timer = setTimeout(async () => {
        if (!canRead()) return;
        const count = await readCount(key, workspaceId, surface);
        if (!canRead() || currentRevision !== revision) return;
        // An operation invalidated this scan while it was in flight.
        if (count === undefined) {
          refresh();
          return;
        }
        setSnapshot(previous => previous?.key === key && previous.count === count ? previous : { key, count });
      }, REFRESH_DELAY_MS);
    };
    const scope = { repositoryPath: { workspaceId } };
    const stopOperations = gitEventService.on('operation:completed', refresh, scope);
    const stopBranchChanges = gitEventService.on('branch:changed', refresh, scope);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      stopOperations();
      stopBranchChanges();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [key, supported, surface, workspaceId]);

  return supported && snapshot?.key === key ? snapshot.count : null;
}
