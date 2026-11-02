/**
 * Atomic device-surface switching and peer attachment orchestration.
 *
 * React renders a snapshot of this controller; it does not own connection
 * timers or the switch lifecycle. Rapid requests collapse to the last target,
 * and a request that supersedes an already committed activation invalidates
 * that activation immediately so its hydrate cannot write into the next one.
 */

import type { ITransportAdapter } from '@/infrastructure/api/adapters/base';
import { createLogger } from '@/shared/utils/logger';
import {
  LOCAL_SURFACE_ID,
  SurfaceChangedError,
  getActiveSurfaceScope,
  isSurfaceChangedError,
  type DeviceSurfaceId,
  type SurfaceScope,
} from './deviceSurface';
import { shouldSurfacePeerDetachFailure } from './peerDetachPolicy';
import type { PeerConnection, PeerConnectionState } from './PeerConnectionManager';
import type {
  PeerAttachmentState,
  PeerModeState,
  SurfaceSwitchOutcome,
} from './peerDeviceContextState';

const log = createLogger('PeerDeviceSurfaceController');

export interface SurfaceTarget {
  readonly surfaceId: DeviceSurfaceId;
  readonly deviceId: string | null;
  readonly deviceName: string;
}

export interface ResolvedSurfaceTarget extends SurfaceTarget {
  readonly adapter: ITransportAdapter;
}

interface SwitchWaiter {
  resolve: (outcome: SurfaceSwitchOutcome) => void;
  reject: (error: unknown) => void;
}

interface SwitchIntent {
  readonly id: number;
  readonly target: SurfaceTarget;
  readonly reason: string;
  readonly abortController: AbortController;
  readonly waiters: SwitchWaiter[];
  phase: 'queued' | 'preparing' | 'hydrating';
  superseded: boolean;
  settled: boolean;
  rollingBack: boolean;
  fromTarget: SurfaceTarget | null;
}

export interface PeerConnectionManagerPort {
  connect(deviceId: string, deviceName?: string): Promise<PeerConnection>;
  get(deviceId: string): PeerConnection | undefined;
  list(): readonly PeerConnectionState[];
  subscribe(listener: (connections: readonly PeerConnectionState[]) => void): () => void;
  dispose(deviceId: string, options?: { notifyPeer?: boolean }): Promise<void>;
  reportPresence(onlineDeviceIds: Iterable<string>): void;
}

export interface PeerDeviceSurfaceControllerDependencies {
  connectionManager: PeerConnectionManagerPort;
  getLocalAdapter: () => Promise<ITransportAdapter>;
  resetProductSurface: (assertCurrent: () => void) => Promise<void>;
  reloadConfig: (scope: SurfaceScope) => Promise<void>;
  rebootstrapWorkspaces: (scope: SurfaceScope) => Promise<void>;
  setPeerControllerActive: (active: boolean, required: boolean) => Promise<void>;
  commitSurface: (target: ResolvedSurfaceTarget) => SurfaceScope;
  invalidateCurrentSurface: () => SurfaceScope;
  /** Keep non-React polling on the transport target while workspace state hydrates. */
  setPeerDeviceModeActiveFlag: (active: boolean) => void;
  /** Notify React consumers only after the target workspace is ready. */
  emitPeerModeChanged: (detail: { active: boolean; deviceId?: string }) => void;
  markSurfaceSwitched: () => void;
  discardSurfaceState: (surfaceId: DeviceSurfaceId) => void;
  clearDeviceActivity: (deviceId: string) => void;
  listenPresence: (
    listener: (onlineDeviceIds: readonly string[]) => void,
  ) => () => void;
  listenLoginState: (listener: (loggedIn: boolean) => void) => () => void;
}

export interface PeerDeviceSurfaceSnapshot {
  readonly peerMode: PeerModeState;
  readonly attachments: readonly PeerAttachmentState[];
}

export type PeerDeviceSurfaceListener = (snapshot: PeerDeviceSurfaceSnapshot) => void;

function localTarget(): SurfaceTarget {
  return {
    surfaceId: LOCAL_SURFACE_ID,
    deviceId: null,
    deviceName: '',
  };
}

function sameTarget(left: SurfaceTarget, right: SurfaceTarget): boolean {
  return left.surfaceId === right.surfaceId;
}

function peerModeFor(target: SurfaceTarget): PeerModeState {
  return target.deviceId === null
    ? { active: false }
    : {
        active: true,
        deviceId: target.deviceId,
        deviceName: target.deviceName,
      };
}

export class PeerDeviceSurfaceController {
  private readonly dependencies: PeerDeviceSurfaceControllerDependencies;
  private readonly listeners = new Set<PeerDeviceSurfaceListener>();
  private currentTarget: SurfaceTarget = localTarget();
  /** False while the committed target still needs (or has lost) its hydrate. */
  private currentTargetReady = true;
  private connectionStates: readonly PeerConnectionState[];
  private pendingIntent: SwitchIntent | null = null;
  private activeIntent: SwitchIntent | null = null;
  private drainPromise: Promise<void> | null = null;
  private nextIntentId = 0;
  private started = false;
  private managerUnsubscribe: (() => void) | null = null;
  private controlPlaneUnsubscribes: Array<() => void> = [];

  constructor(dependencies: PeerDeviceSurfaceControllerDependencies) {
    this.dependencies = dependencies;
    this.connectionStates = this.dependencies.connectionManager.list();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.managerUnsubscribe = this.dependencies.connectionManager.subscribe(
      connections => this.handleConnectionStates(connections),
    );
    this.controlPlaneUnsubscribes = [
      this.dependencies.listenPresence(onlineDeviceIds => {
        this.dependencies.connectionManager.reportPresence(onlineDeviceIds);
      }),
      this.dependencies.listenLoginState(loggedIn => {
        if (!loggedIn && this.dependencies.connectionManager.list().length > 0) {
          void this.disconnectAllDevices('account_logout');
        }
      }),
    ];
    this.handleConnectionStates(this.dependencies.connectionManager.list());
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.managerUnsubscribe?.();
    this.managerUnsubscribe = null;
    for (const unsubscribe of this.controlPlaneUnsubscribes) {
      unsubscribe();
    }
    this.controlPlaneUnsubscribes = [];
  }

  getSnapshot(): PeerDeviceSurfaceSnapshot {
    return {
      peerMode: peerModeFor(this.currentTarget),
      attachments: this.connectionStates.map(connection => ({
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
        health: connection.health,
        capabilities: connection.capabilities,
      })),
    };
  }

  subscribe(listener: PeerDeviceSurfaceListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  switchToDevice(deviceId: string, deviceName: string): Promise<SurfaceSwitchOutcome> {
    if (!deviceId.trim()) {
      return Promise.reject(new Error('deviceId is required'));
    }
    return this.enqueueSwitch({
      surfaceId: deviceId.trim(),
      deviceId: deviceId.trim(),
      deviceName,
    }, 'manual');
  }

  switchToLocal(reason = 'manual'): Promise<SurfaceSwitchOutcome> {
    return this.enqueueSwitch(localTarget(), reason);
  }

  async disconnectDevice(deviceId: string, reason?: string): Promise<void> {
    const connection = this.dependencies.connectionManager.get(deviceId);
    if (!connection) {
      return;
    }

    if (this.currentTarget.deviceId === deviceId) {
      await this.switchToLocal(reason ?? 'disconnect');
      await this.waitForIdle();
      if (this.currentTarget.deviceId === deviceId) {
        throw new Error('Peer device is still the rendered surface');
      }
    }

    let detachError: unknown;
    try {
      await this.dependencies.connectionManager.dispose(deviceId, {
        notifyPeer: reason !== 'peer_offline' && reason !== 'rpc_failures',
      });
    } catch (error) {
      detachError = error;
    } finally {
      this.releaseDeviceState(connection.surfaceId, deviceId);
    }

    if (detachError) {
      if (shouldSurfacePeerDetachFailure(reason)) {
        throw detachError;
      }
      log.warn('Ignoring detach failure for an unreachable peer', {
        deviceId,
        reason,
        error: detachError,
      });
    }
    log.info('Disconnected peer device', { deviceId, reason: reason ?? 'manual' });
  }

  async disconnectAllDevices(reason?: string): Promise<void> {
    if (this.currentTarget.deviceId !== null) {
      try {
        await this.switchToLocal(reason ?? 'disconnect_all');
        await this.waitForIdle();
      } catch (error) {
        log.warn('Failed to restore the local surface before disconnecting peers', { error });
      }
    }

    for (const connection of [...this.dependencies.connectionManager.list()]) {
      try {
        await this.disconnectDevice(connection.deviceId, reason);
      } catch (error) {
        log.warn('Failed to disconnect peer device', {
          deviceId: connection.deviceId,
          error,
        });
      }
    }
  }

  /** Test and lifecycle hook: resolves once no queued activation remains. */
  async waitForIdle(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  private enqueueSwitch(target: SurfaceTarget, reason: string): Promise<SurfaceSwitchOutcome> {
    return new Promise<SurfaceSwitchOutcome>((resolve, reject) => {
      const waiter: SwitchWaiter = { resolve, reject };
      if (
        this.pendingIntent
        && !this.pendingIntent.superseded
        && sameTarget(this.pendingIntent.target, target)
      ) {
        this.pendingIntent.waiters.push(waiter);
        return;
      }
      if (
        this.activeIntent
        && !this.activeIntent.superseded
        && !this.activeIntent.rollingBack
        && sameTarget(this.activeIntent.target, target)
      ) {
        this.activeIntent.waiters.push(waiter);
        return;
      }

      if (this.pendingIntent) {
        this.supersedeIntent(this.pendingIntent);
      }
      const intent: SwitchIntent = {
        id: ++this.nextIntentId,
        target,
        reason,
        abortController: new AbortController(),
        waiters: [waiter],
        phase: 'queued',
        superseded: false,
        settled: false,
        rollingBack: false,
        fromTarget: null,
      };
      this.pendingIntent = intent;

      if (this.activeIntent && !sameTarget(this.activeIntent.target, target)) {
        const active = this.activeIntent;
        this.supersedeIntent(active);
        if (active.phase === 'hydrating') {
          // The target transport is already rendered. Invalidate its activation
          // now so workspace/session hydrates unwind before the next commit.
          this.currentTargetReady = false;
          try {
            this.dependencies.invalidateCurrentSurface();
          } catch (error) {
            log.warn('Failed to invalidate a superseded device surface', { error });
          }
        }
      }

      this.ensureDrain();
    });
  }

  private ensureDrain(): void {
    if (this.drainPromise) {
      return;
    }
    this.drainPromise = this.drainSwitches().finally(() => {
      this.drainPromise = null;
      if (this.pendingIntent) {
        this.ensureDrain();
      }
    });
  }

  private async drainSwitches(): Promise<void> {
    while (this.pendingIntent) {
      const intent = this.pendingIntent;
      this.pendingIntent = null;
      this.activeIntent = intent;
      intent.fromTarget = this.currentTarget;

      try {
        await this.transitionTo(intent, intent.target, intent.reason);
        if (intent.superseded) {
          this.settleIntent(intent, 'superseded');
        } else {
          this.settleIntent(intent, 'activated');
        }
      } catch (error) {
        if (intent.superseded) {
          log.debug('Abandoned a superseded device surface activation', {
            targetSurfaceId: intent.target.surfaceId,
          });
          this.settleIntent(intent, 'superseded');
        } else {
          log.error('Device surface switch failed', {
            targetSurfaceId: intent.target.surfaceId,
            error,
          });
          await this.rollbackIntent(intent);
          this.rejectIntent(intent, error);
        }
      } finally {
        if (this.activeIntent === intent) {
          this.activeIntent = null;
        }
      }
    }
  }

  private async transitionTo(
    intent: SwitchIntent,
    target: SurfaceTarget,
    reason: string,
  ): Promise<void> {
    intent.phase = 'preparing';
    const preparingScope = getActiveSurfaceScope();
    const resolved = await this.resolveTarget(intent, target, preparingScope);
    this.assertIntentCurrent(intent, preparingScope, 'prepare device surface');

    if (sameTarget(this.currentTarget, target) && this.currentTargetReady) {
      if (target.deviceId === null) {
        await this.awaitIntent(
          intent,
          this.dependencies.setPeerControllerActive(false, false),
          preparingScope,
          'resume local controller sync',
        );
      } else if (this.currentTarget.deviceName !== target.deviceName) {
        this.currentTarget = target;
        this.publish();
      }
      return;
    }

    const fromTarget = this.currentTarget;
    if (target.deviceId !== null) {
      await this.awaitIntent(
        intent,
        this.dependencies.setPeerControllerActive(true, true),
        preparingScope,
        'pause local controller sync',
      );
    }

    await this.dependencies.resetProductSurface(() => {
      this.assertIntentCurrent(intent, preparingScope, 'reset device surface');
    });
    this.assertIntentCurrent(intent, preparingScope, 'reset device surface');

    const activationScope = this.dependencies.commitSurface(resolved);
    intent.phase = 'hydrating';
    this.currentTarget = target;
    this.currentTargetReady = false;
    this.dependencies.markSurfaceSwitched();
    // The adapter has already moved, but the workspace catalog still belongs
    // to the surface being left. Keep non-React polling in peer mode while the
    // new catalog hydrates; React consumers are notified only after that
    // catalog is authoritative.
    this.dependencies.setPeerDeviceModeActiveFlag(true);

    await this.awaitIntent(
      intent,
      this.dependencies.reloadConfig(activationScope),
      activationScope,
      'reload device surface config',
    );
    await this.awaitIntent(
      intent,
      this.dependencies.rebootstrapWorkspaces(activationScope),
      activationScope,
      'rebootstrap device surface workspaces',
    );

    if (target.deviceId === null) {
      await this.awaitIntent(
        intent,
        this.dependencies.setPeerControllerActive(false, false),
        activationScope,
        'resume local controller sync',
      );
    }

    this.currentTargetReady = true;
    if (target.deviceId === null) {
      this.dependencies.setPeerDeviceModeActiveFlag(false);
    }
    this.dependencies.emitPeerModeChanged({
      active: target.deviceId !== null,
      deviceId: target.deviceId ?? fromTarget.deviceId ?? undefined,
    });
    this.publish();

    log.info('Device surface switched', {
      from: fromTarget.deviceId,
      to: target.deviceId,
      reason,
    });
  }

  private async resolveTarget(
    intent: SwitchIntent,
    target: SurfaceTarget,
    scope: SurfaceScope,
  ): Promise<ResolvedSurfaceTarget> {
    if (target.deviceId === null) {
      const adapter = await this.awaitIntent(
        intent,
        this.dependencies.getLocalAdapter(),
        scope,
        'connect local device surface',
      );
      return { ...target, adapter };
    }

    const connection = await this.awaitIntent(
      intent,
      this.dependencies.connectionManager.connect(target.deviceId, target.deviceName),
      scope,
      'connect peer device surface',
    );
    return { ...target, adapter: connection.adapter };
  }

  private async rollbackIntent(intent: SwitchIntent): Promise<void> {
    if (intent.superseded || intent.abortController.signal.aborted || this.pendingIntent) {
      return;
    }
    const original = intent.fromTarget ?? localTarget();

    // A pre-commit failure left the original surface in place. The only state
    // that may need repair is the controller-side cloud-sync pause.
    if (sameTarget(this.currentTarget, original)) {
      if (original.deviceId === null) {
        await this.dependencies.setPeerControllerActive(false, false);
      }
      return;
    }

    let fallback = original;
    if (fallback.deviceId !== null) {
      const connection = this.dependencies.connectionManager.get(fallback.deviceId);
      if (!connection) {
        fallback = localTarget();
      }
    }

    try {
      intent.rollingBack = true;
      await this.transitionTo(intent, fallback, 'switch_failed');
    } catch (rollbackError) {
      if (!intent.superseded && !isSurfaceChangedError(rollbackError)) {
        log.error('Failed to roll back device surface switch', {
          fallbackSurfaceId: fallback.surfaceId,
          error: rollbackError,
        });
      }
    } finally {
      intent.rollingBack = false;
    }
  }

  private async awaitIntent<T>(
    intent: SwitchIntent,
    promise: Promise<T>,
    scope: SurfaceScope,
    action: string,
  ): Promise<T> {
    this.assertIntentCurrent(intent, scope, action);
    const signal = intent.abortController.signal;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new SurfaceChangedError(scope.surfaceId, scope.epoch, action));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        value => {
          signal.removeEventListener('abort', onAbort);
          try {
            this.assertIntentCurrent(intent, scope, action);
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private assertIntentCurrent(intent: SwitchIntent, scope: SurfaceScope, action: string): void {
    if (
      intent.superseded
      || intent.abortController.signal.aborted
      || this.activeIntent !== intent
    ) {
      throw new SurfaceChangedError(scope.surfaceId, scope.epoch, action);
    }
    scope.assertCurrent(action);
  }

  private supersedeIntent(intent: SwitchIntent): void {
    if (intent.superseded) {
      return;
    }
    intent.superseded = true;
    intent.abortController.abort();
    this.settleIntent(intent, 'superseded');
  }

  private settleIntent(intent: SwitchIntent, outcome: SurfaceSwitchOutcome): void {
    if (intent.settled) {
      return;
    }
    intent.settled = true;
    for (const waiter of intent.waiters.splice(0)) {
      waiter.resolve(outcome);
    }
  }

  private rejectIntent(intent: SwitchIntent, error: unknown): void {
    if (intent.settled) {
      return;
    }
    intent.settled = true;
    for (const waiter of intent.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private handleConnectionStates(connections: readonly PeerConnectionState[]): void {
    this.connectionStates = connections;
    const activeConnection = this.currentTarget.deviceId
      ? connections.find(connection => connection.deviceId === this.currentTarget.deviceId)
      : undefined;
    if (activeConnection?.deviceName && activeConnection.deviceName !== this.currentTarget.deviceName) {
      this.currentTarget = {
        ...this.currentTarget,
        deviceName: activeConnection.deviceName,
      };
    }
    this.publish();

    // Connectivity changes update status only. The user owns surface selection;
    // a peer that is reconnecting retains its transport, epoch and cached state.
  }

  private releaseDeviceState(surfaceId: DeviceSurfaceId, deviceId: string): void {
    this.dependencies.clearDeviceActivity(deviceId);
    this.dependencies.discardSurfaceState(surfaceId);
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn('Device surface listener threw', { error });
      }
    }
  }
}
