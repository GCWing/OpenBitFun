import {
  agentAPI,
  type PermissionRequest,
  type PermissionRequestEvent,
  type PermissionRequestSnapshot,
} from '@/infrastructure/api/service-api/AgentAPI';
import {
  getActiveSurfaceId,
  getActiveSurfaceScope,
  isSurfaceChangedError,
  onSurfaceActivated,
  surfaceIdForDevice,
  type DeviceSurfaceId,
} from '@/infrastructure/peer-device/deviceSurface';
import { observeSurfaceEvents } from '@/infrastructure/peer-device/deviceSurfaceRouting';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('LiveSessionInteractionStore');
const MAX_RESOLVED_PERMISSION_TOMBSTONES = 4096;

interface SurfacePermissionState {
  requests: Map<string, PermissionRequest>;
  resolvedIds: Set<string>;
  snapshotRevisionBySession: Map<string, number>;
  eventVersion: number;
  version: number;
  cachedVersion: number;
  cachedRequests: PermissionRequest[];
}

export interface ActivePermissionMailboxSnapshot {
  surfaceId: DeviceSurfaceId;
  requests: PermissionRequest[];
}

function createSurfaceState(): SurfacePermissionState {
  return {
    requests: new Map(),
    resolvedIds: new Set(),
    snapshotRevisionBySession: new Map(),
    eventVersion: 0,
    version: 0,
    cachedVersion: -1,
    cachedRequests: [],
  };
}

function requestBelongsToSession(request: PermissionRequest, sessionId: string): boolean {
  return request.sessionId === sessionId || request.delegation?.parentSessionId === sessionId;
}

function rememberResolvedRequest(state: SurfacePermissionState, requestId: string): void {
  // A tombstone prevents an older list/snapshot response from reviving a
  // request whose reply event won the race. IDs are unique, so retain only a
  // bounded recent window instead of growing for the lifetime of the app.
  state.resolvedIds.delete(requestId);
  state.resolvedIds.add(requestId);
  while (state.resolvedIds.size > MAX_RESOLVED_PERMISSION_TOMBSTONES) {
    const oldest = state.resolvedIds.values().next().value;
    if (typeof oldest !== 'string') break;
    state.resolvedIds.delete(oldest);
  }
}

function parsePermissionEvent(payload: unknown): PermissionRequestEvent | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const event = payload as PermissionRequestEvent;
  if (event.event === 'asked') {
    return event.request?.requestId ? event : undefined;
  }
  if (event.event === 'replied' || event.event === 'cancelled') {
    return event.requestId ? event : undefined;
  }
  return undefined;
}

/**
 * Surface-scoped projection of Runtime-owned blocking interactions.
 *
 * The event observer sees inactive devices too, while authoritative snapshots
 * repair attach-after-event and relay gaps. Components consume one stable
 * external store instead of each keeping a one-time, device-blind list.
 */
class LiveSessionInteractionStore {
  private readonly surfaces = new Map<DeviceSurfaceId, SurfacePermissionState>();
  private readonly listeners = new Set<() => void>();
  private readonly observedPermissionEvents = new WeakSet<object>();
  private activeSnapshotCache: ActivePermissionMailboxSnapshot | null = null;

  private stateFor(surfaceId: DeviceSurfaceId): SurfacePermissionState {
    const existing = this.surfaces.get(surfaceId);
    if (existing) return existing;
    const created = createSurfaceState();
    this.surfaces.set(surfaceId, created);
    return created;
  }

  private changed(surfaceId: DeviceSurfaceId, state: SurfacePermissionState): void {
    state.version += 1;
    state.cachedVersion = -1;
    if (surfaceId === getActiveSurfaceId()) {
      this.activeSnapshotCache = null;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getActiveSnapshot = (): ActivePermissionMailboxSnapshot => {
    const surfaceId = getActiveSurfaceId();
    const state = this.stateFor(surfaceId);
    if (state.cachedVersion !== state.version) {
      state.cachedRequests = Array.from(state.requests.values());
      state.cachedVersion = state.version;
    }
    if (
      this.activeSnapshotCache?.surfaceId === surfaceId &&
      this.activeSnapshotCache.requests === state.cachedRequests
    ) {
      return this.activeSnapshotCache;
    }
    this.activeSnapshotCache = {
      surfaceId,
      requests: state.cachedRequests,
    };
    return this.activeSnapshotCache;
  };

  captureEventVersion(surfaceId: DeviceSurfaceId): number {
    return this.stateFor(surfaceId).eventVersion;
  }

  applyDeliveredPermissionEvent(event: PermissionRequestEvent): void {
    // Tauri routing invokes Surface observers before the active product
    // listener, so the exact same object has already been retained below.
    // WebSocket delivery has no multi-device routing layer and therefore
    // reaches only this callback; treat it as the local Surface fallback.
    if (
      typeof event === 'object'
      && event !== null
      && this.observedPermissionEvents.delete(event)
    ) {
      return;
    }
    this.applyPermissionEvent(getActiveSurfaceId(), event);
  }

  applyRoutedPermissionEvent(sourceDeviceId: string | null, payload: unknown): void {
    const event = parsePermissionEvent(payload);
    if (!event) return;
    if (typeof payload === 'object' && payload !== null) {
      this.observedPermissionEvents.add(payload);
    }
    this.applyPermissionEvent(surfaceIdForDevice(sourceDeviceId), event);
  }

  activateSurface(): void {
    this.activeSnapshotCache = null;
    this.notify();
  }

  applyPermissionEvent(surfaceId: DeviceSurfaceId, event: PermissionRequestEvent): void {
    const state = this.stateFor(surfaceId);
    state.eventVersion += 1;
    if (event.event === 'asked') {
      state.resolvedIds.delete(event.request.requestId);
      state.requests.set(event.request.requestId, event.request);
    } else {
      rememberResolvedRequest(state, event.requestId);
      state.requests.delete(event.requestId);
    }
    this.changed(surfaceId, state);
  }

  markPermissionResolved(surfaceId: DeviceSurfaceId, requestId: string): void {
    const state = this.stateFor(surfaceId);
    rememberResolvedRequest(state, requestId);
    if (state.requests.delete(requestId)) {
      this.changed(surfaceId, state);
    }
  }

  /** Merge the legacy list command without deleting newer event state. */
  mergeUnversionedPermissions(
    surfaceId: DeviceSurfaceId,
    requests: readonly PermissionRequest[],
  ): void {
    const state = this.stateFor(surfaceId);
    let changed = false;
    for (const request of requests) {
      if (state.resolvedIds.has(request.requestId)) continue;
      const previous = state.requests.get(request.requestId);
      if (previous !== request) {
        state.requests.set(request.requestId, request);
        changed = true;
      }
    }
    if (changed) this.changed(surfaceId, state);
  }

  /** A quiet global read can remove replies lost while the client was away. */
  reconcileUnversionedPermissions(
    surfaceId: DeviceSurfaceId,
    requests: readonly PermissionRequest[],
    expectedEventVersion: number,
  ): void {
    const state = this.stateFor(surfaceId);
    if (state.eventVersion !== expectedEventVersion) {
      this.mergeUnversionedPermissions(surfaceId, requests);
      return;
    }
    const next = new Map(requests.filter(request => !state.resolvedIds.has(request.requestId))
      .map(request => [request.requestId, request]));
    if (next.size === state.requests.size && [...next.keys()].every(id => state.requests.has(id))) return;
    state.requests = next;
    this.changed(surfaceId, state);
  }

  /**
   * Reconcile the filtered Session mailbox returned with restore_session_view.
   * If an event arrived while the request was in flight, preserve it and only
   * merge non-resolved entries; the next snapshot can perform replacement.
   */
  reconcilePermissionSnapshot(
    surfaceId: DeviceSurfaceId,
    sessionId: string,
    snapshot: PermissionRequestSnapshot,
    expectedEventVersion: number,
  ): void {
    const state = this.stateFor(surfaceId);
    const previousRevision = state.snapshotRevisionBySession.get(sessionId) ?? -1;
    if (!Number.isFinite(snapshot.revision) || snapshot.revision <= previousRevision) {
      return;
    }

    const eventRace = state.eventVersion !== expectedEventVersion;
    const pendingIds = new Set(snapshot.requests.map(request => request.requestId));
    let changed = false;
    if (!eventRace) {
      for (const [requestId, request] of state.requests) {
        if (requestBelongsToSession(request, sessionId) && !pendingIds.has(requestId)) {
          state.requests.delete(requestId);
          changed = true;
        }
      }
    }

    for (const request of snapshot.requests) {
      if (state.resolvedIds.has(request.requestId)) continue;
      const previous = state.requests.get(request.requestId);
      if (previous !== request) {
        state.requests.set(request.requestId, request);
        changed = true;
      }
    }

    if (!eventRace) {
      state.snapshotRevisionBySession.set(sessionId, snapshot.revision);
    }
    if (changed) this.changed(surfaceId, state);
  }

  resetForTest(): void {
    this.surfaces.clear();
    this.activeSnapshotCache = null;
    this.notify();
  }
}

export const liveSessionInteractionStore = new LiveSessionInteractionStore();

let mailboxListenersInstalled = false;
let mailboxListenerDisposers: Array<() => void> = [];
const subscribedSurfaces = new Set<DeviceSurfaceId>();
const subscriptionRequests = new Map<DeviceSurfaceId, Promise<void>>();

/**
 * Install the process-wide event capture once FlowChat starts. Keeping this
 * explicit avoids module-import side effects while still retaining requests
 * when no permission card happens to be mounted.
 */
export function installLiveSessionInteractionMailbox(): void {
  if (mailboxListenersInstalled) return;
  mailboxListenersInstalled = true;
  mailboxListenerDisposers = [
    agentAPI.onPermissionRequestEvent((event) => {
      liveSessionInteractionStore.applyDeliveredPermissionEvent(event);
    }),
    observeSurfaceEvents((eventName, sourceDeviceId, payload) => {
      if (eventName !== 'permission://event') return;
      liveSessionInteractionStore.applyRoutedPermissionEvent(sourceDeviceId, payload);
    }),
    onSurfaceActivated(() => {
      liveSessionInteractionStore.activateSurface();
    }),
  ];
}

/** Start one forwarding/list bootstrap per host Surface. */
export function ensureActivePermissionMailbox(refresh = false): Promise<void> {
  installLiveSessionInteractionMailbox();
  const scope = getActiveSurfaceScope();
  if (!refresh && subscribedSurfaces.has(scope.surfaceId)) {
    return Promise.resolve();
  }
  const existing = subscriptionRequests.get(scope.surfaceId);
  if (existing) return existing;

  const request = (async () => {
    try {
      await agentAPI.subscribePermissionRequests();
      const eventVersion = liveSessionInteractionStore.captureEventVersion(scope.surfaceId);
      const pending = await agentAPI.listPendingPermissionRequests();
      scope.assertCurrent('bootstrap permission mailbox');
      liveSessionInteractionStore.reconcileUnversionedPermissions(scope.surfaceId, pending, eventVersion);
      subscribedSurfaces.add(scope.surfaceId);
    } catch (error) {
      if (!isSurfaceChangedError(error)) {
        log.warn('Failed to bootstrap permission mailbox', {
          surfaceId: scope.surfaceId,
          error,
        });
      }
    } finally {
      subscriptionRequests.delete(scope.surfaceId);
    }
  })();
  subscriptionRequests.set(scope.surfaceId, request);
  return request;
}

/**
 * Read the host's pending permissions after an answer whose outcome is unknown
 * (lost reply, or the request was already settled). Returns which of the given
 * requests are still pending; the others are marked resolved so their cards
 * leave. A failed read throws: the caller keeps the request answerable.
 */
export async function confirmPermissionsStillPending(requestIds: readonly string[]): Promise<string[]> {
  const scope = getActiveSurfaceScope();
  const eventVersion = liveSessionInteractionStore.captureEventVersion(scope.surfaceId);
  const pending = await agentAPI.listPendingPermissionRequests();
  scope.assertCurrent('confirm permission answer');
  liveSessionInteractionStore.reconcileUnversionedPermissions(scope.surfaceId, pending, eventVersion);
  const pendingIds = new Set(pending.map(request => request.requestId));
  for (const id of requestIds) {
    if (!pendingIds.has(id)) liveSessionInteractionStore.markPermissionResolved(scope.surfaceId, id);
  }
  return requestIds.filter(id => pendingIds.has(id));
}

export function resetLiveSessionInteractionStoreForTest(): void {
  mailboxListenerDisposers.forEach(dispose => dispose());
  mailboxListenerDisposers = [];
  mailboxListenersInstalled = false;
  subscribedSurfaces.clear();
  subscriptionRequests.clear();
  liveSessionInteractionStore.resetForTest();
}
