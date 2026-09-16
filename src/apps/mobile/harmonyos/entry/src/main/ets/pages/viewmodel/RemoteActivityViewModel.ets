import { SessionSummary } from '../../model/RemoteModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ConnectionErrorPolicy } from '../../services/ConnectionErrorPolicy';
import { AsyncLifecycleGate } from '../../services/AsyncLifecycleGate';
import { RemoteActivityLifecycleController } from '../../services/RemoteActivityLifecycleController';
import { RemoteConnectionCoordinator } from '../../services/RemoteConnectionCoordinator';
import { RemoteLogger } from '../../services/RemoteLogger';

export interface RemoteActivityViewModelHooks {
  readonly isConnected: () => boolean;
  readonly isReconnecting: () => boolean;
  readonly isBusy: () => boolean;
  readonly hasRemoteBinding: () => boolean;
  readonly isRemoteChat: () => boolean;
  readonly activeSession: () => SessionSummary;
  readonly onConnectionState: (state: string) => void;
  readonly onStatus: (status: string) => void;
  readonly onConnectionError: (err: Object) => Promise<boolean>;
  readonly onObserveCatalog?: () => void;
  readonly onStopCatalog?: () => void;
  readonly onStartPolling: () => void;
  readonly onStopPolling: () => void;
  readonly onPoll: () => Promise<void>;
  readonly onReconnect: () => Promise<void>;
  readonly onRestoreSession: (session: SessionSummary) => Promise<void>;
}

/** Owns foreground recovery, host catalog observation, and idempotent resume cancellation. */
export class RemoteActivityViewModel {
  private readonly activity: RemoteActivityLifecycleController;
  private readonly connection: RemoteConnectionCoordinator;
  private readonly gate: AsyncLifecycleGate;
  private readonly hooks: RemoteActivityViewModelHooks;
  private recoveryToken: number = 0;

  constructor(
    activity: RemoteActivityLifecycleController,
    connection: RemoteConnectionCoordinator,
    gate: AsyncLifecycleGate,
    hooks: RemoteActivityViewModelHooks
  ) {
    this.activity = activity;
    this.connection = connection;
    this.gate = gate;
    this.hooks = hooks;
  }

  startHeartbeat(): void {
    // Relay liveness does not prove that the selected host can answer commands.
    this.activity.startHeartbeat();
    this.hooks.onObserveCatalog?.();
  }

  stopHeartbeat(): void {
    this.activity.stopHeartbeat();
    this.hooks.onStopCatalog?.();
  }

  /** Bounded host probe used by the foreground heartbeat and explicit recovery. */
  async checkConnectionHealth(): Promise<void> {
    if (this.hooks.isBusy() || this.recoveryToken !== 0 || !this.hooks.hasRemoteBinding()) {
      return;
    }
    const wasConnected = this.hooks.isConnected();
    if (!wasConnected && !this.hooks.isReconnecting()) {
      return;
    }
    const token = this.gate.begin();
    this.recoveryToken = token;
    try {
      await this.connection.ping();
      if (!this.gate.isCurrent(token)) return;
      if (!wasConnected) {
        this.hooks.onConnectionState('connected');
        this.hooks.onStatus(RemoteI18n.t('connection.connected'));
        if (this.hooks.isRemoteChat()) this.hooks.onStartPolling();
      }
    } catch (err) {
      if (!this.gate.isCurrent(token)) {
        return;
      }
      if (await this.hooks.onConnectionError(err)) {
        return;
      }
      if (!this.gate.isCurrent(token)) {
        return;
      }
      this.hooks.onStatus(ConnectionErrorPolicy.errorText(err));
      if (wasConnected) {
        RemoteLogger.info('heartbeat ping failed, waiting for the link to come back');
        this.hooks.onStopPolling();
        this.hooks.onConnectionState('reconnecting');
      }
    } finally {
      if (this.recoveryToken === token) this.recoveryToken = 0;
    }
  }

  resume(): void {
    if (!this.hooks.hasRemoteBinding()) {
      return;
    }
    this.startHeartbeat();
    if (this.hooks.isRemoteChat() && this.hooks.activeSession().sessionId.length > 0) {
      this.hooks.onStartPolling();
      void this.hooks.onPoll();
    }
    void this.verifyForeground();
  }

  async verifyForeground(): Promise<void> {
    if (this.hooks.isBusy() || !this.hooks.hasRemoteBinding()) {
      return;
    }
    const token = this.gate.begin();
    try {
      await this.connection.ping();
      if (!this.gate.isCurrent(token)) {
        return;
      }
    } catch (err) {
      if (!this.gate.isCurrent(token)) {
        return;
      }
      if (await this.hooks.onConnectionError(err)) {
        return;
      }
      if (!this.gate.isCurrent(token)) {
        return;
      }
      this.hooks.onStatus(ConnectionErrorPolicy.errorText(err));
      this.hooks.onConnectionState('reconnecting');
      // Only a failed host probe starts recovery; foregrounding a healthy
      // connection must not flash a reconnect warning.
      this.recoveryToken = token;
      try {
        await this.reconnect(token);
      } catch (reconnectErr) {
        if (this.gate.isCurrent(token)) {
          this.hooks.onStatus(ConnectionErrorPolicy.errorText(reconnectErr));
        }
      } finally {
        if (this.recoveryToken === token) {
          this.recoveryToken = 0;
        }
      }
      return;
    }
    this.hooks.onConnectionState('connected');
    this.hooks.onStatus(RemoteI18n.t('connection.connected'));
    if (this.hooks.isRemoteChat() && this.hooks.activeSession().sessionId.length > 0) {
      try {
        await this.hooks.onPoll();
      } catch (err) {
        // A transcript refresh error is not evidence that the host ping failed.
        if (this.gate.isCurrent(token)) {
          this.hooks.onStatus(ConnectionErrorPolicy.errorText(err));
        }
      }
    }
  }

  invalidate(): void {
    this.gate.invalidate();
    this.recoveryToken = 0;
    this.hooks.onStopPolling();
    this.stopHeartbeat();
  }

  /** Keeps only the active-turn poll alive during a transient background window. */
  suspendKeepingActiveTurnPoll(): void {
    this.gate.invalidate();
    this.recoveryToken = 0;
    this.stopHeartbeat();
  }

  private async reconnect(token: number): Promise<void> {
    const shouldRestore = this.hooks.isRemoteChat() && this.hooks.activeSession().sessionId.length > 0;
    const session = this.hooks.activeSession();
    await this.hooks.onReconnect();
    if (!this.gate.isCurrent(token) || !this.hooks.isConnected()) {
      return;
    }
    if (shouldRestore) {
      await this.hooks.onRestoreSession(session);
      if (!this.gate.isCurrent(token)) {
        return;
      }
      this.hooks.onStartPolling();
      await this.hooks.onPoll();
    }
  }
}
