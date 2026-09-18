import { RemoteSessionManager } from './RemoteSessionManager';
import { HOST_CATALOG_ID, HostSessionEvent, HostSessionStream } from './HostSessionStream';

/** One host invalidation stream; directory contents remain owned by the runtime. */
export class HostCatalogObserver {
  private stream?: HostSessionStream;
  private target: string = '';
  private generation: number = 0;
  private dirty: boolean = false;
  private running: boolean = false;
  private manager: RemoteSessionManager;
  private refresh: () => Promise<void>;
  private onError: (error: Error) => void;
  constructor(manager: RemoteSessionManager, refresh: () => Promise<void>, onError: (error: Error) => void) {
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
          if (generation === this.generation && event.event === 'host-catalog-changed') this.dirty = true;
        },
        onResumed: async (): Promise<void> => {
          if (generation === this.generation) this.dirty = true;
        },
        onGap: async (): Promise<void> => {
          if (generation === this.generation) this.dirty = true;
        },
        onCaughtUp: async (): Promise<void> => { await this.flush(generation); },
        onError: (error: Error): void => { if (generation === this.generation) this.onError(error); }
      });
    } catch (error) { this.onError(error as Error); }
  }
  stop(): void {
    this.generation++; this.stream?.close(); this.stream = undefined;
    this.target = ''; this.dirty = false;
  }
  private async flush(generation: number): Promise<void> {
    if (this.running || generation !== this.generation) return;
    this.running = true;
    try {
      while (this.dirty && generation === this.generation) {
        this.dirty = false; await this.refresh();
      }
    } catch (error) {
      if (generation === this.generation) this.onError(error as Error);
    } finally {
      this.running = false;
      if (this.dirty && generation !== this.generation) void this.flush(this.generation);
    }
  }
}
