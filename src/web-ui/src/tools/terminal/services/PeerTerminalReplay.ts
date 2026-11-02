import { api } from '@/infrastructure/api/service-api/ApiClient';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('PeerTerminalReplay');

const MAX_RETRY_DELAY_MS = 15_000;
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
 * One PTY on a host that publishes cursor hints on its `terminal-<id>` stream
 * instead of fanning out raw output, so a slow controller costs the host nothing
 * and cannot lose bytes silently.
 *
 * Attached, it always reports the PTY's lifecycle, which a tab without a mounted
 * view needs. While following, it also reads the bounded replay pages the hints
 * announce. Reconnects and missed hints heal themselves, because every read
 * continues from the offset this client last applied.
 */
export class PeerTerminalReplay {
  private readonly scope = getActiveSurfaceScope();
  private readonly streamId: string;
  private readonly listeners: Array<() => void> = [];
  private subscriptionId: string | null = null;
  private closed = false;
  private caughtUp = false;
  /** `null` while no view is rendering output, so nothing is read. */
  private offset: number | null = null;
  /** Fences a read in flight across a follow change. */
  private followEpoch = 0;
  private draining = false;
  private dirty = false;
  private pendingLifecycle: PeerTerminalRawEvent | null = null;
  private streamFailure: string | null = null;
  private retryDelay = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
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

  isFollowing(): boolean {
    return this.offset !== null;
  }

  /** Render output from `offset` on; everything before it is already on screen. */
  follow(offset: number): void {
    this.offset = offset;
    this.followEpoch += 1;
    if (this.streamFailure) {
      // Nobody could see this while no view was mounted.
      this.deliver({ type: 'Error', payload: { session_id: this.sessionId, message: this.streamFailure } });
      return;
    }
    if (this.caughtUp) this.requestRead();
  }

  /** The last view left: stop reading output and keep reporting the lifecycle. */
  unfollow(): void {
    if (this.offset === null) return;
    this.offset = null;
    this.followEpoch += 1;
    this.dirty = false;
    this.clearRetry();
    this.deliverPendingLifecycle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.splice(0).forEach(unlisten => unlisten());
    this.clearRetry();
    if (this.subscriptionId) void this.release(this.subscriptionId);
    this.subscriptionId = null;
  }

  private release(subscriptionId: string): Promise<void> {
    return remoteConnectAPI.unsubscribeSession(subscriptionId).catch(error => {
      log.warn('Failed to release terminal stream', { sessionId: this.sessionId, error });
    });
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = 0;
  }

  private isActive(): boolean {
    return !this.closed && this.scope.isCurrent();
  }

  private fail(message: string): void {
    if (!this.isActive()) return;
    log.error('Terminal stream unavailable', { sessionId: this.sessionId, message });
    this.streamFailure = message;
    if (this.isFollowing()) {
      this.deliver({ type: 'Error', payload: { session_id: this.sessionId, message } });
    }
  }

  /** The exit must not overtake output that is already in the replay log. */
  private finishAfterDrain(event: PeerTerminalRawEvent): void {
    // A close supersedes an exit that is still waiting for its output.
    this.pendingLifecycle = event;
    if (this.isFollowing() && this.caughtUp) this.requestRead();
    else if (!this.isFollowing()) this.deliverPendingLifecycle();
  }

  private deliverPendingLifecycle(): void {
    const lifecycle = this.pendingLifecycle;
    if (!lifecycle || !this.isActive()) return;
    this.pendingLifecycle = null;
    this.deliver(lifecycle);
  }

  private requestRead(): void {
    if (!this.isFollowing()) {
      this.deliverPendingLifecycle();
      return;
    }
    this.dirty = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.isActive() || this.offset === null) return;
    this.draining = true;
    const epoch = this.followEpoch;
    try {
      while (this.dirty && this.isActive() && this.offset !== null) {
        this.dirty = false;
        const after: number = this.offset;
        const page = await api.invoke<TerminalReplayPage>('terminal_get_history', {
          sessionId: this.sessionId,
          afterOffset: after,
        });
        if (!this.isActive()) return;
        if (epoch !== this.followEpoch) {
          // A follow change owns the offset now; its own read will start next.
          this.dirty = this.isFollowing();
          break;
        }
        const data = page.truncated ? `${TERMINAL_RESET}${page.data}` : page.data;
        if (data) this.deliver({ type: 'Data', payload: { session_id: this.sessionId, data } });
        this.offset = page.nextOffset;
        if (page.nextOffset > after && page.nextOffset < page.cursor) this.dirty = true;
      }
      if (!this.dirty) {
        this.retryDelay = 0;
        this.deliverPendingLifecycle();
      }
    } catch (error) {
      await this.recoverFromReadFailure(error);
    } finally {
      this.draining = false;
      if (this.dirty && epoch !== this.followEpoch) void this.drain();
    }
  }

  /** The session list is the authority on whether a failed read means it is gone. */
  private async recoverFromReadFailure(error: unknown): Promise<void> {
    if (!this.isActive()) return;
    log.warn('Failed to read terminal output', { sessionId: this.sessionId, error });
    const sessions = await api.invoke<Array<{ id: string }>>('terminal_list').catch(() => null);
    if (!this.isActive()) return;
    if (sessions && !sessions.some(session => session.id === this.sessionId)) {
      this.deliver({ type: 'SessionDestroyed', payload: { session_id: this.sessionId } });
      return;
    }
    if (this.isFollowing()) this.scheduleRetry();
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
