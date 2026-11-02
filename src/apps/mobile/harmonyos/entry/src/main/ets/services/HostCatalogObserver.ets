import { RemoteSessionManager } from './RemoteSessionManager';
import { HOST_CATALOG_ID, HostSessionEvent, HostSessionStream } from './HostSessionStream';

export interface HostCatalogChange {
  sessionsRevision?: number;
  workspacesRevision?: number;
  initial?: boolean;
}

const HOST_CATALOG_NOTICE_MIN_INTERVAL_MS: number = 3000;

/** One host invalidation stream; directory contents remain owned by the runtime. */
export class HostCatalogObserver {
  private stream?: HostSessionStream;
  private target: string = '';
  private generation: number = 0;
  private dirty: boolean = false;
  private runningGeneration?: number;
  private pendingChange: HostCatalogChange = {};
  private lastSessionsRevision?: number;
  private lastWorkspacesRevision?: number;
  private lastRefreshAt: number = 0;
  private manager: RemoteSessionManager;
  private refresh: (change: HostCatalogChange) => Promise<void>;
  private onError: (error: Error) => void;
  constructor(manager: RemoteSessionManager, refresh: (change: HostCatalogChange) => Promise<void>, onError: (error: Error) => void) {
    this.manager = manager; this.refresh = refresh; this.onError = onError;
  }
  start(target: string): void {
    if (!target) { this.stop(); return; }
    if (this.target === target && this.stream && !this.stream.isClosed()) {
      // Successful session reads also ensure observation is active. Treating
      // that as an invalidation makes refresh -> start -> refresh a loop.
      this.stream.wake();
      return;
    }
    this.stop(); this.target = target;
    const generation = this.generation;
    this.dirty = true;
    try {
      this.stream = this.manager.subscribeSession(HOST_CATALOG_ID, {
        onEvent: async (event: HostSessionEvent): Promise<void> => {
          if (generation === this.generation && event.event === 'host-catalog-changed') {
            const payload = (event.payload || {}) as Record<string, Object>;
            const sessionsRevision = Number(payload.sessionsRevision);
            const workspacesRevision = Number(payload.workspacesRevision);
            const hasRevisions = Number.isSafeInteger(sessionsRevision) || Number.isSafeInteger(workspacesRevision);
            let revisionChanged = false;
            if (Number.isSafeInteger(sessionsRevision) && sessionsRevision !== this.lastSessionsRevision) {
              this.pendingChange.sessionsRevision = sessionsRevision;
              this.lastSessionsRevision = sessionsRevision;
              revisionChanged = true;
            }
            if (Number.isSafeInteger(workspacesRevision) && workspacesRevision !== this.lastWorkspacesRevision) {
              this.pendingChange.workspacesRevision = workspacesRevision;
              this.lastWorkspacesRevision = workspacesRevision;
              revisionChanged = true;
            }
            // A revision-bearing event with no revision change is only a
            // duplicate hint. Legacy hosts omit both values and remain
            // conservatively invalidating everything.
            if (!hasRevisions) this.pendingChange.initial = true;
            if (!hasRevisions || revisionChanged) this.dirty = true;
          }
        },
        onResumed: async (): Promise<void> => {
          if (generation === this.generation) { this.pendingChange.initial = true; this.dirty = true; }
        },
        onGap: async (): Promise<void> => {
          if (generation === this.generation) { this.pendingChange.initial = true; this.dirty = true; }
        },
        onCaughtUp: async (): Promise<void> => { await this.flush(generation); },
        onError: (error: Error): void => { if (generation === this.generation) this.onError(error); }
      });
    } catch (error) { this.onError(error as Error); }
  }
  stop(): void {
    this.generation++; this.stream?.close(); this.stream = undefined;
    this.target = ''; this.dirty = false; this.pendingChange = {};
    this.lastSessionsRevision = undefined; this.lastWorkspacesRevision = undefined; this.lastRefreshAt = 0;
  }
  private async flush(generation: number): Promise<void> {
    if (this.runningGeneration === generation || generation !== this.generation) return;
    // A disconnected target may still have an RPC pending. The new stream
    // owns its own refresh and must receive its errors to drive backoff.
    this.runningGeneration = generation;
    try {
      while (this.dirty && generation === this.generation) {
        this.dirty = false;
        const change = this.pendingChange;
        if (this.lastRefreshAt === 0) change.initial = true;
        this.pendingChange = {};
        const waitMs = Math.max(0, HOST_CATALOG_NOTICE_MIN_INTERVAL_MS - (Date.now() - this.lastRefreshAt));
        if (this.lastRefreshAt > 0 && waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
          if (generation !== this.generation) return;
        }
        await this.refresh(change);
        if (generation !== this.generation) return;
        this.lastRefreshAt = Date.now();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.pendingChange.initial = true;
        this.dirty = true;
        this.lastRefreshAt = Date.now();
        // Let the stream's existing backoff retry even if no more hints arrive.
        throw new Error(String(error));
      }
    } finally {
      if (this.runningGeneration === generation) this.runningGeneration = undefined;
    }
  }
}
