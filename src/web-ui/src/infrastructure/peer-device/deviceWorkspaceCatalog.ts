/**
 * Workspace and session catalog of devices the window is not rendering.
 *
 * The sidebar lists every online host of the account in place. The rendered
 * device keeps its live workspace container; every other device is described
 * by this read-only catalog, which is loaded lazily and kept current by host
 * invalidations:
 *
 * - Nothing is read until a section is expanded (`retain`). Sessions of a
 *   workspace are read only while that workspace is expanded.
 * - A peer's `@host/catalog` stream sends revision hints (no data). Local
 *   catalog and lifecycle events cover this machine and attached peers.
 *   Hints are debounced, then coalesced into one in-flight read per device.
 * - A host that cannot stream (older build) is re-read when the window becomes
 *   visible again; there is no polling.
 * - A failed read keeps the last rendered catalog and exposes the error for
 *   retry. An offline device is never substituted by a cache of another host.
 *
 * Opening anything from this catalog activates the owning surface first, so
 * every operation keeps Peer Device Mode's ownership and capability rules.
 */

import { upgradeLegacyWorktreeReferences } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
import type { WorkspaceInfo as APIWorkspaceInfo } from '@/infrastructure/api/service-api/GlobalAPI';
import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { mapWorkspaceInfo, type WorkspaceInfo } from '@/shared/types/global-state';
import type { SessionActivitySummary, SessionMetadata } from '@/shared/types/session-history';
import { createLogger } from '@/shared/utils/logger';
import { InvalidationSync } from '../../../../shared/relay-transport/InvalidationSync';
import { HOST_CATALOG_ID } from '../../../../shared/relay-transport/HostStream';
import {
  getActiveSurfaceId,
  isLocalSurface,
  onSurfaceActivated,
  surfaceIdForDevice,
  type DeviceSurfaceId,
} from './deviceSurface';
import { observeSurfaceEvents } from './deviceSurfaceRouting';
import { acknowledgeOnDevice, deviceCatalogLocalTransport, invokeOnDevice } from './deviceCatalogTransport';
import { stableWorkspaceOrder } from '@/infrastructure/services/business/workspaceDisplayOrder';
import { getDeviceOpenIntent, useDeviceOpenIntent } from './deviceOpenIntent';

const log = createLogger('DeviceWorkspaceCatalog');

// The live list's first rows (3) plus one "show more" step (5): the same rows
// draw at once, and the first expansion needs no read.
export const DEVICE_CATALOG_SESSION_PAGE = 8;
export const DEVICE_CATALOG_SESSION_STEP = 20;
const MAX_REFRESHED_SESSIONS = 200;
const MAX_PAGES_PER_READ = 5;
/** Session reads one device runs at once; a refresh never floods its relay link. */
const SESSION_READ_CONCURRENCY = 2;
export const DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS = 300;
/** How often a device whose host has no catalog stream is re-read while shown. */
export const DEVICE_CATALOG_POLL_MS = 60_000;
export const DEVICE_CATALOG_RELEASE_GRACE_MS = 30_000;

/**
 * Events that can change a host's workspace list, session list or ordering.
 * `host-catalog-changed` is the peer catalog stream hint; the rest are the
 * lifecycle events this machine (and any attached peer) already fans out.
 */
const CATALOG_INVALIDATING_EVENTS = new Set([
  'host-catalog-changed',
  'workspace-catalog-changed',
  'agentic://session-created',
  'agentic://session-deleted',
  'agentic://dialog-turn-started',
  'agentic://dialog-turn-completed',
  'session_title_generated',
]);

export type DeviceCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DeviceCatalogSessions {
  readonly status: DeviceCatalogStatus;
  /** Top-level sessions in host order, children excluded. */
  readonly sessions: readonly SessionMetadata[];
  /** Every non-archived record of the read, children included (navigation projection). */
  readonly records: readonly SessionMetadata[];
  readonly activities: Readonly<Record<string, SessionActivitySummary>>;
  readonly hasMore: boolean;
  /** Top-level count when the host reported a complete count. */
  readonly total: number | null;
  readonly limit: number;
  readonly error?: string;
}

export interface DeviceCatalogSnapshot {
  readonly status: DeviceCatalogStatus;
  readonly workspaces: readonly WorkspaceInfo[];
  readonly error?: string;
  /** The host streams catalog hints; false means it refreshes on visibility. */
  readonly live: boolean;
  readonly sessions: Readonly<Record<string, DeviceCatalogSessions>>;
}

const EMPTY_SNAPSHOT: DeviceCatalogSnapshot = Object.freeze({
  status: 'idle',
  workspaces: [],
  live: false,
  sessions: {},
});

const EMPTY_SESSIONS: DeviceCatalogSessions = Object.freeze({
  status: 'idle',
  sessions: [],
  records: [],
  activities: {},
  hasMore: false,
  total: null,
  limit: DEVICE_CATALOG_SESSION_PAGE,
});

interface Entry {
  readonly surfaceId: DeviceSurfaceId;
  readonly deviceId: string | null;
  readonly generation: number;
  snapshot: DeviceCatalogSnapshot;
  retainCount: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  readonly workspaceRetain: Map<string, number>;
  /** Keep every workspace's first page current (device status, companion). */
  activityRetain: number;
  readonly sync: InvalidationSync;
  /** `workspace_id_references_v1`; null until the host answered a ping. */
  workspaceIdReferences: boolean | null;
  /** The ping in flight, shared by every read that needs its answer. */
  negotiation: Promise<void> | null;
  /** Latest session read per workspace; an older read's answer is dropped. */
  readonly sessionReads: Map<string, number>;
  streamSubscriptionId: string | null;
  streamPending: boolean;
  stopped: boolean;
  /** Whether the next read must re-read the workspace list or only session pages. */
  pendingScope: RefreshScope;
  /** Last `workspacesRevision` a host hint carried. */
  workspacesRevision: unknown;
}

/** `sessions`: workspace list unchanged, refresh session pages only. */
type RefreshScope = 'sessions' | 'all';
const mergeScope = (a: RefreshScope | undefined, b: RefreshScope): RefreshScope => (a === 'all' || b === 'all' ? 'all' : 'sessions');

type Listener = (surfaceId: DeviceSurfaceId) => void;

export interface DeviceWorkspaceCatalogIO {
  invoke: <T>(deviceId: string | null, command: string, args: Record<string, unknown>) => Promise<T>;
  acknowledge: (deviceId: string | null, workspaceRequest: Record<string, unknown>, metadata: Record<string, unknown>) => Promise<void>;
  subscribeCatalog: (deviceId: string) => Promise<string>;
  unsubscribeCatalog: (subscriptionId: string) => Promise<void>;
  /** Registers the native listeners that feed `observeSurfaceEvents`. */
  listen: (event: string, callback: (payload: unknown) => void) => () => void;
}

const defaultIO: DeviceWorkspaceCatalogIO = {
  invoke: invokeOnDevice,
  acknowledge: acknowledgeOnDevice,
  subscribeCatalog: deviceId => remoteConnectAPI.subscribeSession(deviceId, HOST_CATALOG_ID),
  unsubscribeCatalog: subscriptionId => remoteConnectAPI.unsubscribeSession(subscriptionId),
  listen: (event, callback) => deviceCatalogLocalTransport().listen(event, callback),
};

function isTopLevel(session: SessionMetadata): boolean {
  return session.sessionKind !== 'subagent' && !session.relationship?.parentSessionId;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DeviceWorkspaceCatalog {
  private readonly entries = new Map<DeviceSurfaceId, Entry>();
  private readonly listeners = new Set<Listener>();
  private generation = 0;
  private teardownEvents: (() => void) | null = null;
  private readonly deferred = new Map<DeviceSurfaceId, RefreshScope>();
  private readonly notifyQueue = new Set<DeviceSurfaceId>();

  constructor(private readonly io: DeviceWorkspaceCatalogIO = defaultIO) {}

  getSnapshot(surfaceId: DeviceSurfaceId): DeviceCatalogSnapshot {
    return this.entries.get(surfaceId)?.snapshot ?? EMPTY_SNAPSHOT;
  }

  getSessions(surfaceId: DeviceSurfaceId, workspaceId: string): DeviceCatalogSessions {
    return this.getSnapshot(surfaceId).sessions[workspaceId] ?? EMPTY_SESSIONS;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Keep a device catalog loaded while a section shows it. The first retain
   * reads the host; releasing keeps the last catalog for an instant reopen and
   * stops the host stream after a grace period.
   */
  retain(surfaceId: DeviceSurfaceId): () => void {
    this.installEvents();
    const entry = this.entryFor(surfaceId);
    entry.retainCount += 1;
    if (entry.releaseTimer !== null) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    if (entry.retainCount === 1) {
      this.startStream(entry);
      void this.invalidateNow(entry);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Look the entry up again: an account reset may have replaced it.
      const current = this.entries.get(surfaceId);
      if (current) this.release(current);
    };
  }

  /**
   * Keep the latest sessions of every workspace on a device current, so its
   * running, waiting and unread sessions are known without expanding anything.
   * Implies `retain`. Reads stay invalidation-driven and debounced.
   */
  retainActivity(surfaceId: DeviceSurfaceId): () => void {
    const releaseCatalog = this.retain(surfaceId);
    const entry = this.entryFor(surfaceId);
    entry.activityRetain += 1;
    if (entry.activityRetain === 1 && entry.snapshot.status === 'ready') {
      void this.loadSessionPages(entry, entry.snapshot.workspaces.map(workspace => workspace.id), true);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(surfaceId);
      if (current) current.activityRetain = Math.max(0, current.activityRetain - 1);
      releaseCatalog();
    };
  }

  /** Surfaces whose catalog is loaded, for cross-device consumers. */
  loadedSurfaces(): DeviceSurfaceId[] {
    return Array.from(this.entries.values())
      .filter(entry => entry.retainCount > 0 && entry.snapshot.status !== 'idle')
      .map(entry => entry.surfaceId);
  }

  /** Keep one workspace's sessions loaded while it is expanded. */
  retainSessions(surfaceId: DeviceSurfaceId, workspaceId: string): () => void {
    const entry = this.entryFor(surfaceId);
    const count = entry.workspaceRetain.get(workspaceId) ?? 0;
    entry.workspaceRetain.set(workspaceId, count + 1);
    const current = entry.snapshot.sessions[workspaceId];
    // A page the activity refresh already keeps current is not read again.
    if (count === 0 && (!current || current.status === 'idle' || current.status === 'error')) {
      void this.loadSessions(entry, workspaceId, current?.limit ?? DEVICE_CATALOG_SESSION_PAGE);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(surfaceId);
      if (!current) return;
      const remaining = (current.workspaceRetain.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) current.workspaceRetain.delete(workspaceId);
      else current.workspaceRetain.set(workspaceId, remaining);
    };
  }

  /** Read at least `limit` top-level sessions (default: one more step). */
  loadMoreSessions(surfaceId: DeviceSurfaceId, workspaceId: string, limit?: number): Promise<void> {
    const entry = this.entries.get(surfaceId);
    if (!entry) return Promise.resolve();
    const current = entry.snapshot.sessions[workspaceId] ?? EMPTY_SESSIONS;
    const target = Math.min(limit ?? current.limit + DEVICE_CATALOG_SESSION_STEP, MAX_REFRESHED_SESSIONS);
    if (target <= current.limit && current.status !== 'error') return Promise.resolve();
    return this.loadSessions(entry, workspaceId, target);
  }

  /**
   * Mark every loaded session of a device read, on its host. The catalog is
   * updated at once (rows, device status, companion), then re-read. Returns
   * the number of sessions acknowledged.
   */
  async markAllRead(surfaceId: DeviceSurfaceId): Promise<number> {
    return this.acknowledgeSessions(surfaceId, null);
  }

  /** Mark one loaded session of a device read on its host (companion dismiss). */
  async markSessionRead(surfaceId: DeviceSurfaceId, sessionId: string): Promise<boolean> {
    return (await this.acknowledgeSessions(surfaceId, sessionId)) > 0;
  }

  private async acknowledgeSessions(surfaceId: DeviceSurfaceId, onlySessionId: string | null): Promise<number> {
    const entry = this.entries.get(surfaceId);
    if (!entry || entry.snapshot.status !== 'ready') return 0;
    const targets: Array<{ workspace: WorkspaceInfo; metadata: SessionMetadata }> = [];
    for (const workspace of entry.snapshot.workspaces) {
      const page = entry.snapshot.sessions[workspace.id];
      if (!page) continue;
      for (const metadata of page.records) {
        if (onlySessionId !== null && metadata.sessionId !== onlySessionId) continue;
        if (metadata.unreadCompletion || metadata.needsUserAttention || page.activities[metadata.sessionId]?.unreadCompletion) {
          // The receipt must name the host's own record of the unread result.
          const receipt = page.activities[metadata.sessionId]?.unreadTurn
            ?? (metadata.customMetadata as { unreadCompletionTarget?: unknown } | undefined)?.unreadCompletionTarget
            ?? metadata.lastTurn;
          targets.push({ workspace, metadata: receipt ? {
            ...metadata, lastTurn: receipt as SessionMetadata['lastTurn'],
            customMetadata: { ...(metadata.customMetadata ?? {}), unreadCompletionTarget: receipt },
          } as SessionMetadata : metadata });
        }
      }
    }
    if (targets.length === 0) return 0;
    const cleared = new Set(targets.map(target => target.metadata.sessionId));
    const sessions = Object.fromEntries(Object.entries(entry.snapshot.sessions).map(([workspaceId, page]) => [workspaceId, {
      ...page,
      records: page.records.map(record => (cleared.has(record.sessionId)
        ? { ...record, unreadCompletion: undefined, needsUserAttention: undefined } : record)),
      sessions: page.sessions.map(record => (cleared.has(record.sessionId)
        ? { ...record, unreadCompletion: undefined, needsUserAttention: undefined } : record)),
      activities: Object.fromEntries(Object.entries(page.activities).map(([sessionId, activity]) => [sessionId,
        cleared.has(sessionId) ? { ...activity, unreadCompletion: undefined, unreadTurn: undefined } : activity])),
    }]));
    this.update(entry, { sessions });
    await this.negotiate(entry);
    const results = await Promise.allSettled(targets.map(({ workspace, metadata }) => this.io.acknowledge(
      entry.deviceId, this.workspaceRequest(entry, workspace), metadata as unknown as Record<string, unknown>,
    )));
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length > 0) log.warn('Some sessions could not be marked read on their device', { surfaceId, failed: failed.length });
    this.invalidate(surfaceId, 'sessions');
    return targets.length - failed.length;
  }

  /** Explicit retry after a visible failure; bypasses the debounce. */
  retry(surfaceId: DeviceSurfaceId): Promise<void> {
    const entry = this.entries.get(surfaceId);
    if (!entry) return Promise.resolve();
    if (!entry.snapshot.live) this.startStream(entry);
    entry.pendingScope = 'all';
    return this.invalidateNow(entry);
  }

  /** Coalesce a burst of host hints into one read. */
  invalidate(surfaceId: DeviceSurfaceId, scope: RefreshScope = 'all'): void {
    const entry = this.entries.get(surfaceId);
    if (!entry || entry.retainCount === 0 || entry.stopped) return;
    // A cross-device open owns the relay link until it settles, and a hidden
    // window shows nothing: navigation keeps what it has and catches up once,
    // right after.
    if (getDeviceOpenIntent() || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      this.deferred.set(surfaceId, mergeScope(this.deferred.get(surfaceId), scope));
      return;
    }
    entry.pendingScope = mergeScope(entry.debounceTimer !== null ? entry.pendingScope : undefined, scope);
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.invalidateNow(entry);
    }, DEVICE_CATALOG_INVALIDATE_DEBOUNCE_MS);
  }

  /**
   * Account change: no catalog survives another identity. Sections that are
   * still open read their device again under the new account.
   */
  reset(): void {
    this.generation += 1;
    const previous = Array.from(this.entries.values());
    this.entries.clear();
    for (const old of previous) {
      this.stop(old);
      if (old.retainCount > 0) {
        const entry = this.entryFor(old.surfaceId);
        entry.retainCount = old.retainCount;
        entry.activityRetain = old.activityRetain;
        for (const [workspaceId, count] of old.workspaceRetain) entry.workspaceRetain.set(workspaceId, count);
        this.startStream(entry);
        void this.invalidateNow(entry);
      }
      this.notify(old.surfaceId);
    }
  }

  private entryFor(surfaceId: DeviceSurfaceId): Entry {
    const existing = this.entries.get(surfaceId);
    if (existing) return existing;
    const entry: Entry = {
      surfaceId,
      deviceId: isLocalSurface(surfaceId) ? null : surfaceId,
      generation: this.generation,
      snapshot: EMPTY_SNAPSHOT,
      retainCount: 0,
      releaseTimer: null,
      debounceTimer: null,
      workspaceRetain: new Map(),
      activityRetain: 0,
      sync: new InvalidationSync(() => this.read(entry)),
      workspaceIdReferences: isLocalSurface(surfaceId) ? true : null,
      negotiation: null,
      sessionReads: new Map(),
      streamSubscriptionId: null,
      streamPending: false,
      stopped: false,
      pendingScope: 'all',
      workspacesRevision: undefined,
    };
    this.entries.set(surfaceId, entry);
    return entry;
  }

  private release(entry: Entry): void {
    entry.retainCount = Math.max(0, entry.retainCount - 1);
    if (entry.retainCount > 0 || entry.stopped) return;
    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    entry.releaseTimer = setTimeout(() => {
      entry.releaseTimer = null;
      if (entry.retainCount === 0) this.stopStream(entry);
    }, DEVICE_CATALOG_RELEASE_GRACE_MS);
  }

  private isCurrent(entry: Entry): boolean {
    return !entry.stopped && entry.generation === this.generation && this.entries.get(entry.surfaceId) === entry;
  }

  private update(entry: Entry, patch: Partial<DeviceCatalogSnapshot>): void {
    if (!this.isCurrent(entry)) return;
    entry.snapshot = { ...entry.snapshot, ...patch };
    this.notify(entry.surfaceId);
  }

  private updateSessions(entry: Entry, workspaceId: string, patch: Partial<DeviceCatalogSessions>): void {
    if (!this.isCurrent(entry)) return;
    const current = entry.snapshot.sessions[workspaceId] ?? EMPTY_SESSIONS;
    this.update(entry, { sessions: { ...entry.snapshot.sessions, [workspaceId]: { ...current, ...patch } } });
  }

  /**
   * One notification per surface per task: a read updates status, workspaces
   * and every session page in quick succession, and subscribers (rows, device
   * status, companion, seeding) only need the settled result.
   */
  private notify(surfaceId: DeviceSurfaceId): void {
    const first = this.notifyQueue.size === 0;
    this.notifyQueue.add(surfaceId);
    if (!first) return;
    queueMicrotask(() => {
      const surfaces = Array.from(this.notifyQueue);
      this.notifyQueue.clear();
      for (const changed of surfaces) {
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(changed);
          } catch (error) {
            log.warn('Device catalog listener threw', error);
          }
        }
      }
    });
  }

  private invalidateNow(entry: Entry): Promise<void> {
    if (!this.isCurrent(entry)) return Promise.resolve();
    return entry.sync.invalidate();
  }

  private async read(entry: Entry): Promise<void> {
    if (!this.isCurrent(entry)) return;
    const scope = entry.pendingScope;
    entry.pendingScope = 'sessions';
    // A session-only change (turn started/ended, title) leaves the workspace
    // list as it is: refresh the session pages without re-reading it.
    if (scope === 'sessions' && entry.snapshot.status === 'ready' && !entry.snapshot.error) {
      const workspaces = entry.snapshot.workspaces.map(workspace => workspace.id);
      const targets = entry.activityRetain > 0 ? workspaces
        : Array.from(entry.workspaceRetain.keys()).filter(workspaceId => workspaces.includes(workspaceId));
      await this.loadSessionPages(entry, targets, false);
      return;
    }
    this.update(entry, { status: entry.snapshot.status === 'ready' ? 'ready' : 'loading', error: undefined });
    try {
      const [, raw] = await Promise.all([
        this.negotiate(entry),
        this.io.invoke<APIWorkspaceInfo[]>(entry.deviceId, 'get_opened_workspaces', { request: {} }),
      ]);
      if (!this.isCurrent(entry)) return;
      // The same display order the live list of this device uses.
      const workspaces = stableWorkspaceOrder(entry.surfaceId,
        upgradeLegacyWorktreeReferences(Array.isArray(raw) ? raw : []).map(mapWorkspaceInfo));
      const opened = new Set(workspaces.map(workspace => workspace.id));
      const sessions = Object.fromEntries(Object.entries(entry.snapshot.sessions)
        .filter(([workspaceId]) => opened.has(workspaceId)));
      this.update(entry, { status: 'ready', workspaces, sessions, error: undefined });
      const targets = entry.activityRetain > 0
        ? workspaces.map(workspace => workspace.id)
        : Array.from(entry.workspaceRetain.keys()).filter(workspaceId => opened.has(workspaceId));
      await this.loadSessionPages(entry, targets, false);
    } catch (error) {
      if (!this.isCurrent(entry)) return;
      log.warn('Failed to read device workspace catalog', { surfaceId: entry.surfaceId, error });
      // Keep what was rendered; the section offers a retry.
      this.update(entry, { status: entry.snapshot.workspaces.length > 0 ? 'ready' : 'error', error: errorText(error) });
    }
  }

  /** Learn whether the host addresses sessions by workspace id. */
  private negotiate(entry: Entry): Promise<void> {
    if (entry.workspaceIdReferences !== null) return Promise.resolve();
    entry.negotiation ??= this.io.invoke<{ capabilities?: Record<string, boolean> } | undefined>(
      entry.deviceId, 'peer_mode_ping', {},
    ).then(ping => {
      entry.workspaceIdReferences = ping?.capabilities?.workspace_id_references_v1 === true;
    }).finally(() => { entry.negotiation = null; });
    return entry.negotiation;
  }

  private workspaceRequest(entry: Entry, workspace: WorkspaceInfo): Record<string, unknown> {
    if (entry.workspaceIdReferences) return { workspace_id: workspace.id };
    // Pre-ID hosts address sessions by their own root; never a controller path.
    const remote = workspace.workspaceKind === 'remote';
    return {
      workspace_path: workspace.rootPath,
      remote_connection_id: remote ? workspace.connectionId : undefined,
      remote_ssh_host: remote ? workspace.sshHost : undefined,
    };
  }

  /** Refresh several workspaces with bounded concurrency. */
  private async loadSessionPages(entry: Entry, workspaceIds: readonly string[], onlyMissing: boolean): Promise<void> {
    const queue = workspaceIds.filter(workspaceId => !onlyMissing
      || this.getSessions(entry.surfaceId, workspaceId).status === 'idle');
    const worker = async () => {
      for (let workspaceId = queue.shift(); workspaceId !== undefined; workspaceId = queue.shift()) {
        if (!this.isCurrent(entry)) return;
        await this.loadSessions(entry, workspaceId, this.getSessions(entry.surfaceId, workspaceId).limit);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SESSION_READ_CONCURRENCY, queue.length) }, worker));
  }

  private async loadSessions(entry: Entry, workspaceId: string, limit: number): Promise<void> {
    if (!this.isCurrent(entry)) return;
    const workspace = entry.snapshot.workspaces.find(candidate => candidate.id === workspaceId);
    if (!workspace) return;
    const read = (entry.sessionReads.get(workspaceId) ?? 0) + 1;
    entry.sessionReads.set(workspaceId, read);
    const latest = () => this.isCurrent(entry) && entry.sessionReads.get(workspaceId) === read;
    this.updateSessions(entry, workspaceId, { status: 'loading', limit, error: undefined });
    try {
      await this.negotiate(entry);
      const sessions: SessionMetadata[] = [];
      const records: SessionMetadata[] = [];
      const activities: Record<string, SessionActivitySummary> = {};
      let cursor: string | undefined;
      let hasMore = false;
      let total: number | null = null;
      for (let page = 0; page < MAX_PAGES_PER_READ; page += 1) {
        const result = await this.io.invoke<SessionMetadataPage>(entry.deviceId, 'list_persisted_sessions_page', {
          request: {
            ...this.workspaceRequest(entry, workspace),
            limit,
            ...(cursor ? { cursor } : {}),
          },
        });
        if (!latest()) return;
        for (const session of result?.sessions ?? []) {
          if (session.status === 'archived') continue;
          records.push(session);
          if (isTopLevel(session)) sessions.push(session);
        }
        for (const activity of result?.activities ?? []) activities[activity.sessionId] = activity;
        hasMore = result?.hasMore === true;
        cursor = result?.nextCursor;
        total = typeof result?.totalTopLevelCount === 'number' ? result.totalTopLevelCount : null;
        if (!hasMore || !cursor || sessions.length >= limit) break;
      }
      this.updateSessions(entry, workspaceId, {
        status: 'ready',
        sessions: sessions.slice(0, limit),
        records,
        activities,
        hasMore: hasMore || sessions.length > limit,
        total,
        limit,
        error: undefined,
      });
    } catch (error) {
      if (!latest()) return;
      log.warn('Failed to read device sessions', { surfaceId: entry.surfaceId, workspaceId, error });
      // A host that refused the request may have been replaced by another
      // build (upgrade or downgrade): ask again how it addresses sessions.
      if ((error as Error | undefined)?.name === 'DeviceCatalogCommandError' && !isLocalSurface(entry.surfaceId)) {
        entry.workspaceIdReferences = null;
      }
      const current = this.getSessions(entry.surfaceId, workspaceId);
      this.updateSessions(entry, workspaceId, {
        status: current.sessions.length > 0 ? 'ready' : 'error',
        error: errorText(error),
      });
    }
  }

  private startStream(entry: Entry): void {
    if (entry.deviceId === null || entry.streamSubscriptionId !== null || entry.streamPending) return;
    entry.streamPending = true;
    const deviceId = entry.deviceId;
    void this.io.subscribeCatalog(deviceId).then(subscriptionId => {
      entry.streamPending = false;
      if (!this.isCurrent(entry) || entry.retainCount === 0) {
        void this.io.unsubscribeCatalog(subscriptionId).catch(() => undefined);
        return;
      }
      entry.streamSubscriptionId = subscriptionId;
      this.update(entry, { live: true });
    }, error => {
      entry.streamPending = false;
      // An older host has no catalog stream; visibility refresh covers it.
      log.info('Device catalog stream unavailable', { deviceId, error: errorText(error) });
      this.update(entry, { live: false });
    });
  }

  private stopStream(entry: Entry): void {
    const subscriptionId = entry.streamSubscriptionId;
    entry.streamSubscriptionId = null;
    if (subscriptionId) {
      void this.io.unsubscribeCatalog(subscriptionId).catch(error => {
        log.warn('Device catalog unsubscribe failed', { surfaceId: entry.surfaceId, error });
      });
    }
    if (entry.snapshot.live) this.update(entry, { live: false });
  }

  private stop(entry: Entry): void {
    this.stopStream(entry);
    entry.stopped = true;
    entry.sync.stop();
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    if (entry.releaseTimer !== null) clearTimeout(entry.releaseTimer);
    entry.debounceTimer = null;
    entry.releaseTimer = null;
  }

  private installEvents(): void {
    if (this.teardownEvents) return;
    const disposers: Array<() => void> = [];
    // Observers only see events that have a native listener registered.
    disposers.push(this.io.listen('host-catalog-changed', () => undefined));
    disposers.push(this.io.listen('account://login-state', () => this.reset()));
    disposers.push(this.io.listen('account://session-sync-error', payload => {
      const event = payload as { sessionId?: string; targetDeviceId?: string } | null;
      if (event?.sessionId !== HOST_CATALOG_ID || !event.targetDeviceId) return;
      const entry = this.entries.get(surfaceIdForDevice(event.targetDeviceId));
      if (!entry) return;
      entry.streamSubscriptionId = null;
      this.update(entry, { live: false });
    }));
    disposers.push(observeSurfaceEvents((event, sourceDeviceId, payload) => {
      if (!CATALOG_INVALIDATING_EVENTS.has(event)) return;
      const surfaceId = surfaceIdForDevice(sourceDeviceId);
      // The rendered device is drawn from its live container.
      if (surfaceId === getActiveSurfaceId()) return;
      this.invalidate(surfaceId, this.hintScope(surfaceId, event, payload));
    }));
    const flushDeferred = () => {
      if (this.deferred.size === 0) return;
      const pending = Array.from(this.deferred);
      this.deferred.clear();
      for (const [surfaceId, scope] of pending) this.invalidate(surfaceId, scope);
    };
    disposers.push(useDeviceOpenIntent.subscribe(state => {
      if (!state.intent) flushDeferred();
    }));
    // The device just left was not refreshed while rendered; read it again.
    // The device now rendered is drawn from its live list and needs no read.
    let previousRendered = getActiveSurfaceId();
    disposers.push(onSurfaceActivated(() => {
      const rendered = getActiveSurfaceId();
      const departed = previousRendered;
      previousRendered = rendered;
      if (departed !== rendered) this.invalidate(departed);
    }));
    if (typeof document !== 'undefined') {
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return;
        flushDeferred();
        for (const entry of this.entries.values()) {
          if (!entry.snapshot.live) this.invalidate(entry.surfaceId);
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      disposers.push(() => document.removeEventListener('visibilitychange', onVisible));
    }
    // A host without the catalog stream sends no hints: re-read the devices
    // shown from it now and then, only while the window is visible.
    const poll = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const rendered = getActiveSurfaceId();
      for (const entry of this.entries.values()) {
        if (!entry.snapshot.live && entry.surfaceId !== rendered && entry.snapshot.status === 'ready') {
          this.invalidate(entry.surfaceId);
        }
      }
    }, DEVICE_CATALOG_POLL_MS);
    disposers.push(() => clearInterval(poll));
    this.teardownEvents = () => {
      for (const dispose of disposers) dispose();
    };
  }

  /**
   * The catalog stream hint names which revision moved: an unchanged
   * workspaces revision means only session pages need a read. Lifecycle events
   * are session facts; a workspace catalog event changes the list.
   */
  private hintScope(surfaceId: DeviceSurfaceId, event: string, payload: unknown): RefreshScope {
    if (event === 'workspace-catalog-changed') return 'all';
    if (event !== 'host-catalog-changed') return 'sessions';
    const entry = this.entries.get(surfaceId);
    const revision = (payload as { workspacesRevision?: unknown } | null)?.workspacesRevision;
    if (!entry || revision === undefined) return 'all';
    const changed = entry.workspacesRevision !== undefined && entry.workspacesRevision !== revision;
    const first = entry.workspacesRevision === undefined;
    entry.workspacesRevision = revision;
    return changed || first ? 'all' : 'sessions';
  }

  /** Tests only. */
  dispose(): void {
    this.generation += 1;
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
    this.teardownEvents?.();
    this.teardownEvents = null;
    this.listeners.clear();
  }
}

/** Window-wide: sections mount and unmount, the catalog cache does not. */
export const deviceWorkspaceCatalog = new DeviceWorkspaceCatalog();
