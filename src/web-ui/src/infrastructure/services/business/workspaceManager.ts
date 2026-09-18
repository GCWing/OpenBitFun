 

import type {
  RemoteWorkspaceSnapshot,
  WorkspaceInfo,
} from '../../../shared/types';
import {
  WorkspaceKind,
  globalStateAPI,
  isRemoteWorkspace,
} from '../../../shared/types';
import { normalizeRemoteWorkspacePath } from '@/shared/utils/pathUtils';
import { createLogger } from '@/shared/utils/logger';
import { startupTrace } from '@/shared/utils/startupTrace';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { listen } from '@tauri-apps/api/event';
import {
  LOCAL_SURFACE_ID,
  SurfaceChangedError,
  getActiveSurfaceId,
  getActiveSurfaceScope,
  isSurfaceChangedError,
  onSurfaceActivated,
  type DeviceSurfaceId,
  type SurfaceScope,
} from '@/infrastructure/peer-device/deviceSurface';
import { routeSurfaceEvent } from '@/infrastructure/peer-device/deviceSurfaceRouting';

const log = createLogger('WorkspaceManager');

/**
 * Host hint that the opened/recent workspace catalog changed behind this
 * surface's back (a remote controller, IM bot, or another surface opened,
 * created, or closed a workspace). Mirrors the Rust
 * `WORKSPACE_CATALOG_CHANGED_EVENT`; the payload carries no catalog data.
 */
export const WORKSPACE_CATALOG_CHANGED_EVENT = 'workspace-catalog-changed';

interface WorkspaceCatalogChangedEvent {
  revision?: number;
}

function markWorkspaceStartupStepStart(step: string): number {
  const startedAt = nowMs();
  startupTrace.markPhase('workspace_startup_step_start', { step });
  return startedAt;
}

function markWorkspaceStartupStepEnd(
  step: string,
  startedAt: number,
  data?: Record<string, unknown>
): void {
  startupTrace.markPhase('workspace_startup_step_end', {
    step,
    durationMs: elapsedMs(startedAt),
    ...(data ?? {}),
  });
}

interface WorkspaceIdentityChangedEvent {
  workspaceId: string;
  workspacePath: string;
  name: string;
  identity: WorkspaceInfo['identity'];
  changedFields: string[];
}

export type WorkspaceEvent =
  | { type: 'workspace:opened'; workspace: WorkspaceInfo }
  | { type: 'workspace:closed'; workspaceId: string }
  | { type: 'workspace:removed'; workspaceId: string }
  | { type: 'workspace:switched'; workspace: WorkspaceInfo }
  | { type: 'workspace:active-changed'; workspace: WorkspaceInfo | null }
  | { type: 'workspace:primary-assistant-changed'; workspace: WorkspaceInfo }
  | { type: 'workspace:updated'; workspace: WorkspaceInfo }
  | { type: 'workspace:recent-updated' }
  | { type: 'workspace:loading'; loading: boolean }
  | { type: 'workspace:error'; error: string | null };

export type WorkspaceEventListener = (event: WorkspaceEvent) => void;

export interface WorkspaceState {
  currentWorkspace: WorkspaceInfo | null;
  openedWorkspaces: Map<string, WorkspaceInfo>;
  activeWorkspaceId: string | null;
  lastUsedWorkspaceId: string | null;
  recentWorkspaces: WorkspaceInfo[];
  primaryAssistantWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
}

export type WorkspaceSection = 'all' | 'assistants' | 'projects';
export type WorkspaceReorderPosition = 'before' | 'after';

/**
 * An operation pinned to the device surface it started under.
 *
 * Two things invalidate it, and both are needed: `activateSurface` moves the
 * epoch when the rendered device changes, while `clearForPeerModeSwitch()`
 * bumps the switch generation even when the same device is re-rendered.
 */
interface SurfaceCapture {
  readonly scope: SurfaceScope;
  readonly generation: number;
}

/** The single initialization allowed to write state for one surface capture. */
interface WorkspaceInitializationRun {
  readonly surface: SurfaceCapture;
  readonly promise: Promise<void>;
}

interface WorkspaceSurfaceContainer {
  state: WorkspaceState;
  isInitialized: boolean;
  startupLegacyRemoteWorkspaceSnapshotAvailable: boolean;
  startupLegacyRemoteWorkspaceSnapshotConsumed: boolean;
  startupLegacyRemoteWorkspace: RemoteWorkspaceSnapshot | null;
  /** A host catalog re-read is running for this surface. */
  catalogResyncInFlight: boolean;
  /** A catalog hint arrived while a re-read (or the bootstrap) was running. */
  catalogResyncPending: boolean;
}

function createWorkspaceSurfaceContainer(): WorkspaceSurfaceContainer {
  return {
    state: {
      currentWorkspace: null,
      openedWorkspaces: new Map(),
      activeWorkspaceId: null,
      lastUsedWorkspaceId: null,
      recentWorkspaces: [],
      primaryAssistantWorkspaceId: null,
      loading: true,
      error: null,
    },
    isInitialized: false,
    startupLegacyRemoteWorkspaceSnapshotAvailable: false,
    startupLegacyRemoteWorkspaceSnapshotConsumed: false,
    startupLegacyRemoteWorkspace: null,
    catalogResyncInFlight: false,
    catalogResyncPending: false,
  };
}

class WorkspaceManager {
  private static instance: WorkspaceManager | null = null;
  private readonly surfaceContainers = new Map<DeviceSurfaceId, WorkspaceSurfaceContainer>();
  private listeners: Set<WorkspaceEventListener> = new Set();
  private switchGeneration = 0;
  private activeInitialization: WorkspaceInitializationRun | null = null;
  private identityEventListening = false;
  private identityListenerReady = false;
  private identityListenerRegistrationPromise: Promise<void> | null = null;
  /** The identity watcher is local-Tauri-only, so its missed-event resync is too. */
  private localIdentityListenerReadyResyncPending = false;
  private catalogListenerRegistered = false;

  private constructor() {
    // The activation commit swaps transport before listeners run, so consumers
    // can safely render this surface's cached workspace snapshot immediately.
    onSurfaceActivated(scope => {
      this.emit({
        type: 'workspace:active-changed',
        workspace: this.state.currentWorkspace,
      });
      if (
        scope.surfaceId === LOCAL_SURFACE_ID
        && this.localIdentityListenerReadyResyncPending
        && this.identityListenerReady
        && this.isInitialized
      ) {
        void this.syncWorkspaceStateAfterIdentityListenerReady();
      }
    });
  }

  private surfaceContainer(surfaceId: DeviceSurfaceId): WorkspaceSurfaceContainer {
    const existing = this.surfaceContainers.get(surfaceId);
    if (existing) {
      return existing;
    }
    const created = createWorkspaceSurfaceContainer();
    this.surfaceContainers.set(surfaceId, created);
    return created;
  }

  private get activeSurface(): WorkspaceSurfaceContainer {
    return this.surfaceContainer(getActiveSurfaceId());
  }

  private get state(): WorkspaceState {
    return this.activeSurface.state;
  }

  private set state(state: WorkspaceState) {
    this.activeSurface.state = state;
  }

  private get isInitialized(): boolean {
    return this.activeSurface.isInitialized;
  }

  private set isInitialized(value: boolean) {
    this.activeSurface.isInitialized = value;
  }

  private get startupLegacyRemoteWorkspaceSnapshotAvailable(): boolean {
    return this.activeSurface.startupLegacyRemoteWorkspaceSnapshotAvailable;
  }

  private set startupLegacyRemoteWorkspaceSnapshotAvailable(value: boolean) {
    this.activeSurface.startupLegacyRemoteWorkspaceSnapshotAvailable = value;
  }

  private get startupLegacyRemoteWorkspaceSnapshotConsumed(): boolean {
    return this.activeSurface.startupLegacyRemoteWorkspaceSnapshotConsumed;
  }

  private set startupLegacyRemoteWorkspaceSnapshotConsumed(value: boolean) {
    this.activeSurface.startupLegacyRemoteWorkspaceSnapshotConsumed = value;
  }

  private get startupLegacyRemoteWorkspace(): RemoteWorkspaceSnapshot | null {
    return this.activeSurface.startupLegacyRemoteWorkspace;
  }

  private set startupLegacyRemoteWorkspace(value: RemoteWorkspaceSnapshot | null) {
    this.activeSurface.startupLegacyRemoteWorkspace = value;
  }

  public static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  public getState(): WorkspaceState {
    return {
      ...this.state,
      openedWorkspaces: new Map(this.state.openedWorkspaces),
    };
  }

  public addEventListener(listener: WorkspaceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public consumeStartupLegacyRemoteWorkspaceSnapshot(): {
    available: boolean;
    workspace: RemoteWorkspaceSnapshot | null;
  } {
    if (
      !this.startupLegacyRemoteWorkspaceSnapshotAvailable ||
      this.startupLegacyRemoteWorkspaceSnapshotConsumed
    ) {
      return { available: false, workspace: null };
    }

    this.startupLegacyRemoteWorkspaceSnapshotConsumed = true;
    return {
      available: true,
      workspace: this.startupLegacyRemoteWorkspace,
    };
  }

  private emit(event: WorkspaceEvent): void {
    log.debug('Emitting event', { type: event.type });
    this.listeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        log.error('Event listener execution error', { eventType: event.type, error });
      }
    });
  }

  private updateState(updates: Partial<WorkspaceState>, event?: WorkspaceEvent): void {
    this.state = {
      ...this.state,
      ...updates,
      openedWorkspaces: updates.openedWorkspaces
        ? new Map(updates.openedWorkspaces)
        : this.state.openedWorkspaces,
    };

    log.debug('State updated', {
      activeWorkspaceId: this.state.activeWorkspaceId,
      openedWorkspaceCount: this.state.openedWorkspaces.size,
    });

    if (event) {
      this.emit(event);
    }
    this.drainPendingCatalogResync();
  }

  private setLoading(loading: boolean): void {
    this.updateState({ loading }, { type: 'workspace:loading', loading });
  }

  private setError(error: string | null): void {
    this.updateState({ error }, { type: 'workspace:error', error });
  }

  private buildOpenedWorkspaceMap(workspaces: WorkspaceInfo[]): Map<string, WorkspaceInfo> {
    return new Map(workspaces.map(workspace => [workspace.id, workspace]));
  }

  private getOpenedWorkspacesList(): WorkspaceInfo[] {
    return Array.from(this.state.openedWorkspaces.values());
  }

  private isWorkspaceInSection(workspace: WorkspaceInfo, section: WorkspaceSection): boolean {
    if (section === 'all') {
      return true;
    }
    return section === 'assistants'
      ? workspace.workspaceKind === 'assistant'
      : workspace.workspaceKind !== 'assistant';
  }

  private preserveOpenedWorkspaceOrder(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
    const currentOrder = Array.from(this.state.openedWorkspaces.keys());
    const nextWorkspaceMap = this.buildOpenedWorkspaceMap(workspaces);
    const orderedWorkspaces = currentOrder
      .map(workspaceId => nextWorkspaceMap.get(workspaceId))
      .filter((workspace): workspace is WorkspaceInfo => Boolean(workspace));

    const existingIds = new Set(orderedWorkspaces.map(workspace => workspace.id));

    for (const workspace of workspaces) {
      if (!existingIds.has(workspace.id)) {
        orderedWorkspaces.push(workspace);
      }
    }

    return orderedWorkspaces;
  }

  private buildReorderedOpenedWorkspaceIds(
    section: WorkspaceSection,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    position: WorkspaceReorderPosition
  ): string[] | null {
    if (sourceWorkspaceId === targetWorkspaceId) {
      return null;
    }

    const openedWorkspaces = this.getOpenedWorkspacesList();
    const workspaceMap = this.buildOpenedWorkspaceMap(openedWorkspaces);
    const sourceWorkspace = workspaceMap.get(sourceWorkspaceId);
    const targetWorkspace = workspaceMap.get(targetWorkspaceId);

    if (!sourceWorkspace || !targetWorkspace) {
      return null;
    }

    if (
      !this.isWorkspaceInSection(sourceWorkspace, section) ||
      !this.isWorkspaceInSection(targetWorkspace, section)
    ) {
      return null;
    }

    const sectionWorkspaceIds = openedWorkspaces
      .filter(workspace => this.isWorkspaceInSection(workspace, section))
      .map(workspace => workspace.id);
    const sourceIndex = sectionWorkspaceIds.indexOf(sourceWorkspaceId);
    const targetIndex = sectionWorkspaceIds.indexOf(targetWorkspaceId);

    if (sourceIndex === -1 || targetIndex === -1) {
      return null;
    }

    const reorderedSectionWorkspaceIds = [...sectionWorkspaceIds];
    reorderedSectionWorkspaceIds.splice(sourceIndex, 1);

    const insertionBaseIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const insertionIndex = position === 'after'
      ? insertionBaseIndex + 1
      : insertionBaseIndex;

    reorderedSectionWorkspaceIds.splice(insertionIndex, 0, sourceWorkspaceId);

    const reorderedOpenedWorkspaceIds: string[] = [];
    let sectionCursor = 0;

    for (const workspace of openedWorkspaces) {
      if (this.isWorkspaceInSection(workspace, section)) {
        reorderedOpenedWorkspaceIds.push(reorderedSectionWorkspaceIds[sectionCursor]);
        sectionCursor += 1;
      } else {
        reorderedOpenedWorkspaceIds.push(workspace.id);
      }
    }

    return reorderedOpenedWorkspaceIds;
  }

  private resolveLastUsedWorkspaceId(
    currentWorkspace: WorkspaceInfo | null,
    recentWorkspaces: WorkspaceInfo[],
    openedWorkspaces: Map<string, WorkspaceInfo>
  ): string | null {
    return (
      currentWorkspace?.id ||
      recentWorkspaces[0]?.id ||
      openedWorkspaces.keys().next().value ||
      null
    );
  }

  private updateWorkspaceState(
    currentWorkspace: WorkspaceInfo | null,
    recentWorkspaces: WorkspaceInfo[],
    openedWorkspaces: WorkspaceInfo[],
    loading: boolean,
    error: string | null,
    event?: WorkspaceEvent
  ): void {
    const openedWorkspaceMap = this.buildOpenedWorkspaceMap(openedWorkspaces);

    const resolvedCurrentWorkspace = currentWorkspace
      ? openedWorkspaceMap.get(currentWorkspace.id) ?? currentWorkspace
      : null;

    this.updateState(
      {
        currentWorkspace: resolvedCurrentWorkspace,
        openedWorkspaces: openedWorkspaceMap,
        activeWorkspaceId: resolvedCurrentWorkspace?.id ?? null,
        lastUsedWorkspaceId: this.resolveLastUsedWorkspaceId(
          resolvedCurrentWorkspace,
          recentWorkspaces,
          openedWorkspaceMap
        ),
        recentWorkspaces,
        loading,
        error,
      },
      event
    );
  }

  private applyWorkspaceRecordUpdate(updatedWorkspace: WorkspaceInfo): void {
    const currentWorkspace = this.state.currentWorkspace?.id === updatedWorkspace.id
      ? updatedWorkspace
      : this.state.currentWorkspace;
    const openedWorkspaces = new Map(this.state.openedWorkspaces);
    if (openedWorkspaces.has(updatedWorkspace.id)) {
      openedWorkspaces.set(updatedWorkspace.id, updatedWorkspace);
    }
    const recentWorkspaces = this.state.recentWorkspaces.map(workspace =>
      workspace.id === updatedWorkspace.id ? updatedWorkspace : workspace
    );

    this.updateState(
      {
        currentWorkspace,
        openedWorkspaces,
        recentWorkspaces,
        activeWorkspaceId: currentWorkspace?.id ?? this.state.activeWorkspaceId,
        lastUsedWorkspaceId: this.resolveLastUsedWorkspaceId(
          currentWorkspace,
          recentWorkspaces,
          openedWorkspaces
        ),
      },
      { type: 'workspace:updated', workspace: updatedWorkspace }
    );
  }

  private async ensureIdentityChangeListener(): Promise<void> {
    if (this.identityListenerRegistrationPromise) {
      return this.identityListenerRegistrationPromise;
    }
    if (this.identityEventListening) {
      return;
    }

    this.identityEventListening = true;
    this.identityListenerReady = false;
    const registrationStartedAt = nowMs();

    const handleRegistrationFailure = (error: unknown): void => {
      this.identityEventListening = false;
      this.identityListenerReady = false;
      this.localIdentityListenerReadyResyncPending = false;
      startupTrace.markPhase('workspace_identity_listener_failed', {
        durationMs: elapsedMs(registrationStartedAt),
      });
      log.error('Failed to subscribe workspace identity updates', { error });
    };

    try {
      this.identityListenerRegistrationPromise = listen<WorkspaceIdentityChangedEvent>(
        'workspace-identity-changed',
        event => {
          // This listener is registered directly with the controller's Tauri
          // runtime and is not a peer-fanned event. Always update the local
          // container, even while the window renders a peer with equal ids.
          this.applyLocalIdentityUpdate(event.payload);
        }
      )
        .then(() => {
          this.identityListenerReady = true;
          startupTrace.markPhase('workspace_identity_listener_ready', {
            durationMs: elapsedMs(registrationStartedAt),
          });
          if (
            this.localIdentityListenerReadyResyncPending
            && getActiveSurfaceId() === LOCAL_SURFACE_ID
            && this.isInitialized
          ) {
            void this.syncWorkspaceStateAfterIdentityListenerReady();
          }
        })
        .catch(handleRegistrationFailure)
        .finally(() => {
          this.identityListenerRegistrationPromise = null;
        });
    } catch (error) {
      handleRegistrationFailure(error);
      this.identityListenerRegistrationPromise = null;
      return;
    }

    return this.identityListenerRegistrationPromise;
  }

  private async syncWorkspaceStateAfterIdentityListenerReady(): Promise<void> {
    if (
      getActiveSurfaceId() !== LOCAL_SURFACE_ID
      || !this.localIdentityListenerReadyResyncPending
      || !this.isInitialized
      || !this.identityListenerReady
    ) {
      return;
    }
    this.localIdentityListenerReadyResyncPending = false;

    const surface = this.captureSurface();
    const syncStartedAt = nowMs();
    try {
      const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      if (!this.isSurfaceUnchanged(surface)) {
        return;
      }
      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        this.state.loading,
        this.state.error,
        currentWorkspace
          ? { type: 'workspace:updated', workspace: currentWorkspace }
          : { type: 'workspace:recent-updated' }
      );
      startupTrace.markPhase('workspace_identity_listener_post_ready_sync_end', {
        durationMs: elapsedMs(syncStartedAt),
      });
    } catch (error) {
      if (isSurfaceChangedError(error) || !this.isSurfaceUnchanged(surface)) {
        log.debug('Abandoned local identity resync after a device surface switch');
        return;
      }
      startupTrace.markPhase('workspace_identity_listener_post_ready_sync_failed', {
        durationMs: elapsedMs(syncStartedAt),
      });
      log.warn('Failed to refresh workspace identity state after listener registration', { error });
    }
  }

  private applyLocalIdentityUpdate(update: WorkspaceIdentityChangedEvent): void {
    const container = this.surfaceContainer(LOCAL_SURFACE_ID);
    const state = container.state;
    const updateWorkspace = (workspace: WorkspaceInfo | null): WorkspaceInfo | null => {
      if (!workspace) {
        return null;
      }

      const matches = workspace.id === update.workspaceId;

      if (!matches) {
        return workspace;
      }

      return {
        ...workspace,
        name: update.name,
        identity: update.identity ?? null,
      };
    };

    const currentWorkspace = updateWorkspace(state.currentWorkspace);
    const openedWorkspaces = new Map(
      Array.from(state.openedWorkspaces.entries()).map(([id, workspace]) => [
        id,
        updateWorkspace(workspace) ?? workspace,
      ])
    );
    const recentWorkspaces = state.recentWorkspaces.map(
      workspace => updateWorkspace(workspace) ?? workspace
    );

    const updatedWorkspace =
      currentWorkspace?.id === update.workspaceId
        ? currentWorkspace
        : openedWorkspaces.get(update.workspaceId) ||
          recentWorkspaces.find(workspace => workspace.id === update.workspaceId) ||
          null;

    if (!updatedWorkspace) {
      if (!container.isInitialized) {
        this.localIdentityListenerReadyResyncPending = true;
      }
      return;
    }

    container.state = {
      ...state,
      currentWorkspace,
      openedWorkspaces,
      recentWorkspaces,
    };
    if (getActiveSurfaceId() === LOCAL_SURFACE_ID) {
      this.emit({ type: 'workspace:updated', workspace: updatedWorkspace });
    }
  }

  /**
   * Subscribe to host catalog hints. Registration failure only disables the
   * push path: the surface keeps the catalog from its own operations.
   */
  private ensureCatalogChangeListener(): void {
    if (this.catalogListenerRegistered) {
      return;
    }
    this.catalogListenerRegistered = true;
    const disable = (error: unknown): void => {
      this.catalogListenerRegistered = false;
      log.error('Failed to subscribe workspace catalog updates', { error });
    };
    try {
      listen<WorkspaceCatalogChangedEvent>(WORKSPACE_CATALOG_CHANGED_EVENT, event => {
        this.handleCatalogChanged(event.payload);
      }).catch(disable);
    } catch (error) {
      disable(error);
    }
  }

  /**
   * Peer hosts mirror this hint to attached controllers, so the raw Tauri bus
   * may carry hints for several devices. Only the rendered surface re-reads.
   */
  private handleCatalogChanged(payload: WorkspaceCatalogChangedEvent): void {
    const route = routeSurfaceEvent(WORKSPACE_CATALOG_CHANGED_EVENT, payload);
    if (!route.deliver) {
      return;
    }
    const container = this.activeSurface;
    if (!container.isInitialized || container.catalogResyncInFlight || container.state.loading) {
      // The bootstrap, the running re-read, or this surface's own workspace
      // operation may have started before this change; whichever finishes
      // first re-reads once more (`updateState` drains the pending flag).
      container.catalogResyncPending = true;
      return;
    }
    void this.resyncWorkspaceCatalog(container);
  }

  private drainPendingCatalogResync(): void {
    const container = this.activeSurface;
    if (
      container.catalogResyncPending
      && container.isInitialized
      && !container.catalogResyncInFlight
      && !container.state.loading
    ) {
      void this.resyncWorkspaceCatalog(container);
    }
  }

  private async resyncWorkspaceCatalog(container: WorkspaceSurfaceContainer): Promise<void> {
    const surface = this.captureSurface();
    if (this.surfaceContainer(surface.scope.surfaceId) !== container) {
      return;
    }
    container.catalogResyncInFlight = true;
    try {
      do {
        container.catalogResyncPending = false;
        const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
          globalStateAPI.getCurrentWorkspace(),
          globalStateAPI.getRecentWorkspaces(),
          globalStateAPI.getOpenedWorkspaces(),
        ]);
        if (!this.isSurfaceUnchanged(surface)) {
          return;
        }
        this.applyHostCatalog(currentWorkspace, recentWorkspaces, openedWorkspaces);
      } while (container.catalogResyncPending && this.isSurfaceUnchanged(surface));
    } catch (error) {
      if (isSurfaceChangedError(error) || !this.isSurfaceUnchanged(surface)) {
        log.debug('Abandoned workspace catalog resync after a device surface switch');
        return;
      }
      log.warn('Failed to refresh workspace catalog after host change', { error });
    } finally {
      container.catalogResyncInFlight = false;
    }
  }

  /**
   * Merge a host catalog snapshot into the rendered surface.
   *
   * The host owns membership (which workspaces are opened and recent). This
   * surface owns its selection: a workspace another controller opened joins
   * the list but does not steal the active slot, unless this surface had no
   * usable selection.
   */
  private applyHostCatalog(
    hostCurrentWorkspace: WorkspaceInfo | null,
    recentWorkspaces: WorkspaceInfo[],
    openedWorkspaces: WorkspaceInfo[],
  ): void {
    const previousOpened = this.state.openedWorkspaces;
    const orderedOpened = this.preserveOpenedWorkspaceOrder(openedWorkspaces);
    const nextOpened = this.buildOpenedWorkspaceMap(orderedOpened);

    const previousActiveId = this.state.activeWorkspaceId;
    const keptActive = previousActiveId ? nextOpened.get(previousActiveId) ?? null : null;
    const currentWorkspace = keptActive
      ?? (hostCurrentWorkspace ? nextOpened.get(hostCurrentWorkspace.id) ?? null : null);
    const activeChanged = (currentWorkspace?.id ?? null) !== previousActiveId;

    const openedNow = orderedOpened.filter(workspace => !previousOpened.has(workspace.id));
    const closedNow = Array.from(previousOpened.keys()).filter(id => !nextOpened.has(id));

    this.updateState({
      currentWorkspace,
      openedWorkspaces: nextOpened,
      activeWorkspaceId: currentWorkspace?.id ?? null,
      lastUsedWorkspaceId: this.resolveLastUsedWorkspaceId(
        currentWorkspace,
        recentWorkspaces,
        nextOpened,
      ),
      recentWorkspaces,
    });

    if (openedNow.length > 0 || closedNow.length > 0 || activeChanged) {
      log.info('Applied host workspace catalog change', {
        openedCount: openedNow.length,
        closedCount: closedNow.length,
        activeWorkspaceId: currentWorkspace?.id ?? null,
      });
    }
    for (const workspace of openedNow) {
      this.emit({ type: 'workspace:opened', workspace });
    }
    for (const workspaceId of closedNow) {
      this.emit({ type: 'workspace:closed', workspaceId });
    }
    if (activeChanged) {
      this.emit({ type: 'workspace:active-changed', workspace: currentWorkspace });
    } else if (openedNow.length === 0 && closedNow.length === 0) {
      this.emit(
        currentWorkspace
          ? { type: 'workspace:updated', workspace: currentWorkspace }
          : { type: 'workspace:recent-updated' },
      );
    }
  }

  private captureSurface(): SurfaceCapture {
    return { scope: getActiveSurfaceScope(), generation: this.switchGeneration };
  }

  private isSurfaceUnchanged(surface: SurfaceCapture): boolean {
    return surface.generation === this.switchGeneration && surface.scope.isCurrent();
  }

  /**
   * Guard every state write that follows an await. A switch inside that window
   * means the result describes a device this window no longer renders, so it
   * must be abandoned rather than written over the surface that replaced it.
   */
  private assertSurfaceUnchanged(surface: SurfaceCapture, action: string): void {
    if (!this.isSurfaceUnchanged(surface)) {
      throw new SurfaceChangedError(surface.scope.surfaceId, surface.scope.epoch, action);
    }
  }

  /**
   * Load workspace state for the surface this window renders.
   *
   * Callers that arrive while a load for the same surface is in flight join it,
   * so one surface never has two initializations writing the same state. A load
   * whose surface was superseded rejects with `SurfaceChangedError`.
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const inFlight = this.activeInitialization;
    if (inFlight && this.isSurfaceUnchanged(inFlight.surface)) {
      return inFlight.promise;
    }

    const surface = this.captureSurface();
    const run: WorkspaceInitializationRun = {
      surface,
      promise: this.runInitialization(surface),
    };
    this.activeInitialization = run;

    try {
      await run.promise;
    } finally {
      if (this.activeInitialization === run) {
        this.activeInitialization = null;
      }
    }
  }

  private async runInitialization(surface: SurfaceCapture): Promise<void> {
    const initializeStartedAt = nowMs();
    startupTrace.markPhase('workspace_initialize_start');

    try {
      log.info('Initializing workspace state');

      const identityListenerStartedAt = markWorkspaceStartupStepStart('ensure_identity_listener');
      void this.ensureIdentityChangeListener();
      this.ensureCatalogChangeListener();
      markWorkspaceStartupStepEnd('ensure_identity_listener', identityListenerStartedAt, {
        blocking: false,
      });

      const startupStateStartedAt = markWorkspaceStartupStepStart('initialize_workspace_startup_state');
      const {
        cleanupRemovedCount,
        recentWorkspaces,
        openedWorkspaces,
        currentWorkspace,
        primaryAssistantWorkspaceId,
        legacyRemoteWorkspace,
      } = await globalStateAPI.initializeWorkspaceStartupState();
      this.assertSurfaceUnchanged(surface, 'initialize workspace state');
      if (surface.scope.surfaceId === LOCAL_SURFACE_ID && !this.identityListenerReady) {
        this.localIdentityListenerReadyResyncPending = true;
      }
      this.startupLegacyRemoteWorkspace = legacyRemoteWorkspace;
      this.startupLegacyRemoteWorkspaceSnapshotAvailable = true;
      this.startupLegacyRemoteWorkspaceSnapshotConsumed = false;
      markWorkspaceStartupStepEnd('initialize_workspace_startup_state', startupStateStartedAt, {
        removedCount: cleanupRemovedCount,
        includesGlobalStateInitialization: true,
        includesWorkspaceStateSnapshot: true,
        includesLegacyRemoteWorkspace: true,
      });

      const fetchStateStartedAt = markWorkspaceStartupStepStart('fetch_workspace_state');
      markWorkspaceStartupStepEnd('fetch_workspace_state', fetchStateStartedAt, {
        source: 'startup_cleanup_snapshot',
        recentCount: recentWorkspaces.length,
        openedCount: openedWorkspaces.length,
        hasCurrentWorkspace: currentWorkspace !== null,
        currentWorkspaceKind: currentWorkspace?.workspaceKind ?? null,
        currentWorkspaceRemote: currentWorkspace ? isRemoteWorkspace(currentWorkspace) : false,
      });

      const updateStateStartedAt = markWorkspaceStartupStepStart('update_workspace_state');
      this.updateState({ primaryAssistantWorkspaceId });
      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        currentWorkspace
          ? { type: 'workspace:opened', workspace: currentWorkspace }
          : undefined
      );
      markWorkspaceStartupStepEnd('update_workspace_state', updateStateStartedAt, {
        recentCount: recentWorkspaces.length,
        openedCount: openedWorkspaces.length,
        hasCurrentWorkspace: currentWorkspace !== null,
      });

      this.emit({ type: 'workspace:loading', loading: false });
      this.isInitialized = true;
      if (
        surface.scope.surfaceId === LOCAL_SURFACE_ID
        && this.localIdentityListenerReadyResyncPending
      ) {
        void this.syncWorkspaceStateAfterIdentityListenerReady();
      }
      // A host catalog hint that arrived while the bootstrap snapshot was in
      // flight may postdate that snapshot; re-read once now.
      this.drainPendingCatalogResync();
      startupTrace.markPhase('workspace_initialize_end', {
        durationMs: elapsedMs(initializeStartedAt),
        recentCount: recentWorkspaces.length,
        openedCount: openedWorkspaces.length,
        hasCurrentWorkspace: currentWorkspace !== null,
      });
      log.info('Workspace state initialization completed', {
        activeWorkspaceId: currentWorkspace?.id ?? null,
        openedWorkspaceCount: openedWorkspaces.length,
      });
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        // Reporting this failure would blank the surface that superseded it,
        // and the load it failed at belongs to a device nobody renders now.
        log.debug('Abandoned workspace initialization for a superseded surface', {
          surfaceId: surface.scope.surfaceId,
          epoch: surface.scope.epoch,
        });
        throw isSurfaceChangedError(error)
          ? error
          : new SurfaceChangedError(
              surface.scope.surfaceId,
              surface.scope.epoch,
              'initialize workspace state',
            );
      }
      startupTrace.markPhase('workspace_initialize_failed', {
        durationMs: elapsedMs(initializeStartedAt),
      });
      log.error('Failed to initialize workspace state', { error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Keep this surface's last known workspace projection. A weak-link
      // refresh failure is visible through `error`, but it must not turn a
      // usable cached device into an empty workspace list.
      this.updateState({ loading: false, error: errorMessage });
      this.emit({ type: 'workspace:error', error: errorMessage });
    }
  }

  /**
   * Announce that the rendered surface is about to change.
   *
   * Frontend-only, and must stay that way: it runs before the transport swap,
   * so any backend call here would land on the device being left. Bumping the
   * switch generation is what supersedes an initialization still in flight —
   * that load abandons at its next checkpoint instead of racing this one. The
   * current container is deliberately preserved; atomic activation selects the
   * target container before the peer-mode event can trigger session creation.
   */
  public clearForPeerModeSwitch(): void {
    this.switchGeneration += 1;
    this.activeInitialization = null;
  }

  /**
   * Tear down local workspace product state and reload opened/recent
   * workspaces from the current transport target (local or peer).
   *
   * Rejects with `SurfaceChangedError` when a later switch supersedes this one:
   * the caller must abandon quietly rather than report a product error or roll
   * the surface back, because what is on screen now belongs to that later
   * switch.
   */
  public async reinitializeForPeerModeSwitch(): Promise<void> {
    log.info('Reinitializing workspace state for peer mode switch');
    // Reconcile the selected surface even when it has a cached snapshot. A
    // second call on the same surface also supersedes the first one.
    this.switchGeneration += 1;
    this.activeInitialization = null;
    this.isInitialized = false;
    const surface = this.captureSurface();
    this.updateState({ loading: true, error: null });
    this.emit({ type: 'workspace:loading', loading: true });
    await this.initialize();
    this.assertSurfaceUnchanged(surface, 'reinitialize workspace for surface switch');
    if (!this.isInitialized) {
      throw new Error(
        this.state.error || 'Workspace state could not be loaded from the Peer host',
      );
    }
  }

  /** Permanently release one detached peer's cached workspace projection. */
  public discardDeviceSurface(surfaceId: DeviceSurfaceId): void {
    this.surfaceContainers.delete(surfaceId);
  }

  public async openWorkspace(path: string): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      log.info('Opening workspace', { path });

      const workspace = await globalStateAPI.openWorkspace(path);
      const [recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'open workspace');

      this.updateWorkspaceState(
        workspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:opened', workspace }
      );

      return workspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to open workspace', { path, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async openRemoteWorkspace(remoteWorkspace: {
    connectionId: string;
    connectionName: string;
    remotePath: string;
    sshHost?: string;
  }): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      log.info('Opening remote workspace', remoteWorkspace);

      const remotePath = normalizeRemoteWorkspacePath(remoteWorkspace.remotePath);

      const workspace = await globalStateAPI.openRemoteWorkspace(
        remotePath,
        remoteWorkspace.connectionId,
        remoteWorkspace.connectionName,
        remoteWorkspace.sshHost,
      );

      const [recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'open remote workspace');

      this.updateWorkspaceState(
        workspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:opened', workspace }
      );

      return workspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to open remote workspace', { remoteWorkspace, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  /**
   * Close and forget one remote workspace record by its workspace ID.
   * Connection IDs and remote paths are not identity: two records may share a
   * connection, so callers must name the record they mean.
   */
  public async removeRemoteWorkspace(workspaceId: string): Promise<void> {
    const surface = this.captureSurface();
    try {
      const workspace = this.state.openedWorkspaces.get(workspaceId);
      if (!workspace) {
        return;
      }
      if (workspace.workspaceKind !== WorkspaceKind.Remote) {
        throw new Error(`Workspace ${workspaceId} is not a remote workspace`);
      }

      await this.cancelRunningSessionsForWorkspace(workspace);
      await globalStateAPI.closeWorkspace(workspace.id);
      await globalStateAPI.removeWorkspaceFromRecent(workspace.id).catch(error => {
        if (isSurfaceChangedError(error)) {
          throw error;
        }
        log.warn('Failed to remove remote workspace from recent list', {
          workspaceId: workspace.id,
          error,
        });
      });

      const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'remove remote workspace');

      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:closed', workspaceId: workspace.id }
      );

      this.emit({ type: 'workspace:active-changed', workspace: currentWorkspace });
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to remove remote workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async createAssistantWorkspace(): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      const workspace = await globalStateAPI.createAssistantWorkspace();
      this.assertSurfaceUnchanged(surface, 'create assistant workspace');
      if (!this.state.primaryAssistantWorkspaceId) {
        this.updateState({ primaryAssistantWorkspaceId: workspace.id });
      }
      const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'create assistant workspace');

      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:opened', workspace }
      );

      return workspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to create assistant workspace', { error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async closeWorkspace(): Promise<void> {
    if (!this.state.currentWorkspace?.id) {
      return;
    }

    await this.closeWorkspaceById(this.state.currentWorkspace.id);
  }

  public async closeWorkspaceById(workspaceId: string): Promise<void> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      log.info('Closing workspace', { workspaceId });

      const closingWorkspace = this.state.openedWorkspaces.get(workspaceId);
      if (closingWorkspace) {
        await this.cancelRunningSessionsForWorkspace(closingWorkspace);
      }

      await globalStateAPI.closeWorkspace(workspaceId);

      const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'close workspace');

      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:closed', workspaceId }
      );

      this.emit({ type: 'workspace:active-changed', workspace: currentWorkspace });
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to close workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  private async cancelRunningSessionsForWorkspace(workspace: WorkspaceInfo): Promise<void> {
    try {
      const { flowChatStore } = await import('@/flow_chat/store/FlowChatStore');
      const cancelledSessionIds = await flowChatStore.cancelRunningSessionsForWorkspace(workspace);
      if (cancelledSessionIds.length > 0) {
        log.info('Cancelled running sessions before closing workspace', {
          workspaceId: workspace.id,
          count: cancelledSessionIds.length,
        });
      }
    } catch (error) {
      log.warn('Failed to cancel running sessions before closing workspace', {
        workspaceId: workspace.id,
        error,
      });
    }
  }

  public async deleteAssistantWorkspace(workspaceId: string): Promise<void> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      log.info('Deleting assistant workspace', { workspaceId });

      const removedWorkspace = this.state.openedWorkspaces.get(workspaceId);
      await globalStateAPI.deleteAssistantWorkspace(workspaceId);

      if (removedWorkspace) {
        const { flowChatStore } = await import('@/flow_chat/store/FlowChatStore');
        flowChatStore.removeSessionsForWorkspace(removedWorkspace);
      }

      const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'delete assistant workspace');

      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:removed', workspaceId }
      );

      this.emit({ type: 'workspace:active-changed', workspace: currentWorkspace });
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to delete assistant workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async setPrimaryAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      log.info('Setting primary assistant workspace', { workspaceId });
      const workspace = await globalStateAPI.setPrimaryAssistantWorkspace(workspaceId);
      this.assertSurfaceUnchanged(surface, 'set primary assistant workspace');
      this.updateState(
        {
          primaryAssistantWorkspaceId: workspace.id,
          loading: false,
          error: null,
        },
        { type: 'workspace:primary-assistant-changed', workspace }
      );
      return workspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to set primary assistant workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState(
        { loading: false, error: errorMessage },
        { type: 'workspace:error', error: errorMessage }
      );
      throw error;
    }
  }

  public async resetAssistantWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setLoading(true);
      this.setError(null);

      log.info('Resetting assistant workspace', { workspaceId });

      const workspace = await globalStateAPI.resetAssistantWorkspace(workspaceId);

      const [currentWorkspace, recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'reset assistant workspace');

      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null,
        { type: 'workspace:updated', workspace }
      );

      this.emit({ type: 'workspace:active-changed', workspace: currentWorkspace });
      return workspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to reset assistant workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async setActiveWorkspace(workspaceId: string): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      if (this.state.activeWorkspaceId === workspaceId) {
        const currentWorkspace = this.state.currentWorkspace;
        if (!currentWorkspace) {
          throw new Error(`Active workspace not found: ${workspaceId}`);
        }
        return currentWorkspace;
      }

      this.setLoading(true);
      this.setError(null);

      const workspace = await globalStateAPI.setActiveWorkspace(workspaceId);
      const [recentWorkspaces, openedWorkspaces] = await Promise.all([
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
      ]);
      this.assertSurfaceUnchanged(surface, 'set active workspace');
      const orderedOpenedWorkspaces = this.preserveOpenedWorkspaceOrder(openedWorkspaces);

      this.updateWorkspaceState(
        workspace,
        recentWorkspaces,
        orderedOpenedWorkspaces,
        false,
        null,
        { type: 'workspace:switched', workspace }
      );

      this.emit({ type: 'workspace:active-changed', workspace });
      return workspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to set active workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ loading: false, error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async reorderOpenedWorkspacesInSection(
    section: WorkspaceSection,
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    position: WorkspaceReorderPosition
  ): Promise<void> {
    const surface = this.captureSurface();
    const previousCurrentWorkspace = this.state.currentWorkspace;
    const previousRecentWorkspaces = this.state.recentWorkspaces;
    const previousOpenedWorkspaces = this.getOpenedWorkspacesList();
    const reorderedOpenedWorkspaceIds = this.buildReorderedOpenedWorkspaceIds(
      section,
      sourceWorkspaceId,
      targetWorkspaceId,
      position
    );

    if (!reorderedOpenedWorkspaceIds) {
      return;
    }

    const currentOpenedWorkspaceIds = previousOpenedWorkspaces.map(workspace => workspace.id);
    const hasOrderChanged = reorderedOpenedWorkspaceIds.some(
      (workspaceId, index) => workspaceId !== currentOpenedWorkspaceIds[index]
    );

    if (!hasOrderChanged) {
      return;
    }

    const workspaceMap = this.buildOpenedWorkspaceMap(previousOpenedWorkspaces);
    const reorderedOpenedWorkspaces = reorderedOpenedWorkspaceIds
      .map(workspaceId => workspaceMap.get(workspaceId))
      .filter((workspace): workspace is WorkspaceInfo => Boolean(workspace));
    const reorderedEventWorkspace = previousCurrentWorkspace
      ?? workspaceMap.get(sourceWorkspaceId)
      ?? reorderedOpenedWorkspaces[0]
      ?? previousOpenedWorkspaces[0];

    if (!reorderedEventWorkspace) {
      return;
    }

    this.updateWorkspaceState(
      previousCurrentWorkspace,
      previousRecentWorkspaces,
      reorderedOpenedWorkspaces,
      false,
      null,
      { type: 'workspace:updated', workspace: reorderedEventWorkspace }
    );

    try {
      await globalStateAPI.reorderOpenedWorkspaces(reorderedOpenedWorkspaceIds);
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      const rollbackEventWorkspace = previousCurrentWorkspace
        ?? workspaceMap.get(sourceWorkspaceId)
        ?? previousOpenedWorkspaces[0]
        ?? reorderedEventWorkspace;
      this.updateWorkspaceState(
        previousCurrentWorkspace,
        previousRecentWorkspaces,
        previousOpenedWorkspaces,
        false,
        errorMessage,
        { type: 'workspace:updated', workspace: rollbackEventWorkspace }
      );
      this.emit({ type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async switchWorkspace(workspace: WorkspaceInfo): Promise<WorkspaceInfo> {
    if (this.state.currentWorkspace?.id === workspace.id) {
      return workspace;
    }

    if (this.state.openedWorkspaces.has(workspace.id)) {
      return this.setActiveWorkspace(workspace.id);
    }

    const surface = this.captureSurface();
    const selected = await globalStateAPI.openWorkspaceById(workspace.id);
    const [recent, opened] = await Promise.all([
      globalStateAPI.getRecentWorkspaces(), globalStateAPI.getOpenedWorkspaces(),
    ]);
    this.assertSurfaceUnchanged(surface, 'reopen workspace');
    this.updateWorkspaceState(selected, recent, opened, false, null,
      { type: 'workspace:opened', workspace: selected });
    return selected;
  }

  public async scanWorkspaceInfo(): Promise<WorkspaceInfo | null> {
    const surface = this.captureSurface();
    try {
      if (!this.state.currentWorkspace?.id) {
        throw new Error('No current workspace available for scanning');
      }

      this.setLoading(true);
      this.setError(null);

      const updatedWorkspace = await globalStateAPI.scanWorkspaceInfo(this.state.currentWorkspace.id);
      this.assertSurfaceUnchanged(surface, 'scan workspace info');

      if (updatedWorkspace) {
        const openedWorkspaces = new Map(this.state.openedWorkspaces);
        openedWorkspaces.set(updatedWorkspace.id, updatedWorkspace);

        const recentWorkspaces = this.state.recentWorkspaces.map(workspace =>
          workspace.id === updatedWorkspace.id ? updatedWorkspace : workspace
        );

        this.updateState(
          {
            currentWorkspace: updatedWorkspace,
            openedWorkspaces,
            recentWorkspaces,
            activeWorkspaceId: updatedWorkspace.id,
            loading: false,
            error: null,
          },
          { type: 'workspace:updated', workspace: updatedWorkspace }
        );
      } else {
        this.setLoading(false);
      }

      return updatedWorkspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to scan workspace info', { error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setError(errorMessage);
      this.setLoading(false);
      throw error;
    }
  }

  public async refreshRecentWorkspaces(): Promise<void> {
    const surface = this.captureSurface();
    try {
      const recentWorkspaces = await globalStateAPI.getRecentWorkspaces();
      if (!this.isSurfaceUnchanged(surface)) {
        return;
      }
      this.updateState({ recentWorkspaces }, { type: 'workspace:recent-updated' });
      log.debug('Recent workspaces refreshed', { count: recentWorkspaces.length });
    } catch (error) {
      log.error('Failed to refresh recent workspaces', { error });
    }
  }

  public async removeWorkspaceFromRecent(workspaceId: string): Promise<void> {
    await globalStateAPI.removeWorkspaceFromRecent(workspaceId);
    await this.refreshRecentWorkspaces();
  }

  public async updateWorkspaceRelatedPaths(
    workspaceId: string,
    relatedPaths: WorkspaceInfo['relatedPaths']
  ): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setError(null);

      const updatedWorkspace = await globalStateAPI.updateWorkspaceInfo(workspaceId, {
        relatedPaths,
      });
      this.assertSurfaceUnchanged(surface, 'update workspace related paths');

      this.applyWorkspaceRecordUpdate(updatedWorkspace);
      return updatedWorkspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to update workspace related paths', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceInfo> {
    const surface = this.captureSurface();
    try {
      this.setError(null);

      const updatedWorkspace = await globalStateAPI.updateWorkspaceInfo(workspaceId, {
        name: name.trim(),
      });
      this.assertSurfaceUnchanged(surface, 'rename workspace');

      this.applyWorkspaceRecordUpdate(updatedWorkspace);
      return updatedWorkspace;
    } catch (error) {
      if (!this.isSurfaceUnchanged(surface)) {
        throw error;
      }
      log.error('Failed to rename workspace', { workspaceId, error });
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateState({ error: errorMessage }, { type: 'workspace:error', error: errorMessage });
      throw error;
    }
  }

  public async cleanupInvalidWorkspaces(): Promise<number> {
    const surface = this.captureSurface();
    try {
      const removedCount = await globalStateAPI.cleanupInvalidWorkspaces();

      if (removedCount === 0) {
        return 0;
      }

      const [currentWorkspace, recentWorkspaces, openedWorkspaces, primaryAssistantWorkspace] = await Promise.all([
        globalStateAPI.getCurrentWorkspace(),
        globalStateAPI.getRecentWorkspaces(),
        globalStateAPI.getOpenedWorkspaces(),
        globalStateAPI.getPrimaryAssistantWorkspace(),
      ]);
      this.assertSurfaceUnchanged(surface, 'cleanup invalid workspaces');

      this.updateState({ primaryAssistantWorkspaceId: primaryAssistantWorkspace?.id ?? null });
      this.updateWorkspaceState(
        currentWorkspace,
        recentWorkspaces,
        openedWorkspaces,
        false,
        null
      );
      this.emit({ type: 'workspace:active-changed', workspace: currentWorkspace });

      log.info('Invalid workspaces cleaned up', { removedCount });
      return removedCount;
    } catch (error) {
      if (this.isSurfaceUnchanged(surface)) {
        log.error('Failed to cleanup invalid workspaces', { error });
      }
      throw error;
    }
  }

  public hasWorkspace(): boolean {
    return !!this.state.currentWorkspace;
  }

  public getWorkspaceName(): string {
    return this.state.currentWorkspace?.name || '';
  }

  public getWorkspacePath(): string {
    return this.state.currentWorkspace?.rootPath || '';
  }
}

export const workspaceManager = WorkspaceManager.getInstance();

export { WorkspaceManager };
