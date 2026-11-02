import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITransportAdapter } from '@/infrastructure/api/adapters/base';
import {
  LOCAL_SURFACE_ID,
  activateSurface,
  getActiveSurfaceId,
  getActiveSurfaceScope,
  onSurfaceActivated,
  resetDeviceSurfaceForTest,
  type SurfaceScope,
} from './deviceSurface';
import {
  PeerDeviceSurfaceController,
  type PeerDeviceSurfaceSnapshot,
} from './PeerDeviceSurfaceController';
import type {
  PeerConnection,
  PeerConnectionState,
} from './PeerConnectionManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function adapter(): ITransportAdapter {
  return {
    connect: vi.fn(async () => undefined),
    request: vi.fn(async () => undefined as never),
    listen: vi.fn(() => () => undefined),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
  };
}

class FakeConnectionManager {
  private readonly connections = new Map<string, PeerConnection>();
  private readonly states = new Map<string, PeerConnectionState>();
  private readonly listeners = new Set<(
    connections: readonly PeerConnectionState[],
  ) => void>();
  private readonly pendingConnections = new Map<string, ReturnType<typeof deferred<PeerConnection>>>();

  readonly connect = vi.fn((deviceId: string, deviceName = ''): Promise<PeerConnection> => {
    const pending = this.pendingConnections.get(deviceId);
    if (pending) {
      return pending.promise;
    }
    return Promise.resolve(this.ensure(deviceId, deviceName));
  });

  readonly dispose = vi.fn(async (deviceId: string): Promise<void> => {
    this.connections.delete(deviceId);
    this.states.delete(deviceId);
    this.publish();
  });

  get(deviceId: string): PeerConnection | undefined {
    return this.connections.get(deviceId);
  }

  list(): readonly PeerConnectionState[] {
    return Array.from(this.states.values());
  }

  subscribe(listener: (connections: readonly PeerConnectionState[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reportPresence(onlineDeviceIds: Iterable<string>): void {
    const online = new Set(onlineDeviceIds);
    for (const state of this.states.values()) {
      if (!online.has(state.deviceId)) {
        this.setHealth(state.deviceId, 'degraded');
      }
    }
  }

  delay(deviceId: string): ReturnType<typeof deferred<PeerConnection>> {
    const pending = deferred<PeerConnection>();
    this.pendingConnections.set(deviceId, pending);
    return pending;
  }

  resolve(deviceId: string, deviceName: string): void {
    const pending = this.pendingConnections.get(deviceId);
    if (!pending) {
      throw new Error(`No pending connection for ${deviceId}`);
    }
    this.pendingConnections.delete(deviceId);
    pending.resolve(this.ensure(deviceId, deviceName));
  }

  setHealth(deviceId: string, health: 'degraded' | 'ready'): void {
    const previous = this.states.get(deviceId);
    if (!previous) {
      return;
    }
    this.states.set(deviceId, {
      ...previous,
      health,
    });
    this.publish();
  }

  private ensure(deviceId: string, deviceName: string): PeerConnection {
    const existing = this.connections.get(deviceId);
    if (existing) {
      return existing;
    }
    const peerAdapter = adapter();
    const connection: PeerConnection = {
      deviceId,
      surfaceId: deviceId,
      adapter: peerAdapter as PeerConnection['adapter'],
      getState: () => this.states.get(deviceId)!,
    };
    this.connections.set(deviceId, connection);
    this.states.set(deviceId, {
      deviceId,
      deviceName,
      surfaceId: deviceId,
      health: 'ready',
      capabilities: {
        idempotentDialogSubmit: true,
        targetedSessionRollback: true,
        tokenUsageStatistics: true,
        miniAppAgentContextFilesV1: true,
        miniAppAgentImagesV1: true,
        cancelTool: true,
        toolCatalog: true,
        userQuestionResponse: true,
        hostKind: 'desktop',
      },
      consecutiveFailures: 0,
    });
    this.publish();
    return connection;
  }

  private publish(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function createHarness(options: {
  rebootstrap?: (scope: SurfaceScope) => Promise<void>;
} = {}) {
  const manager = new FakeConnectionManager();
  const commits: string[] = [];
  const invalidations: string[] = [];
  const discarded: string[] = [];
  const peerModeEvents: Array<{ active: boolean; deviceId?: string }> = [];
  const modeFlags: boolean[] = [];
  const controllerFlags: boolean[] = [];
  let latestSnapshot: PeerDeviceSurfaceSnapshot | null = null;
  let loginListener: ((loggedIn: boolean) => void) | undefined;

  const controller = new PeerDeviceSurfaceController({
    connectionManager: manager,
    getLocalAdapter: async () => adapter(),
    resetProductSurface: async assertCurrent => assertCurrent(),
    reloadConfig: async scope => scope.assertCurrent('reload config'),
    rebootstrapWorkspaces: options.rebootstrap
      ?? (async scope => scope.assertCurrent('rebootstrap workspaces')),
    setPeerControllerActive: async active => {
      controllerFlags.push(active);
    },
    commitSurface: target => {
      commits.push(target.surfaceId);
      return activateSurface(target.surfaceId);
    },
    invalidateCurrentSurface: () => {
      invalidations.push(getActiveSurfaceId());
      return activateSurface(getActiveSurfaceId());
    },
    setPeerDeviceModeActiveFlag: active => modeFlags.push(active),
    emitPeerModeChanged: detail => peerModeEvents.push(detail),
    markSurfaceSwitched: vi.fn(),
    discardSurfaceState: surfaceId => discarded.push(surfaceId),
    clearDeviceActivity: vi.fn(),
    listenPresence: () => () => undefined,
    listenLoginState: listener => {
      loginListener = listener;
      return () => { loginListener = undefined; };
    },
  });
  controller.subscribe(snapshot => {
    latestSnapshot = snapshot;
  });

  return {
    controller,
    manager,
    commits,
    invalidations,
    discarded,
    peerModeEvents,
    modeFlags,
    controllerFlags,
    snapshot: () => latestSnapshot!,
    reportLogin: (loggedIn: boolean) => loginListener?.(loggedIn),
  };
}

describe('PeerDeviceSurfaceController switching', () => {
  beforeEach(() => {
    resetDeviceSurfaceForTest();
  });

  it('commits routing synchronously before surface subscribers run', () => {
    const previousScope = getActiveSurfaceScope();
    let routedSurface = LOCAL_SURFACE_ID;
    const observed: Array<{ surfaceId: string; routedSurface: string }> = [];
    onSurfaceActivated(scope => {
      observed.push({ surfaceId: scope.surfaceId, routedSurface });
    });

    activateSurface('peer-a', () => {
      routedSurface = 'peer-a';
    });

    expect(previousScope.signal.aborted).toBe(true);
    expect(observed).toEqual([{ surfaceId: 'peer-a', routedSurface: 'peer-a' }]);
  });

  it('waits for peer workspace hydration before publishing the new surface', async () => {
    const hydrate = deferred<void>();
    const harness = createHarness({
      rebootstrap: async scope => {
        await hydrate.promise;
        scope.assertCurrent('rebootstrap workspaces');
      },
    });

    const pending = harness.controller.switchToDevice('peer-a', 'A');
    await vi.waitFor(() => expect(harness.commits).toEqual(['peer-a']));

    expect(harness.modeFlags).toEqual([true]);
    expect(harness.peerModeEvents).toEqual([]);
    expect(harness.snapshot().peerMode).toEqual({ active: false });

    hydrate.resolve();
    await expect(pending).resolves.toBe('activated');
    expect(harness.peerModeEvents).toEqual([{ active: true, deviceId: 'peer-a' }]);
    expect(harness.snapshot().peerMode).toMatchObject({ active: true, deviceId: 'peer-a' });
  });

  it('coalesces a rapid switch to the last target before the first connection completes', async () => {
    const harness = createHarness();
    harness.manager.delay('peer-a');

    const first = harness.controller.switchToDevice('peer-a', 'A');
    await Promise.resolve();
    const last = harness.controller.switchToDevice('peer-b', 'B');

    await expect(first).resolves.toBe('superseded');
    await expect(last).resolves.toBe('activated');
    expect(harness.commits).toEqual(['peer-b']);
    expect(harness.snapshot().peerMode).toEqual({
      active: true,
      deviceId: 'peer-b',
      deviceName: 'B',
    });

    // The abandoned handshake may finish, but it cannot commit its surface.
    harness.manager.resolve('peer-a', 'A');
    await Promise.resolve();
    expect(harness.commits).toEqual(['peer-b']);
  });

  it('invalidates an already committed hydrate and lets the newer target proceed', async () => {
    const peerAHydrate = deferred<void>();
    const harness = createHarness({
      rebootstrap: async scope => {
        if (scope.surfaceId === 'peer-a') {
          await peerAHydrate.promise;
        }
        scope.assertCurrent('rebootstrap workspaces');
      },
    });

    const first = harness.controller.switchToDevice('peer-a', 'A');
    await vi.waitFor(() => expect(harness.commits).toEqual(['peer-a']));
    const last = harness.controller.switchToDevice('peer-b', 'B');

    await expect(first).resolves.toBe('superseded');
    await expect(last).resolves.toBe('activated');
    expect(harness.invalidations).toEqual(['peer-a']);
    expect(harness.commits).toEqual(['peer-a', 'peer-b']);
    expect(harness.snapshot().peerMode).toMatchObject({
      active: true,
      deviceId: 'peer-b',
    });

    peerAHydrate.resolve();
  });

  it('rehydrates the last target when rapid A to B to A invalidated A', async () => {
    const firstPeerAHydrate = deferred<void>();
    let peerAHydrateCount = 0;
    const harness = createHarness({
      rebootstrap: async scope => {
        if (scope.surfaceId === 'peer-a' && ++peerAHydrateCount === 1) {
          await firstPeerAHydrate.promise;
        }
        scope.assertCurrent('rebootstrap workspaces');
      },
    });

    const first = harness.controller.switchToDevice('peer-a', 'A');
    await vi.waitFor(() => expect(harness.commits).toEqual(['peer-a']));

    const middle = harness.controller.switchToDevice('peer-b', 'B');
    const last = harness.controller.switchToDevice('peer-a', 'A');

    await expect(first).resolves.toBe('superseded');
    await expect(middle).resolves.toBe('superseded');
    await expect(last).resolves.toBe('activated');
    expect(harness.invalidations).toEqual(['peer-a']);
    expect(harness.commits).toEqual(['peer-a', 'peer-a']);
    expect(peerAHydrateCount).toBe(2);
    expect(harness.snapshot().peerMode).toMatchObject({
      active: true,
      deviceId: 'peer-a',
    });

    firstPeerAHydrate.resolve();
  });

  it('rolls a real activation failure back to the previous peer, not local', async () => {
    const harness = createHarness({
      rebootstrap: async scope => {
        if (scope.surfaceId === 'peer-b') {
          throw new Error('peer B workspace failed');
        }
        scope.assertCurrent('rebootstrap workspaces');
      },
    });

    await expect(harness.controller.switchToDevice('peer-a', 'A'))
      .resolves.toBe('activated');
    await expect(harness.controller.switchToDevice('peer-b', 'B'))
      .rejects.toThrow('peer B workspace failed');

    expect(harness.commits).toEqual(['peer-a', 'peer-b', 'peer-a']);
    expect(harness.snapshot().peerMode).toEqual({
      active: true,
      deviceId: 'peer-a',
      deviceName: 'A',
    });
  });
});

describe('PeerDeviceSurfaceController connection loss', () => {
  beforeEach(() => {
    resetDeviceSurfaceForTest();
  });

  it('preserves the rendered surface and epoch throughout disconnection and recovery', async () => {
    const harness = createHarness();
    harness.controller.start();
    await harness.controller.switchToDevice('peer-a', 'A');
    const originalScope = getActiveSurfaceScope();
    const originalConnection = harness.manager.get('peer-a');

    harness.manager.reportPresence([]);
    await harness.controller.waitForIdle();

    expect(harness.snapshot().peerMode).toEqual({ active: true, deviceId: 'peer-a', deviceName: 'A' });
    expect(harness.snapshot().attachments[0].health).toBe('degraded');
    expect(harness.manager.dispose).not.toHaveBeenCalled();
    expect(harness.discarded).toEqual([]);
    expect(getActiveSurfaceScope().epoch).toBe(originalScope.epoch);
    expect(getActiveSurfaceId()).toBe('peer-a');

    harness.manager.setHealth('peer-a', 'ready');
    expect(harness.commits).toEqual(['peer-a']);
    expect(harness.manager.get('peer-a')).toBe(originalConnection);
    expect(harness.snapshot().attachments[0].health).toBe('ready');
    harness.controller.stop();
  });

  it('returns locally and stops peer attachments when the account logs out during recovery', async () => {
    const harness = createHarness();
    harness.controller.start();
    await harness.controller.switchToDevice('peer-a', 'A');
    harness.manager.reportPresence([]);

    harness.reportLogin(false);
    await vi.waitFor(() => expect(harness.manager.dispose).toHaveBeenCalled());

    expect(harness.snapshot().peerMode).toEqual({ active: false });
    expect(harness.snapshot().attachments).toEqual([]);
    expect(harness.discarded).toEqual(['peer-a']);
    harness.controller.stop();
  });

  it('still allows explicit disconnect while a peer is reconnecting', async () => {
    const harness = createHarness();
    harness.controller.start();
    await harness.controller.switchToDevice('peer-a', 'A');
    harness.manager.reportPresence([]);

    await harness.controller.disconnectDevice('peer-a');

    expect(harness.snapshot().peerMode).toEqual({ active: false });
    expect(harness.discarded).toEqual(['peer-a']);
    expect(harness.manager.dispose).toHaveBeenCalled();
    expect(getActiveSurfaceId()).toBe(LOCAL_SURFACE_ID);
    harness.controller.stop();
  });

});
