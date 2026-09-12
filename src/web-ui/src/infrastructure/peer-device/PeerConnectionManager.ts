/**
 * Peer connection lifecycle, outside React.
 *
 * Attaching to a peer is a long-lived state machine — handshake, capability
 * negotiation, keepalive, backoff, teardown — and it has to outlive whatever is
 * on screen: attachments survive surface switches, keep running our work, and
 * must not restart because a provider re-rendered. Expressed as effects it
 * became several timers and async closures racing over refs, where a switch
 * during a reconnect could leave a peer attached with no keepalive, or detached
 * with a timer still firing.
 *
 * So the lifecycle lives here as plain state with explicit transitions, and
 * React only subscribes: `subscribe()` + `list()` feed a component, `get()`
 * hands back the transport adapter, `dispose()` tears one down deterministically.
 * Nothing in this file may import React.
 */

import { PeerDeviceTransportAdapter } from '@/infrastructure/api/adapters/peer-device-adapter';
import type { PeerHostCapabilityId } from '@/infrastructure/api/generated/remoteSurface';
import { remoteConnectAPI } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { createLogger } from '@/shared/utils/logger';
import type { DeviceSurfaceId } from './deviceSurface';

const log = createLogger('PeerConnectionManager');

export const PEER_CONTROL_RPC_TIMEOUT_MS = 15_000;
export const PEER_KEEPALIVE_INTERVAL_MS = 20_000;
export const PEER_RECONNECT_BASE_DELAY_MS = 1_000;
export const PEER_RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * `connecting` → first handshake. `ready` → the peer answers. `degraded` → it
 * needs its control link checked/re-attached. Recovery keeps retrying with a
 * capped delay until explicit disposal; connectivity never selects a different
 * device surface or discards its cached work.
 */
export type PeerConnectionHealth = 'connecting' | 'ready' | 'degraded';

export type PeerHostKind = 'desktop' | 'cli';

export interface PeerHostCapabilities {
  readonly idempotentDialogSubmit: boolean;
  /** Only true after explicit negotiation; older hosts need the upload API. */
  readonly inlineImageAttachmentsV1?: boolean;
  readonly targetedSessionRollback: boolean;
  readonly tokenUsageStatistics: boolean;
  /** MiniApp Agent runs accept immutable virtual context-file snapshots. */
  readonly miniAppAgentContextFilesV1: boolean;
  readonly wslWorkspacesV1?: boolean;
  /** Typed ProductControl HostInvoke, including shared config read-back. */
  readonly productControlV1?: boolean;
  /**
   * ProductControl definitions that need a host-native provider or a live
   * presentation surface. The controller does not pre-check these: the peer
   * host executes the same owner handler and returns a typed unsupported
   * result when the definition needs a surface it lacks (peer-device README,
   * invariant 16). They are kept here so a future pre-send gate reads the
   * negotiated value instead of guessing by host kind.
   */
  readonly productControlNativeV1?: boolean;
  readonly productControlPresentationV1?: boolean;
  /**
   * Host implements `cancel_tool` (per-tool interrupt). `null` = the host's
   * `peer_mode_ping` did not advertise the field (older host): resolve via
   * `hostKind` — an older Desktop always implemented cancel_tool, an older CLI
   * never did. The controller currently has no consumer (the Terminal
   * Interrupt button left with the legacy TerminalControl tool); hosts keep
   * advertising it for older controllers that still render that button.
   */
  readonly cancelTool: boolean | null;
  /**
   * Host implements `get_all_tools_info` (read-only tool catalog). Gates the
   * Agents/Assistant tool list. `null` = the host did not advertise the field
   * (older host); resolve via `hostKind` the same way as `cancelTool`.
   */
  readonly toolCatalog: boolean | null;
  /** Scoped MCP choices must be explicitly advertised by the host. */
  readonly chatMcpCatalogV1?: boolean;
  /**
   * Host implements `submit_user_answers` for Runtime-owned
   * AskUserQuestion interactions. Older Desktop hosts already implemented the
   * command; older CLI hosts did not.
   */
  readonly userQuestionResponse: boolean | null;
  /**
   * Which kind of host answered `peer_mode_ping` (`"desktop"` | `"cli"`).
   * `null` = the host did not advertise `host_type` (even older host, or the
   * field is genuinely absent). Lets a controller resolve a `null` capability
   * for an older host: an old Desktop (always implemented cancel_tool/tool
   * catalog) stays optimistic, an old CLI (never did) is treated as
   * unsupported. See PR #2428 round 5 #1.
   */
  readonly hostKind: PeerHostKind | null;
}

/** Immutable view of one connection; safe to hold in component state. */
export interface PeerConnectionState {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly surfaceId: DeviceSurfaceId;
  readonly health: PeerConnectionHealth;
  readonly capabilities: PeerHostCapabilities;
  /** Failed health checks since the last completed handshake; drives backoff. */
  readonly consecutiveFailures: number;
}

/** Live handle. `adapter` is the product transport for this device. */
export interface PeerConnection {
  readonly deviceId: string;
  readonly surfaceId: DeviceSurfaceId;
  readonly adapter: PeerDeviceTransportAdapter;
  getState(): PeerConnectionState;
}

export type PeerConnectionListener = (connections: readonly PeerConnectionState[]) => void;

export type PeerDeviceRpc = (
  targetDeviceId: string,
  commandJson: string,
  timeoutMs?: number,
) => Promise<string>;

export interface PeerConnectionManagerOptions {
  deviceRpc?: PeerDeviceRpc;
  getControllerDeviceId?: () => Promise<string>;
  controlRpcTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface PeerDisposeOptions {
  /**
   * Send `peer_control_detach`. Skip it for a peer that is already gone — the
   * host prunes the stale controller through presence instead.
   */
  notifyPeer?: boolean;
}

interface HostInvokeEnvelope {
  resp?: string;
  ok?: boolean;
  value?: unknown;
  error?: string;
  message?: string;
}

interface PeerModePingResult {
  host_type?: string;
  /**
   * Only advertised keys are present, each `true`; a missing key means the
   * host predates that capability and is resolved through `host_type`. The
   * key set is the registry's (`PEER_HOST_CAPABILITY_IDS`), shared with both
   * peer hosts, so a probe cannot ask for a key no host will ever send.
   */
  capabilities?: Partial<Record<PeerHostCapabilityId, boolean>>;
  /** Additive: digest of the registry the host was built from. */
  surface_registry_digest?: string;
}

const NO_CAPABILITIES: PeerHostCapabilities = {
  idempotentDialogSubmit: false,
  inlineImageAttachmentsV1: false,
  targetedSessionRollback: false,
  tokenUsageStatistics: false,
  miniAppAgentContextFilesV1: false,
  wslWorkspacesV1: false,
  productControlV1: false,
  productControlNativeV1: false,
  productControlPresentationV1: false,
  // Unknown (not yet probed) — not the same as `false` (probed, unsupported).
  // Consumers treat `null` optimistically so an unprobed host is not gated off.
  cancelTool: null,
  toolCatalog: null,
  chatMcpCatalogV1: false,
  userQuestionResponse: null,
  // Host kind is unknown until the first `peer_mode_ping` resolves. Consumers
  // treat `null` optimistically. See PR #2428 round 5 #1.
  hostKind: null,
};

function parseHostKind(value: string | undefined): PeerHostKind | null {
  if (value === 'desktop') return 'desktop';
  if (value === 'cli') return 'cli';
  return null;
}

interface ConnectionEntry {
  deviceId: string;
  deviceName: string;
  adapter: PeerDeviceTransportAdapter;
  health: PeerConnectionHealth;
  capabilities: PeerHostCapabilities;
  consecutiveFailures: number;
  timer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  presenceOnline: boolean | null;
  healthCheckInFlight: Promise<void> | null;
  reattachInFlight: Promise<void> | null;
  handle: PeerConnection;
}

class PeerConnectionDisposedError extends Error {
  constructor(deviceId: string) {
    super(`Peer connection '${deviceId}' was disposed during attachment`);
    this.name = 'PeerConnectionDisposedError';
  }
}

export class PeerConnectionManager {
  private readonly entries = new Map<string, ConnectionEntry>();
  private readonly legacyHostKinds = new Map<string, PeerHostKind>();
  private readonly attaching = new Map<string, Promise<PeerConnection>>();
  private readonly listeners = new Set<PeerConnectionListener>();
  private readonly deviceRpc: PeerDeviceRpc;
  private readonly resolveControllerDeviceId: () => Promise<string>;
  private readonly controlRpcTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private controllerDeviceId: string | null = null;
  private snapshot: readonly PeerConnectionState[] = [];

  constructor(options: PeerConnectionManagerOptions = {}) {
    this.deviceRpc = options.deviceRpc
      ?? ((target, commandJson, timeoutMs) =>
        remoteConnectAPI.accountDeviceRpc(target, commandJson, timeoutMs));
    this.resolveControllerDeviceId = options.getControllerDeviceId
      ?? (async () => (await remoteConnectAPI.getDeviceInfo()).device_id);
    this.controlRpcTimeoutMs = options.controlRpcTimeoutMs ?? PEER_CONTROL_RPC_TIMEOUT_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? PEER_KEEPALIVE_INTERVAL_MS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? PEER_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? PEER_RECONNECT_MAX_DELAY_MS;
  }

  /**
   * Attach to `deviceId`, or return the existing connection. Attaching does not
   * render the device; the caller decides what the window draws.
   *
   * Rejects (leaving nothing behind) when the handshake fails, so a caller can
   * report the failure without first having to clean up a half-attached peer.
   */
  connect(deviceId: string, deviceName = ''): Promise<PeerConnection> {
    if (!deviceId) {
      return Promise.reject(new Error('deviceId is required'));
    }
    const existing = this.entries.get(deviceId);
    if (existing) {
      this.renameEntry(existing, deviceName);
      return Promise.resolve(existing.handle);
    }
    const inFlight = this.attaching.get(deviceId);
    if (inFlight) {
      return inFlight;
    }
    const attach = this.attach(deviceId, deviceName).finally(() => {
      this.attaching.delete(deviceId);
    });
    this.attaching.set(deviceId, attach);
    return attach;
  }

  get(deviceId: string): PeerConnection | undefined {
    return this.entries.get(deviceId)?.handle;
  }

  has(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }

  /** Stable between changes, so a React consumer can compare by reference. */
  list(): readonly PeerConnectionState[] {
    return this.snapshot;
  }

  /** Listeners fire on change only; read `list()` for the current value. */
  subscribe(listener: PeerConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * End a control link for good: stop its timers, settle everything still
   * waiting on its transport, then tell the peer.
   *
   * The detach RPC is last and its failure is re-thrown because the controller
   * cannot otherwise confirm that the Host removed its delivery subscription
   * and finalized controller-scoped interactions. Host-accepted work remains
   * Host-owned and keeps running either way. Local teardown has already
   * completed before the RPC settles.
   */
  async dispose(deviceId: string, options: PeerDisposeOptions = {}): Promise<void> {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }
    entry.disposed = true;
    this.entries.delete(deviceId);
    this.legacyHostKinds.delete(deviceId);
    this.cancelTimer(entry);
    this.publish();

    try {
      await entry.adapter.disconnect();
    } catch (error) {
      log.warn('Peer transport teardown failed', { deviceId, error });
    }

    // If disposal raced the handshake, let the attach task observe `disposed`
    // before the final detach. In particular, when `peer_control_attach` was
    // already in flight, detach must be ordered after it or the late attach
    // would resurrect a control link the controller considers closed.
    await this.attaching.get(deviceId)?.catch(() => undefined);
    await entry.reattachInFlight?.catch(() => undefined);

    log.info('Peer connection disposed', { deviceId });

    if (options.notifyPeer !== false) {
      await this.hostInvoke(deviceId, 'peer_control_detach', {
        controller_device_id: await this.controllerId(),
      });
    }
  }

  async disposeAll(options: PeerDisposeOptions = {}): Promise<void> {
    for (const deviceId of Array.from(this.entries.keys())) {
      try {
        await this.dispose(deviceId, options);
      } catch (error) {
        log.warn('Failed to dispose peer connection', { deviceId, error });
      }
    }
  }

  /**
   * Presence is a hint, not a lifetime boundary: a relay reconnect can briefly
   * omit an otherwise running host. Retain the attachment and verify it with
   * a handshake. Repeated roster updates must not postpone an existing retry.
   */
  reportPresence(onlineDeviceIds: Iterable<string>): void {
    const online = new Set(onlineDeviceIds);
    for (const entry of this.entries.values()) {
      const wasOnline = entry.presenceOnline;
      entry.presenceOnline = online.has(entry.deviceId);
      if (!entry.presenceOnline && wasOnline !== false) {
        this.requestRecovery(entry, 'presence');
      } else if (entry.presenceOnline && wasOnline === false && entry.health === 'degraded') {
        this.cancelTimer(entry);
        void this.runHealthCheck(entry);
      }
    }
  }

  private async attach(deviceId: string, deviceName: string): Promise<PeerConnection> {
    const adapter = new PeerDeviceTransportAdapter(
      deviceId,
      (target, commandJson, timeoutMs) => this.deviceRpc(target, commandJson, timeoutMs),
      {
        // Product timeouts request a probe; they are not independent evidence
        // of host loss and must not consume the health-check retry counter.
        onHostInvokeTransportFailure: (_error, meta) => {
          const current = this.entries.get(deviceId);
          if (current?.adapter === adapter) {
            this.requestRecovery(current, 'request', meta?.action);
          }
        },
      },
    );
    const entry: ConnectionEntry = {
      deviceId,
      deviceName,
      adapter,
      health: 'connecting',
      capabilities: NO_CAPABILITIES,
      consecutiveFailures: 0,
      timer: null,
      disposed: false,
      presenceOnline: null,
      healthCheckInFlight: null,
      reattachInFlight: null,
      handle: {
        deviceId,
        surfaceId: adapter.surfaceId,
        adapter,
        getState: () => this.stateOf(entry),
      },
    };
    this.entries.set(deviceId, entry);
    this.publish();

    try {
      await adapter.connect();
      this.assertEntryActive(entry);
      entry.capabilities = await this.probeCapabilities(entry);
      this.assertEntryActive(entry);
      await this.sendAttach(deviceId);
      this.assertEntryActive(entry);
    } catch (error) {
      if (this.entries.get(deviceId) === entry) {
        this.entries.delete(deviceId);
      }
      this.legacyHostKinds.delete(deviceId);
      await adapter.disconnect().catch(() => undefined);
      this.publish();
      throw error;
    }

    adapter.setHostCapabilities({
      supportsIdempotentDialogSubmit: entry.capabilities.idempotentDialogSubmit,
      supportsTargetedSessionRollback: entry.capabilities.targetedSessionRollback,
      supportsTokenUsageStatistics: entry.capabilities.tokenUsageStatistics,
      supportsMiniAppAgentContextFilesV1: entry.capabilities.miniAppAgentContextFilesV1,
      supportsWslWorkspacesV1: entry.capabilities.wslWorkspacesV1,
      supportsProductControlV1: entry.capabilities.productControlV1,
    });
    entry.health = 'ready';
    this.scheduleKeepalive(entry);
    this.publish();
    log.info('Peer connection ready', { deviceId, capabilities: entry.capabilities });
    return entry.handle;
  }

  private async probeCapabilities(entry: ConnectionEntry): Promise<PeerHostCapabilities> {
    this.assertEntryActive(entry);
    const result = await this.hostInvoke<PeerModePingResult>(entry.deviceId, 'peer_mode_ping', {});
    this.assertEntryActive(entry);
    const deviceId = entry.deviceId;
    // For the new fields (cancel_tool / tool_catalog) preserve `undefined` as
    // `null` (unknown) rather than coercing to `false`: an older Desktop that
    // does not advertise the field but does implement the command would
    // otherwise have its working capability hidden. `null` lets consumers
    // stay optimistic; an older CLI that truly lacks the command is resolved
    // via `hostKind` (cli → unsupported) instead of failing on invoke. See
    // PR #2428 #4 + round 5 #1.
    // A legacy host with all three new fields absent is classified by the
    // read-only tool catalog probe below; transport failures remain unknown.
    const caps = result?.capabilities;
    let cancelTool = caps?.cancel_tool === undefined ? null : caps.cancel_tool === true;
    let toolCatalog = caps?.tool_catalog === undefined ? null : caps.tool_catalog === true;
    let userQuestionResponse = caps?.user_question_response === undefined
      ? null
      : caps.user_question_response === true;
    let hostKind = parseHostKind(result?.host_type);

    if (hostKind !== null) {
      this.legacyHostKinds.set(deviceId, hostKind);
      cancelTool ??= hostKind === 'desktop';
      toolCatalog ??= hostKind === 'desktop';
      userQuestionResponse ??= hostKind === 'desktop';
    } else {
      const cachedHostKind = this.legacyHostKinds.get(deviceId);
      if (cachedHostKind !== undefined) {
        hostKind = cachedHostKind;
        cancelTool ??= cachedHostKind === 'desktop';
        toolCatalog ??= cachedHostKind === 'desktop';
        userQuestionResponse ??= cachedHostKind === 'desktop';
      }
    }

    if (hostKind === null && cancelTool === null && toolCatalog === null) {
      this.assertEntryActive(entry);
      try {
        const value = await this.hostInvoke<unknown>(deviceId, 'get_all_tools_info', {});
        this.assertEntryActive(entry);
        if (Array.isArray(value)) {
          hostKind = 'desktop';
          cancelTool = true;
          toolCatalog = true;
          userQuestionResponse = true;
          this.legacyHostKinds.set(deviceId, hostKind);
        }
      } catch (error) {
        if (error instanceof PeerConnectionDisposedError) {
          throw error;
        }
        if (isUnsupportedPeerCommandError(error, 'get_all_tools_info')) {
          this.assertEntryActive(entry);
          hostKind = 'cli';
          cancelTool = false;
          toolCatalog = false;
          userQuestionResponse = false;
          this.legacyHostKinds.set(deviceId, hostKind);
        } else {
          log.warn('Could not classify legacy peer host', { deviceId, error });
        }
      }
    }

    return {
      idempotentDialogSubmit: caps?.idempotent_dialog_submit === true,
      inlineImageAttachmentsV1: caps?.inline_image_attachments_v1 === true,
      targetedSessionRollback: caps?.targeted_session_rollback === true,
      tokenUsageStatistics: caps?.token_usage_statistics === true,
      miniAppAgentContextFilesV1: caps?.miniapp_agent_context_files_v1 === true,
      wslWorkspacesV1: caps?.wsl_workspaces_v1 === true,
      productControlV1: caps?.product_control_v1 === true,
      productControlNativeV1: caps?.product_control_native_v1 === true,
      productControlPresentationV1:
        caps?.product_control_presentation_v1 === true,
      cancelTool,
      toolCatalog,
      chatMcpCatalogV1: caps?.chat_mcp_catalog_v1 === true,
      userQuestionResponse,
      hostKind,
    };
  }

  private async sendAttach(deviceId: string): Promise<void> {
    await this.hostInvoke(deviceId, 'peer_control_attach', {
      controller_device_id: await this.controllerId(),
    });
  }

  private scheduleKeepalive(entry: ConnectionEntry): void {
    this.cancelTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.runHealthCheck(entry);
    }, this.keepaliveIntervalMs);
  }

  /**
   * Backoff is driven by the failure count, so a peer that keeps missing pings
   * is polled progressively less often instead of hammering a weak relay.
   */
  private scheduleReconnect(entry: ConnectionEntry): void {
    this.cancelTimer(entry);
    const delayMs = Math.min(
      this.reconnectBaseDelayMs * (2 ** Math.max(0, entry.consecutiveFailures - 1)),
      this.reconnectMaxDelayMs,
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.runHealthCheck(entry);
    }, delayMs);
  }

  /**
   * One probe covers both roles: while `ready` it is the keepalive, while
   * `degraded` it is the reconnect attempt. A degraded peer re-sends
   * `peer_control_attach` because the host may have pruned this controller
   * during the gap that made us degraded in the first place.
   */
  private runHealthCheck(entry: ConnectionEntry): Promise<void> {
    if (this.entries.get(entry.deviceId) !== entry || entry.disposed) {
      return Promise.resolve();
    }
    if (entry.healthCheckInFlight) {
      return entry.healthCheckInFlight;
    }
    this.cancelTimer(entry);
    const check = this.checkHealth(entry).finally(() => {
      if (entry.healthCheckInFlight !== check) return;
      entry.healthCheckInFlight = null;
      if (this.entries.get(entry.deviceId) !== entry || entry.disposed) return;
      if (entry.health === 'ready') this.scheduleKeepalive(entry);
      else this.scheduleReconnect(entry);
    });
    entry.healthCheckInFlight = check;
    return check;
  }

  private async checkHealth(entry: ConnectionEntry): Promise<void> {
    try {
      const capabilities = await this.probeCapabilities(entry);
      // A request/presence failure may have arrived while the ping was in
      // flight. Check the current state, not the state at probe start.
      if (entry.health === 'degraded') {
        const reattach = this.sendAttach(entry.deviceId);
        entry.reattachInFlight = reattach;
        try {
          await reattach;
        } finally {
          if (entry.reattachInFlight === reattach) entry.reattachInFlight = null;
        }
      }
      this.assertEntryActive(entry);
      const previousCapabilities = entry.capabilities;
      entry.capabilities = capabilities;
      entry.adapter.setHostCapabilities({
        supportsIdempotentDialogSubmit: capabilities.idempotentDialogSubmit,
        supportsTargetedSessionRollback: capabilities.targetedSessionRollback,
        supportsTokenUsageStatistics: capabilities.tokenUsageStatistics,
        supportsMiniAppAgentContextFilesV1: capabilities.miniAppAgentContextFilesV1,
        supportsWslWorkspacesV1: capabilities.wslWorkspacesV1,
        supportsProductControlV1: capabilities.productControlV1,
      });
      entry.consecutiveFailures = 0;
      const recovered = entry.health !== 'ready';
      entry.health = 'ready';
      // Publish when the host's advertised capabilities changed too, not only
      // on recovery: a peer that stayed `ready` but restarted on a different
      // build mid-session must push a fresh React snapshot, or UI keeps gating
      // on stale capabilities (e.g. a tool-catalog flag flipping). See #2428 #6.
      const capabilitiesChanged = !capabilitiesEqual(previousCapabilities, capabilities);
      if (recovered || capabilitiesChanged) {
        if (recovered) {
          log.info('Peer connection recovered', { deviceId: entry.deviceId });
        }
        this.publish();
      }
    } catch (error) {
      this.noteFailure(entry, error);
    }
  }

  /** The dedicated handshake is the only source of the retry counter. */
  private noteFailure(entry: ConnectionEntry, error: unknown): void {
    if (this.entries.get(entry.deviceId) !== entry || entry.disposed) {
      return;
    }
    entry.consecutiveFailures += 1;
    log.warn('Peer health check failed; retrying', {
      deviceId: entry.deviceId,
      consecutiveFailures: entry.consecutiveFailures,
      error,
    });
    entry.health = 'degraded';
    this.publish();
  }

  private requestRecovery(entry: ConnectionEntry, reason: 'presence' | 'request', action?: string): void {
    if (this.entries.get(entry.deviceId) !== entry || entry.disposed || entry.health !== 'ready') {
      return;
    }
    entry.health = 'degraded';
    log.warn('Peer connection degraded; checking control link', {
      deviceId: entry.deviceId,
      reason,
      action,
    });
    // One timer/probe owns recovery. A burst of failed product requests must
    // neither start overlapping handshakes nor push the retry further away.
    if (!entry.healthCheckInFlight) this.scheduleReconnect(entry);
    this.publish();
  }

  private cancelTimer(entry: ConnectionEntry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private assertEntryActive(entry: ConnectionEntry): void {
    if (entry.disposed || this.entries.get(entry.deviceId) !== entry) {
      throw new PeerConnectionDisposedError(entry.deviceId);
    }
  }

  private renameEntry(entry: ConnectionEntry, deviceName: string): void {
    if (!deviceName || entry.deviceName === deviceName) {
      return;
    }
    entry.deviceName = deviceName;
    this.publish();
  }

  private async controllerId(): Promise<string> {
    if (this.controllerDeviceId === null) {
      this.controllerDeviceId = await this.resolveControllerDeviceId();
    }
    return this.controllerDeviceId;
  }

  private async hostInvoke<T>(
    deviceId: string,
    command: string,
    args: Record<string, unknown>,
  ): Promise<T | undefined> {
    const raw = await this.deviceRpc(
      deviceId,
      JSON.stringify({ cmd: 'host_invoke', command, args }),
      this.controlRpcTimeoutMs,
    );
    const envelope = JSON.parse(raw) as HostInvokeEnvelope;
    if (envelope.resp === 'error') {
      throw new Error(envelope.message || `Peer '${command}' failed`);
    }
    if (envelope.resp === 'host_invoke_result' && !envelope.ok) {
      throw new Error(envelope.error || `Peer '${command}' failed`);
    }
    return envelope.value as T | undefined;
  }

  private stateOf(entry: ConnectionEntry): PeerConnectionState {
    return {
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      surfaceId: entry.handle.surfaceId,
      health: entry.health,
      capabilities: entry.capabilities,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  private publish(): void {
    this.snapshot = Array.from(this.entries.values(), entry => this.stateOf(entry));
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.snapshot);
      } catch (error) {
        log.warn('Peer connection listener threw', error);
      }
    }
  }
}

/**
 * Shallow-compare the capability fields a React snapshot exposes. Used by the
 * keepalive path to decide whether a fresh `publish()` is warranted when a
 * `ready` peer's host reports different capabilities (e.g. after a restart on
 * a different build) without a state transition. `null` (unknown) and a boolean
 * are intentionally distinct: an unprobed field flipping to a concrete value is
 * a change the UI should react to.
 */
function capabilitiesEqual(
  a: PeerHostCapabilities,
  b: PeerHostCapabilities,
): boolean {
  return a.idempotentDialogSubmit === b.idempotentDialogSubmit &&
    a.inlineImageAttachmentsV1 === b.inlineImageAttachmentsV1 &&
    a.targetedSessionRollback === b.targetedSessionRollback &&
    a.tokenUsageStatistics === b.tokenUsageStatistics &&
    a.miniAppAgentContextFilesV1 === b.miniAppAgentContextFilesV1 &&
    a.wslWorkspacesV1 === b.wslWorkspacesV1 &&
    a.cancelTool === b.cancelTool &&
    a.toolCatalog === b.toolCatalog &&
    a.chatMcpCatalogV1 === b.chatMcpCatalogV1 &&
    a.userQuestionResponse === b.userQuestionResponse &&
    a.hostKind === b.hostKind;
}

function isUnsupportedPeerCommandError(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(`command '${command}' is not supported on CLI peer host`);
}

/** Window-wide instance; peer links outlive any component that renders them. */
export const peerConnectionManager = new PeerConnectionManager();
