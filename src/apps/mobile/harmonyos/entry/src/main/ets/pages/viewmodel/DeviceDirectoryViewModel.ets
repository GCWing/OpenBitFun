import { RecentWorkspaceEntry, RemoteSession, SessionListResult } from '../../model/RemoteModels';
import {
  AccountDeviceDirectory,
  AccountDeviceDirectorySource
} from '../../services/AccountDeviceDirectory';
import { CloudAccountBinding, CloudAccountDevice, CloudAccountSession } from '../../services/CloudAccountClient';
import { DeviceDirectoryCoordinator } from '../../services/DeviceDirectoryCoordinator';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RemoteLogger } from '../../services/RemoteLogger';
import { RemoteSessionListStore } from '../../services/RemoteSessionListCache';
import { remoteSessionBelongsToWorkspace, stampRemoteSessionsWorkspace, stampRemoteSessionsDevice } from '../../services/RemoteSessionIdentity';
import { RemoteUiState } from '../../services/RemoteUiState';
import { mapInConcurrentBatches, CONCURRENT_WORKSPACE_LISTINGS } from '../../services/ConcurrentWorkspaceListing';
import {
  DeviceDirectoryEntry,
  DeviceDirectoryState,
  WorkspaceDirectoryState,
  emptyDeviceDirectoryEntry
} from '../state/DeviceDirectoryState';

export interface DeviceDirectoryViewModelHooks {
  readonly credentials: () => CloudAccountBinding | undefined;
  readonly activeDeviceId: () => string;
  /** Whether the conversation link to [activeDeviceId] is currently live. */
  readonly activeDeviceConnected: () => boolean;
  readonly loadActiveWorkspaceSessions?: (path: string, remoteConnectionId?: string, remoteSshHost?: string) => Promise<SessionListResult>;
  readonly onActiveWorkspaceSessions?: (path: string, result: SessionListResult, remoteConnectionId?: string, remoteSshHost?: string) => void;
}

interface DeviceCatalogRequest {
  entry: DeviceDirectoryEntry;
  session: CloudAccountSession | undefined;
  relayUrl: string | undefined;
}

/** Selection, loading, and retry for the sidebar's device directory. */
export class DeviceDirectoryViewModel {
  private readonly state: DeviceDirectoryState;
  private readonly store?: RemoteSessionListStore;
  private readonly hooks: DeviceDirectoryViewModelHooks;
  private readonly directory?: AccountDeviceDirectorySource;
  private readonly inFlight: Map<string, DeviceCatalogRequest> = new Map<string, DeviceCatalogRequest>();
  private readonly workspaceInFlight: Map<WorkspaceDirectoryState, Promise<void>> =
    new Map<WorkspaceDirectoryState, Promise<void>>();
  /** Device whose control-target catalog request currently owns `loading`. */
  private liveCatalogDeviceId: string = '';

  constructor(
    state: DeviceDirectoryState,
    hooks: DeviceDirectoryViewModelHooks,
    store?: RemoteSessionListStore,
    directory?: AccountDeviceDirectorySource
  ) {
    this.state = state;
    this.hooks = hooks;
    this.store = store;
    this.directory = directory;
  }

  async refreshDevices(load: () => Promise<void>): Promise<void> {
    if (this.state.refreshing) return;
    const binding = this.hooks.credentials();
    if (!binding) return;
    const generation = ++this.state.refreshGeneration;
    const current = (): boolean => {
      const now = this.hooks.credentials();
      return generation === this.state.refreshGeneration && binding.session === now?.session && binding.relayUrl === now?.relayUrl;
    };
    this.state.refreshing = true; this.state.refreshError = '';
    try {
      await load();
      if (current()) await this.refreshExpandedWorkspaceSessions();
    } catch (error) {
      if (current()) this.state.refreshError = error instanceof Error ? error.message : RemoteI18n.t('remote.settings.deviceLoadFailed');
    } finally {
      if (generation === this.state.refreshGeneration) this.state.refreshing = false;
    }
  }

  /**
   * Re-runs the device sync against the current active id.
   *
   * Nothing about a row's own fields changes here — that is the point. It is
   * the seam the control-target switch goes through, so what it guards is that
   * a catalog captured off the live page survives the device ceasing to be
   * live.
   */
  refreshActive(): void {
    this.syncDevices(this.state.devices.map((item: DeviceDirectoryEntry): CloudAccountDevice => {
      return {
        deviceId: item.deviceId,
        deviceName: item.deviceName,
        online: item.online
      };
    }));
  }

  /**
   * Mirrors the live conversation device onto its directory row.
   *
   * The active row reads RemotePageState, so this snapshot is what remains
   * after the control target moves on. Empty payloads are ignored so the
   * teardown that clears the live page cannot wipe a row we just captured.
   */
  captureLive(
    deviceId: string,
    workspaces: RecentWorkspaceEntry[],
    sessions: RemoteSession[]
  ): void {
    const target = deviceId.trim();
    if (target.length === 0) {
      return;
    }
    const entry = this.state.find(target);
    if (!entry) {
      return;
    }
    if (workspaces.length === 0 && sessions.length === 0) {
      return;
    }
    if (workspaces.length > 0 && entry.catalogSource.length === 0) {
      entry.workspaces = workspaces;
    }
    if (sessions.length > 0) {
      entry.sessions = RemoteUiState.mergeSessions(
        stampRemoteSessionsDevice(sessions, target),
        entry.sessions
      );
    }
    if (entry.status === 'loading') {
      // A live-catalog request belongs to the control-target lifecycle. Once
      // that target is being torn down, the request can no longer complete
      // this row. Leave any captured snapshot as cache, otherwise make the row
      // fetchable again instead of stranding it in a false loading state.
      entry.status = entry.workspaces.length > 0 || entry.sessions.length > 0 ? 'cached' : 'idle';
    } else if (entry.status === 'idle' || entry.status === 'cached') {
      entry.status = 'ready';
    }
  }

  /** Marks the incoming target's catalog request before its handshake starts. */
  beginLiveCatalog(deviceId: string): void {
    const target = deviceId.trim();
    if (target.length === 0) {
      return;
    }
    if (this.liveCatalogDeviceId.length > 0 && this.liveCatalogDeviceId !== target) {
      this.releaseAbandonedLiveCatalog(this.liveCatalogDeviceId);
    }
    const entry = this.state.find(target);
    if (!entry) {
      return;
    }
    this.inFlight.delete(target);
    this.liveCatalogDeviceId = target;
    entry.status = 'loading';
    entry.errorText = '';
  }

  /**
   * Starts the directory projection for a newly activated control target.
   *
   * This is deliberately different from `captureLive`: the outgoing snapshot
   * ignores empty teardown values, while an incoming empty catalog is real and
   * must replace whatever was cached for this row. Conflating the two lifecycle
   * edges is what allowed one desktop's workspaces to be stamped onto another.
   */
  activateLive(
    deviceId: string,
    workspaces: RecentWorkspaceEntry[],
    sessions: RemoteSession[]
  ): void {
    const target = deviceId.trim();
    if (target.length === 0) {
      return;
    }
    const entry = this.state.find(target);
    if (!entry) {
      return;
    }
    // A successful handshake starts a new directory generation even when the
    // transport changed while the desktop id stayed the same (for example,
    // scan-room -> account-device). The handshake replaces cross-workspace
    // sessions below, so the old generation's `ready` flags cannot survive it.
    this.state.resetWorkspaceDirectory(target);
    if (entry.catalogSource.length === 0) entry.workspaces = [];
    // The workspace catalog is loaded independently of the handshake.
    // The handshake is the authoritative snapshot for the incoming target.
    // Merging the row's old cache here makes any historical cross-device
    // misattribution immortal, because those stale sessions never disappear.
    entry.sessions = stampRemoteSessionsDevice(sessions, target);
    // The handshake only carries the current workspace and sessions. The full
    // recent-workspace request starts immediately afterwards, so even an empty
    // target-scoped projection is still loading rather than a confirmed empty
    // catalog.
    entry.status = 'loading';
    entry.errorText = '';
  }

  /** Publishes the authoritative full catalog returned by the live target. */
  completeLiveCatalog(deviceId: string, workspaces: RecentWorkspaceEntry[], source?: string, recentWorkspaces?: RecentWorkspaceEntry[]): void {
    const target = deviceId.trim();
    const entry = this.state.find(target);
    if (!entry) {
      return;
    }
    entry.workspaces = workspaces.slice();
    entry.catalogSource = source || "recent";
    entry.recentWorkspaces = recentWorkspaces || workspaces;
    entry.status = 'ready';
    entry.errorText = '';
    if (this.liveCatalogDeviceId === target) {
      this.liveCatalogDeviceId = '';
    }
  }

  /** Ends a live catalog request as failed so retry reflects real transport state. */
  failLiveCatalog(deviceId: string): void {
    const target = deviceId.trim();
    const entry = this.state.find(target);
    if (!entry) {
      return;
    }
    entry.status = 'failed';
    entry.errorText = '';
    if (this.liveCatalogDeviceId === target) {
      this.liveCatalogDeviceId = '';
    }
  }

  private releaseAbandonedLiveCatalog(deviceId: string): void {
    const entry = this.state.find(deviceId);
    if (entry && entry.status === 'loading') {
      entry.status = entry.workspaces.length > 0 || entry.sessions.length > 0 ? 'cached' : 'idle';
    }
    this.liveCatalogDeviceId = '';
  }

  syncDevices(devices: CloudAccountDevice[]): void {
    const activeId = this.hooks.activeDeviceId();
    const activeConnected = this.hooks.activeDeviceConnected();
    const next: DeviceDirectoryEntry[] = devices.map((device: CloudAccountDevice): DeviceDirectoryEntry => {
      // The relay's presence flag is hearsay: it is a projection of a socket
      // registry that can lag or lose an entry. A live conversation link is
      // first-hand proof, so it wins. Without this the desktop we are pinging
      // every fifteen seconds can render as a greyed-out offline row.
      const online = device.online ||
        (device.deviceId === activeId && activeId.length > 0 && activeConnected);
      if (online !== device.online) {
        // Only the disagreement is worth a line. It is rare, it is the whole
        // reason this branch exists, and it is what the next person chasing a
        // wrongly-greyed row will grep for.
        RemoteLogger.info(`device presence override device=${device.deviceId} relay=offline link=live`);
      }
      const existing = this.state.find(device.deviceId);
      if (existing) {
        existing.deviceName = device.deviceName || existing.deviceName;
        if (existing.online && !online) {
          existing.expanded = false;
          this.inFlight.delete(device.deviceId);
          if (existing.status === 'loading') existing.status = 'idle';
        }
        existing.online = online;
        return existing;
      }
      const isActive = device.deviceId === activeId && online;
      const created = emptyDeviceDirectoryEntry(
        device.deviceId,
        device.deviceName || device.deviceId,
        online
      );
      created.expanded = isActive;
      return created;
    });
    this.state.replace(next);
    if (this.state.find(this.state.selectedDeviceId) ||
      (this.state.selectedDeviceId === activeId && activeId.length > 0 && activeConnected)) {
      return;
    }
    // A live control target is transport state, not a user selection in the
    // directory. Expanding it here made a freshly signed-in sidebar show a
    // workspace loader before the user had chosen any device.
    this.state.select('');
  }

  async hydrateKnownDevices(): Promise<void> {
    const devices = this.state.devices;
    for (let index = 0; index < devices.length; index++) {
      await this.hydrateDevice(devices[index]);
    }
  }

  async selectDevice(deviceId: string): Promise<void> {
    const target = deviceId.trim();
    const entry = this.state.find(target);
    if (!entry) {
      // A QR-paired desktop is projected into the sidebar without belonging to
      // the account directory. It is still a real selectable disclosure row
      // while its control link is live; accepting only directory entries made
      // that row render normally but ignore every tap.
      if (target.length > 0 && target === this.hooks.activeDeviceId().trim() &&
        this.hooks.activeDeviceConnected()) {
        this.state.select(target);
        RemoteLogger.info(`device directory select active projection device=${target}`);
      }
      return;
    }
    this.state.select(target);
    RemoteLogger.info(`device directory select device=${target}`);
    if (this.shouldFetch(entry)) {
      entry.status = 'loading';
      entry.errorText = '';
    }
    await this.ensureLoaded(target);
  }

  async retryDevice(deviceId: string): Promise<void> {
    const entry = this.state.find(deviceId);
    if (!entry) {
      return;
    }
    this.state.select(deviceId);
    await this.loadDevice(deviceId);
  }

  /**
   * Loads exactly one workspace after its disclosure opens.
   *
   * Device selection deliberately stops at the workspace catalog; fanning out
   * every workspace here was both expensive and the source of unrelated row
   * updates while the user was only opening one branch.
   */
  async loadWorkspaceSessions(deviceId: string, path: string, remoteConnectionId?: string, remoteSshHost?: string): Promise<void> {
    const entry = this.state.find(deviceId);
    const normalizedPath = path.trim();
    const active = deviceId === this.hooks.activeDeviceId() && this.hooks.activeDeviceConnected();
    if (normalizedPath.length === 0 || (!active && (!entry || !entry.online))) {
      return;
    }
    const scope = this.state.workspaceLoadState(deviceId, normalizedPath, remoteConnectionId, remoteSshHost);
    const pending = this.workspaceInFlight.get(scope);
    if (pending) {
      return pending;
    }
    const request = this.fetchWorkspaceSessions(scope, entry, normalizedPath, active);
    this.workspaceInFlight.set(scope, request);
    try {
      await request;
    } finally {
      this.workspaceInFlight.delete(scope);
    }
  }

  /** Refresh only the workspace branches actually disclosed in the sidebar. */
  async refreshExpandedWorkspaceSessions(): Promise<void> {
    const selected = this.state.selectedDeviceId;
    const scopes = this.state.workspaceDirectory.filter((item: WorkspaceDirectoryState): boolean =>
      item.deviceId === selected && item.expanded
    );
    await mapInConcurrentBatches(scopes, async (scope: WorkspaceDirectoryState): Promise<void> => {
      if (!this.state.isCurrentWorkspaceLoad(scope) || !scope.expanded ||
        this.state.selectedDeviceId !== selected) return;
      try {
        await this.loadWorkspaceSessions(scope.deviceId, scope.path, scope.remoteConnectionId, scope.remoteSshHost);
      } catch (_err) {
        // Each failed branch exposes its own retry row and retains its cache.
      }
    }, CONCURRENT_WORKSPACE_LISTINGS);
  }

  private async fetchWorkspaceSessions(
    scope: WorkspaceDirectoryState,
    entry: DeviceDirectoryEntry | undefined,
    path: string,
    active: boolean
  ): Promise<void> {
    const binding = this.hooks.credentials();
    const isCurrent = (): boolean => {
      const currentBinding = this.hooks.credentials();
      return this.state.isCurrentWorkspaceLoad(scope) && this.state.find(scope.deviceId) === entry &&
        binding?.session === currentBinding?.session && binding?.relayUrl === currentBinding?.relayUrl &&
        (!active || (scope.deviceId === this.hooks.activeDeviceId() && this.hooks.activeDeviceConnected()));
    };
    scope.status = 'loading';
    try {
      if (active && this.hooks.loadActiveWorkspaceSessions && this.hooks.onActiveWorkspaceSessions) {
        const result = await this.hooks.loadActiveWorkspaceSessions(path, scope.remoteConnectionId, scope.remoteSshHost);
        if (!isCurrent()) return;
        this.captureWorkspaceSessions(scope.deviceId, path, result.sessions, scope.remoteConnectionId, scope.remoteSshHost);
        this.hooks.onActiveWorkspaceSessions(path, result, scope.remoteConnectionId, scope.remoteSshHost);
      } else {
        const source = this.directorySource();
        if (!source || !entry) throw new Error('Account device directory is unavailable.');
        const sessions = await new DeviceDirectoryCoordinator(source).loadWorkspaceSessions(scope.deviceId, path, scope.remoteConnectionId, scope.remoteSshHost);
        if (!isCurrent()) return;
        entry.sessions = DeviceDirectoryViewModel.replaceWorkspaceSessions(entry.sessions, path, sessions, scope.remoteConnectionId, scope.remoteSshHost, entry.workspaces);
        await this.persistDevice(scope.deviceId, entry.workspaces, entry.sessions);
      }
      if (isCurrent()) {
        scope.hasLoadedSessions = true;
        scope.status = 'ready';
      }
    } catch (err) {
      if (isCurrent()) {
        scope.status = 'failed';
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // A target switch can abandon a live request without replacing this
      // device's disclosure object. Do not strand it in `loading` on return.
      if (this.state.isCurrentWorkspaceLoad(scope) && scope.status === 'loading') scope.status = 'idle';
    }
  }

  /** Replaces one refreshed workspace while preserving every cached sibling. */
  captureWorkspaceSessions(deviceId: string, path: string, sessions: RemoteSession[], remoteConnectionId?: string, remoteSshHost?: string): void {
    const entry = this.state.find(deviceId.trim());
    const normalizedPath = path.trim();
    if (!entry || normalizedPath.length === 0) {
      return;
    }
    entry.sessions = DeviceDirectoryViewModel.replaceWorkspaceSessions(
      entry.sessions,
      normalizedPath,
      stampRemoteSessionsDevice(stampRemoteSessionsWorkspace(sessions, normalizedPath, remoteConnectionId, remoteSshHost), deviceId.trim()), remoteConnectionId, remoteSshHost, entry.workspaces
    );
  }

  async ensureLoaded(deviceId: string): Promise<void> {
    const entry = this.state.find(deviceId);
    if (!entry) {
      return;
    }
    if (deviceId === this.hooks.activeDeviceId()) {
      return;
    }
    if (!entry.online) {
      return;
    }
    if (entry.status === 'ready') {
      return;
    }
    await this.loadDevice(deviceId);
  }

  private shouldFetch(entry: DeviceDirectoryEntry): boolean {
    if (entry.deviceId === this.hooks.activeDeviceId()) {
      return false;
    }
    if (!entry.online) {
      return false;
    }
    return entry.status === 'idle' || entry.status === 'cached' || entry.status === 'failed';
  }

  private async loadDevice(deviceId: string): Promise<void> {
    const entry = this.state.find(deviceId);
    if (!entry) {
      return;
    }
    if (deviceId === this.hooks.activeDeviceId()) {
      return;
    }
    if (!entry.online) {
      return;
    }
    const binding = this.hooks.credentials();
    const pending = this.inFlight.get(deviceId);
    if (pending && pending.entry === entry && pending.session === binding?.session &&
      pending.relayUrl === binding?.relayUrl) {
      return;
    }
    const source = this.directorySource();
    if (!source) {
      entry.status = 'failed';
      entry.errorText = RemoteI18n.t('remote.settings.accountNotSignedIn');
      return;
    }
    const request: DeviceCatalogRequest = {
      entry, session: binding?.session, relayUrl: binding?.relayUrl
    };
    this.inFlight.set(deviceId, request);
    const isCurrent = (): boolean => {
      const currentBinding = this.hooks.credentials();
      return this.inFlight.get(deviceId) === request && this.state.find(deviceId) === entry &&
        entry.online && request.session === currentBinding?.session &&
        request.relayUrl === currentBinding?.relayUrl && deviceId !== this.hooks.activeDeviceId();
    };
    entry.status = 'loading';
    entry.errorText = '';
    try {
      const coordinator = new DeviceDirectoryCoordinator(source);
      const catalog = await coordinator.loadWorkspaceCatalog(deviceId);
      if (!isCurrent()) return;
      entry.workspaces = catalog.workspaces;
      entry.catalogSource = catalog.source;
      entry.recentWorkspaces = catalog.recentWorkspaces;
      entry.status = 'ready';
      entry.errorText = '';
      await this.persistDevice(deviceId, entry.workspaces, entry.sessions);
    } catch (err) {
      if (!isCurrent()) return;
      // The retry row carries a localized line of its own. What the transport
      // throws is English and frequently a stack, so it stays in the log, which
      // is the only place it reads as anything but noise.
      RemoteLogger.warn(`device directory load failed device=${deviceId}: ${String(err)}`);
      entry.status = 'failed';
      entry.errorText = '';
    } finally {
      if (this.inFlight.get(deviceId) === request) {
        this.inFlight.delete(deviceId);
        if (entry.status === 'loading') entry.status = 'idle';
      }
    }
  }

  private async hydrateDevice(entry: DeviceDirectoryEntry): Promise<void> {
    const binding = this.hooks.credentials();
    const previousWorkspaces = entry.workspaces;
    const previousSessions = entry.sessions;
    const workspaces = this.store ?
      await DeviceDirectoryViewModel.safeWorkspaces(this.store, entry.deviceId) : [];
    const sessions = this.store ?
      await DeviceDirectoryViewModel.safeSessions(this.store, entry.deviceId) : [];
    const currentBinding = this.hooks.credentials();
    if (this.state.find(entry.deviceId) !== entry || binding?.session !== currentBinding?.session ||
      binding?.relayUrl !== currentBinding?.relayUrl) return;
    if (workspaces.length === 0 && sessions.length === 0) {
      return;
    }
    if (workspaces.length > 0 && entry.catalogSource.length === 0 && entry.workspaces === previousWorkspaces) {
      entry.workspaces = workspaces;
    }
    if (sessions.length > 0 && entry.sessions === previousSessions) {
      entry.sessions = stampRemoteSessionsDevice(sessions, entry.deviceId);
    }
    if (entry.status === 'idle') {
      entry.status = 'cached';
    }
  }

  private directorySource(): AccountDeviceDirectorySource | undefined {
    if (this.directory) {
      return this.directory;
    }
    const context = this.hooks.credentials();
    return context ? new AccountDeviceDirectory(context) : undefined;
  }

  private async persistDevice(
    deviceId: string,
    workspaces: RecentWorkspaceEntry[],
    sessions: RemoteSession[]
  ): Promise<void> {
    try {
      if (this.store) {
        await this.store.saveWorkspaces(deviceId, workspaces);
        await this.store.saveObservedList(deviceId, sessions, false);
      }
    } catch (err) {
      RemoteLogger.warn(`device directory persist failed device=${deviceId}: ${String(err)}`);
    }
  }

  private static async safeWorkspaces(
    store: RemoteSessionListStore,
    deviceId: string
  ): Promise<RecentWorkspaceEntry[]> {
    try {
      return await store.loadWorkspaces(deviceId);
    } catch (err) {
      RemoteLogger.warn(`device workspace cache read failed device=${deviceId}: ${String(err)}`);
      return [];
    }
  }

  private static async safeSessions(
    store: RemoteSessionListStore,
    deviceId: string
  ): Promise<RemoteSession[]> {
    try {
      return (await store.loadList(deviceId)).sessions;
    } catch (err) {
      RemoteLogger.warn(`device session cache read failed device=${deviceId}: ${String(err)}`);
      return [];
    }
  }

  private static replaceWorkspaceSessions(
    current: RemoteSession[],
    path: string,
    replacement: RemoteSession[], remoteConnectionId?: string, remoteSshHost?: string, catalog: RecentWorkspaceEntry[] = []
  ): RemoteSession[] {
    const preserved = current.filter((item: RemoteSession): boolean => {
      return !remoteSessionBelongsToWorkspace(item, { path, remoteConnectionId, remoteSshHost }, catalog);
    });
    return replacement.concat(preserved);
  }
}
