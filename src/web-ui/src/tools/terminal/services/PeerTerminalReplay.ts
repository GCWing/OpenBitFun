import { api } from '@/infrastructure/api/service-api/ApiClient';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('PeerTerminalReplay');

const MAX_RETRY_DELAY_MS = 15_000;
const TERMINAL_UNAVAILABLE = 'Terminal is unavailable';
/** ESC c: output before this point left the host's bounded replay log. */
const TERMINAL_RESET = '\x1bc';

/** The backend event shape `TerminalService.handleTerminalEvent` already accepts. */
export interface PeerTerminalRawEvent {
  type: 'Data' | 'Exit' | 'SessionDestroyed' | 'Error';
  payload: Record<string, unknown>;
}

interface TerminalReplayPage {
  data: string;
  nextOffset: number;
  cursor: number;
  truncated: boolean;
}

/**
 * Live output of one PTY on a CLI peer host.
 *
 * A CLI host publishes coalesced cursor hints on the `terminal-<id>` host stream
 * instead of fanning out raw output, so a slow controller costs the host nothing
 * and cannot lose bytes silently. This reads the bounded replay pages those
 * hints announce. Reconnects and missed hints heal themselves, because every
 * read continues from the offset this client last applied.
 */
export class PeerTerminalReplay {
  private readonly scope = getActiveSurfaceScope();
  private readonly streamId: string;
  private readonly listeners: Array<() => void> = [];
  private subscriptionId: string | null = null;
  private closed = false;
  private caughtUp = false;
  private draining = false;
  private dirty = false;
  private pendingLifecycle: PeerTerminalRawEvent | null = null;
  private retryDelay = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
    private offset: number,
    private readonly deliver: (event: PeerTerminalRawEvent) => void,
  ) {
    this.streamId = `terminal-${sessionId}`;
  }

  start(): void {
    // Listen before subscribing: the first page is emitted while subscribing.
    this.listeners.push(
      api.listen<{ terminal_id?: string }>('terminal-output', event => {
        if (event?.terminal_id === this.sessionId && this.caughtUp) this.requestRead();
      }),
      api.listen<{ terminal_id?: string; exit_code?: number | null }>('terminal-exit', event => {
        if (event?.terminal_id !== this.sessionId) return;
        this.finishAfterDrain({
          type: 'Exit',
          payload: { session_id: this.sessionId, exit_code: event.exit_code ?? undefined },
        });
      }),
      api.listen<{ terminal_id?: string }>('terminal-closed', event => {
        if (event?.terminal_id !== this.sessionId) return;
        this.finishAfterDrain({ type: 'SessionDestroyed', payload: { session_id: this.sessionId } });
      }),
      remoteConnectAPI.onSessionReady(ready => {
        if (ready.sessionId !== this.streamId) return;
        this.caughtUp = true;
        this.requestRead();
      }),
      remoteConnectAPI.onSessionSyncError(error => {
        if (error.sessionId !== this.streamId || error.targetDeviceId !== this.scope.surfaceId) return;
        if (this.caughtUp) log.warn('Terminal stream sync error', { sessionId: this.sessionId, message: error.message });
        else this.fail(error.message);
      }),
    );
    void remoteConnectAPI.subscribeSession(this.scope.surfaceId, this.streamId).then(
      id => {
        if (this.closed) void this.release(id);
        else this.subscriptionId = id;
      },
      error => this.fail(error instanceof Error ? error.message : String(error)),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.splice(0).forEach(unlisten => unlisten());
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.subscriptionId) void this.release(this.subscriptionId);
    this.subscriptionId = null;
  }

  private release(subscriptionId: string): Promise<void> {
    return remoteConnectAPI.unsubscribeSession(subscriptionId).catch(error => {
      log.warn('Failed to release terminal stream', { sessionId: this.sessionId, error });
    });
  }

  private isActive(): boolean {
    return !this.closed && this.scope.isCurrent();
  }

  private fail(message: string): void {
    if (!this.isActive()) return;
    log.error('Terminal stream unavailable', { sessionId: this.sessionId, message });
    this.deliver({ type: 'Error', payload: { session_id: this.sessionId, message } });
  }

  /** The exit must not overtake output that is already in the replay log. */
  private finishAfterDrain(event: PeerTerminalRawEvent): void {
    // A close supersedes an exit that is still waiting for its output.
    this.pendingLifecycle = event;
    if (this.caughtUp) this.requestRead();
  }

  private requestRead(): void {
    this.dirty = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.isActive()) return;
    this.draining = true;
    try {
      while (this.dirty && this.isActive()) {
        this.dirty = false;
        const page = await api.invoke<TerminalReplayPage>('terminal_get_history', {
          sessionId: this.sessionId,
          afterOffset: this.offset,
        });
        if (!this.isActive()) return;
        const data = page.truncated ? `${TERMINAL_RESET}${page.data}` : page.data;
        if (data) this.deliver({ type: 'Data', payload: { session_id: this.sessionId, data } });
        const advanced = page.nextOffset > this.offset;
        this.offset = page.nextOffset;
        if (advanced && page.nextOffset < page.cursor) this.dirty = true;
      }
      this.retryDelay = 0;
      const lifecycle = this.pendingLifecycle;
      if (lifecycle && this.isActive()) {
        this.pendingLifecycle = null;
        this.deliver(lifecycle);
      }
    } catch (error) {
      if (!this.isActive()) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(TERMINAL_UNAVAILABLE)) {
        // The session is gone, and a host without lifecycle events cannot say so.
        this.deliver({ type: 'SessionDestroyed', payload: { session_id: this.sessionId } });
        return;
      }
      log.warn('Failed to read terminal output', { sessionId: this.sessionId, message });
      this.scheduleRetry();
    } finally {
      this.draining = false;
    }
  }

  private scheduleRetry(): void {
    this.dirty = true;
    this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 1_000, MAX_RETRY_DELAY_MS);
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drain();
    }, this.retryDelay);
  }
}
