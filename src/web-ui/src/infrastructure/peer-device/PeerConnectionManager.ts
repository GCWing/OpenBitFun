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
 * Background attempts to deliver a `peer_control_detach` that could not reach
 * the host during a disconnect. Until one lands, the host keeps fanning out to
 * this controller and keeps its pending approvals waiting for it.
 */
export const PEER_DETACH_MAX_RETRIES = 4;

/**
 * `connecting` → first handshake. `ready` → the peer answers. `degraded` → it
 * needs its control link checked/re-attached. Recovery keeps retrying with a
 * capped delay until explicit disposal; connectivity never selects a different
 * device surface or discards its cached work.
 */
export type PeerConnectionHealth = 'connecting' | 'ready' | 'degraded';

export type PeerHostKind = 'desktop' | 'cli';

export interface PeerHostCapabilities {
  readonly genUiLibrariesV1?: boolean;
  readonly backgroundResultDeliveryV1?: boolean;
  readonly idempotentDialogSubmit: boolean;
  /** Only true after explicit negotiation; older hosts need the upload API. */
  readonly inlineImageAttachmentsV1?: boolean;
  /**
   * `workspace_file_upload` accepts runtime `attachments/` targets, so the
   * controller can attach its own local files. Older hosts keep the explicit
   * unsupported reply.
   */
  readonly runtimeAttachmentUploadV1?: boolean;
  readonly btwInitialModelSelectionV1?: boolean;
  readonly btwModelPoolSelectionV1?: boolean;
  /** Terminal output arrives as replay pages announced on the host stream. */
  readonly terminalCursorReplayV1?: boolean;
  readonly controlConversationV1?: boolean;
  readonly controlConversationResetV1?: boolean;
  readonly targetedSessionRollback: boolean;
  readonly tokenUsageStatistics: boolean;
  /** MiniApp Agent runs accept immutable virtual context-file snapshots. */
  readonly miniAppAgentContextFilesV1: boolean;
  readonly miniAppAgentImagesV1: boolean;
  readonly wslWorkspacesV1?: boolean;
  readonly sshNoneAuthV1?: boolean;
  /** Host keeps `ssh-user@host#port` profiles distinct; older hosts get legacy ids only. */
  readonly sshPortScopedIdentityV1?: boolean;
  /** Host stores ordered subscription account pools on model configs. */
  readonly subscriptionAccountPoolsV1?: boolean;
  /** Host-owned read-only subscription allowance query. */
  readonly subscriptionQuotaV1?: boolean;
  readonly grokQuotaV1?: boolean;
  readonly subscriptionModelQuotaV1?: boolean;
  /** Host routes a model to its configured backup channels. */
  readonly modelChannelRoutingV1?: boolean;
  readonly wholeSessionCopyV1?: boolean;
  readonly sessionTrajectoryV1?: boolean;
  readonly modelRoutingV1?: boolean;
  readonly modelPoolSelectionV1?: boolean;
  readonly magpieDiscoveryV1?: boolean;
  readonly computerUseSharingV1?: boolean;
  /** Typed ProductControl HostInvoke, including shared config read-back. */
  readonly productControlV1?: boolean;
  readonly remoteConnectControlV1?: boolean;
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
  /** Missing on older hosts: Desktop implements PR details, CLI does not. */
  readonly reviewPlatformV1?: boolean | null;
  /** Scoped MCP choices must be explicitly advertised by the host. */
  readonly chatMcpCatalogV1?: boolean;
  readonly sessionReferenceBrowseV1?: boolean;
  readonly workspaceIconV1?: boolean;
  readonly workspaceIdReferencesV1?: boolean;
  readonly gitTrackedChangeCountV1?: boolean;
  readonly workspaceLatexPreviewV1?: boolean;
  /**
   * Host implements `submit_user_answers` for Runtime-owned
   * AskUserQuestion interactions. Older Desktop hosts already implemented the
   * command; older CLI hosts did not.
   */
  readonly userQuestionResponse: boolean | null;
  readonly userQuestionInteraction?: boolean;
  readonly dialogQueueV1?: boolean;
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
  /**
   * The host answers its control plane but its product UI is not ready yet
   * (`peer_mode_ping.host_ui_ready === false`, or a `peer_host_ui_not_ready`
   * refusal). Product requests fail fast as not executed until it clears.
   */
  readonly hostStarting: boolean;
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
  /**
   * Additive (Desktop): whether the host's webview bridge can run product
   * commands. Absent on older hosts, which are treated as ready.
   */
  host_ui_ready?: boolean;
  /**
   * Additive, advertised by `peer_attachment_status_v1`: whether this
   * controller is still attached for DeviceEvent delivery on the host.
   */
  caller_attached?: boolean;
}

/** Ping facts that are not capabilities and may change between keepalives. */
interface PeerPingStatus {
  hostUiReady: boolean;
  /** `null` when the host does not report it (older host). */
  callerAttached: boolean | null;
}

const NO_CAPABILITIES: PeerHostCapabilities = {
  backgroundResultDeliveryV1: false,
  idempotentDialogSubmit: false,
  inlineImageAttachmentsV1: false,
  runtimeAttachmentUploadV1: false,
  btwInitialModelSelectionV1: false,
  btwModelPoolSelectionV1: false,
  terminalCursorReplayV1: false,
  controlConversationV1: false,
  controlConversationResetV1: false,
  targetedSessionRollback: false,
  tokenUsageStatistics: false,
  miniAppAgentContextFilesV1: false,
  miniAppAgentImagesV1: false,
  wslWorkspacesV1: false,
  sshNoneAuthV1: false,
  sshPortScopedIdentityV1: false,
  subscriptionAccountPoolsV1: false,
  subscriptionQuotaV1: false,
  grokQuotaV1: false,
  subscriptionModelQuotaV1: false,
  modelChannelRoutingV1: false,
  wholeSessionCopyV1: false,
  sessionTrajectoryV1: false,
  modelRoutingV1: false,
  modelPoolSelectionV1: false,
  magpieDiscoveryV1: false,
  computerUseSharingV1: false,
  productControlV1: false,
  remoteConnectControlV1: false,
  productControlNativeV1: false,
  productControlPresentationV1: false,
  // Unknown (not yet probed) — not the same as `false` (probed, unsupported).
  // Consumers treat `null` optimistically so an unprobed host is not gated off.
  cancelTool: null,
  toolCatalog: null,
  reviewPlatformV1: null,
  chatMcpCatalogV1: false,
  sessionReferenceBrowseV1: false,
  workspaceIconV1: false,
  workspaceIdReferencesV1: false,
  workspaceLatexPreviewV1: false,
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
  probeRequested: boolean;
  needsReattach: boolean;
  healthCheckInFlight: Promise<void> | null;
  reattachInFlight: Promise<void> | null;
  hostStarting: boolean;
  /** Probes while the host was starting; drives that poll's backoff. */
  startingChecks: number;
  handle: PeerConnection;
}

export type PeerReattachListener = (deviceId: string) => void;

/** A disconnect whose detach did not reach the host yet. */
interface PendingDetach {
  deviceId: string;
  /** Background attempts made so far. */
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  /** Last reported presence of the host, or null before the first report. */
  presenceOnline: boolean | null;
  /** Set when a reconnect or a final outcome retires this retry. */
  settled: boolean;
}

/** The host answered a control-plane command and refused it. */
class PeerControlRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerControlRefusalError';
  }
}

class PeerConnectionDisposedError extends Error {
  constructor(deviceId: string) {
    super(`Peer connection '${deviceId}' was disposed during attachment`);
    this.name = 'PeerConnectionDisposedError';
  }
}

export class PeerConnectionManager {
  private readonly entries = new Map<string, ConnectionEntry>();
  private readonly pendingDetaches = new Map<string, PendingDetach>();
  private readonly legacyHostKinds = new Map<string, PeerHostKind>();
  private readonly attaching = new Map<string, Promise<PeerConnection>>();
  private readonly listeners = new Set<PeerConnectionListener>();
  private readonly reattachListeners = new Set<PeerReattachListener>();
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
    // A new attachment supersedes a disconnect still being delivered; its
    // detach must not land after the attach and drop this controller again.
    const priorDetach = this.retirePendingDetach(deviceId);
    const attach = this.attach(deviceId, deviceName, priorDetach).finally(() => {
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
   * Fires after a health check re-attached this controller (recovery, a
   * presence gap, or a host reporting it no longer attached). Events emitted
   * while detached were not delivered, so owners re-read their mailboxes.
   */
  onReattached(listener: PeerReattachListener): () => void {
    this.reattachListeners.add(listener);
    return () => {
      this.reattachListeners.delete(listener);
    };
  }

  /**
   * End a control link for good: stop its timers, settle everything still
   * waiting on its transport, then tell the peer.
   *
   * The detach RPC is last. A host refusal is re-thrown because the
   * controller cannot otherwise confirm that the Host removed its delivery
   * subscription and finalized controller-scoped interactions. A transport
   * failure is not: the user's disconnect already completed locally, so the
   * detach is retried in the background (and when the host is seen online
   * again) until it lands, the host refuses it, or the device is reconnected.
   * Host-accepted work remains Host-owned and keeps running either way.
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
      try {
        await this.sendDetach(deviceId);
      } catch (error) {
        if (error instanceof PeerControlRefusalError) throw error;
        log.warn('Peer detach could not reach the host; retrying in the background', {
          deviceId,
          error,
        });
        // A reconnect that started while this detach was in flight owns the
        // link now; retrying would drop its attachment.
        if (!this.entries.has(deviceId) && !this.attaching.has(deviceId)) {
          this.queueDetachRetry(deviceId);
        }
      }
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
      } else if (entry.presenceOnline && wasOnline === false && (entry.health === 'degraded' || entry.probeRequested)) {
        this.cancelTimer(entry);
        void this.runHealthCheck(entry);
      }
    }
    // A host seen online again can probably take the detach it missed now.
    for (const pending of this.pendingDetaches.values()) {
      const wasOnline = pending.presenceOnline;
      pending.presenceOnline = online.has(pending.deviceId);
      if (pending.presenceOnline && wasOnline !== true) {
        this.runDetachRetry(pending);
      }
    }
  }

  private async attach(
    deviceId: string,
    deviceName: string,
    priorDetach?: Promise<void>,
  ): Promise<PeerConnection> {
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
        onHostUiNotReady: () => {
          const current = this.entries.get(deviceId);
          if (current?.adapter === adapter) {
            this.markHostStarting(current);
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
      probeRequested: false,
      needsReattach: false,
      healthCheckInFlight: null,
      reattachInFlight: null,
      hostStarting: false,
      startingChecks: 0,
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
      const probe = await this.probeCapabilities(entry);
      entry.capabilities = probe.capabilities;
      entry.hostStarting = !probe.status.hostUiReady;
      this.assertEntryActive(entry);
      // Order the attach after a retried detach that was already on its way.
      await priorDetach;
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
      supportsMiniAppAgentImagesV1: entry.capabilities.miniAppAgentImagesV1,
      supportsWslWorkspacesV1: entry.capabilities.wslWorkspacesV1,
      supportsSshNoneAuthV1: entry.capabilities.sshNoneAuthV1,
      supportsSshPortScopedIdentityV1: entry.capabilities.sshPortScopedIdentityV1,
      supportsWholeSessionCopyV1: entry.capabilities.wholeSessionCopyV1,
      supportsGenUiLibrariesV1: entry.capabilities.genUiLibrariesV1,
      supportsModelRoutingV1: entry.capabilities.modelRoutingV1,
      supportsModelPoolSelectionV1: entry.capabilities.modelPoolSelectionV1,
      supportsMagpieDiscoveryV1: entry.capabilities.magpieDiscoveryV1,
      supportsBtwModelPoolSelectionV1: entry.capabilities.btwModelPoolSelectionV1,
      supportsComputerUseSharingV1: entry.capabilities.computerUseSharingV1,
      supportsProductControlV1: entry.capabilities.productControlV1,
      supportsRemoteConnectControlV1: entry.capabilities.remoteConnectControlV1,
    });
    entry.health = 'ready';
    if (entry.hostStarting) this.scheduleStartingProbe(entry);
    else this.scheduleKeepalive(entry);
    this.publish();
    log.info('Peer connection ready', {
      deviceId,
      capabilities: entry.capabilities,
      hostStarting: entry.hostStarting,
    });
    return entry.handle;
  }

  private async probeCapabilities(
    entry: ConnectionEntry,
  ): Promise<{ capabilities: PeerHostCapabilities; status: PeerPingStatus }> {
    this.assertEntryActive(entry);
    // Hosts that advertise `peer_attachment_status_v1` answer whether this
    // controller id is attached; older hosts ignore the argument.
    const result = await this.hostInvoke<PeerModePingResult>(entry.deviceId, 'peer_mode_ping', {
      controller_device_id: await this.controllerId(),
    });
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

    const status: PeerPingStatus = {
      hostUiReady: result?.host_ui_ready !== false,
      callerAttached: caps?.peer_attachment_status_v1 === true && typeof result?.caller_attached === 'boolean'
        ? result.caller_attached
        : null,
    };
    return { status, capabilities: {
      idempotentDialogSubmit: caps?.idempotent_dialog_submit === true,
      backgroundResultDeliveryV1: caps?.background_result_delivery_v1 === true,
      inlineImageAttachmentsV1: caps?.inline_image_attachments_v1 === true,
      runtimeAttachmentUploadV1: caps?.runtime_attachment_upload_v1 === true,
      btwInitialModelSelectionV1: caps?.btw_initial_model_selection_v1 === true,
      btwModelPoolSelectionV1: caps?.btw_model_pool_selection_v1 === true,
      terminalCursorReplayV1: caps?.terminal_cursor_replay_v1 === true,
      controlConversationV1: caps?.control_conversation_v1 === true,
      controlConversationResetV1: caps?.control_conversation_reset_v1 === true,
      targetedSessionRollback: caps?.targeted_session_rollback === true,
      tokenUsageStatistics: caps?.token_usage_statistics === true,
      miniAppAgentContextFilesV1: caps?.miniapp_agent_context_files_v1 === true,
      miniAppAgentImagesV1: caps?.miniapp_agent_images_v1 === true,
      wslWorkspacesV1: caps?.wsl_workspaces_v1 === true,
      sshNoneAuthV1: caps?.ssh_none_auth_v1 === true,
      sshPortScopedIdentityV1: caps?.ssh_port_scoped_identity_v1 === true,
      subscriptionAccountPoolsV1: caps?.subscription_account_pools_v1 === true,
      subscriptionQuotaV1: caps?.subscription_quota_v1 === true,
      grokQuotaV1: caps?.grok_quota_v1 === true,
      subscriptionModelQuotaV1: caps?.subscription_model_quota_v1 === true,
      modelChannelRoutingV1: caps?.model_channel_routing_v1 === true,
      wholeSessionCopyV1: caps?.whole_session_copy_v1 === true,
      sessionTrajectoryV1: caps?.session_trajectory_v1 === true,
      genUiLibrariesV1: caps?.gen_ui_libraries_v1 === true,
      modelRoutingV1: caps?.model_routing_v1 === true,
      modelPoolSelectionV1: caps?.model_pool_selection_v1 === true,
      magpieDiscoveryV1: caps?.magpie_discovery_v1 === true,
      computerUseSharingV1: caps?.computer_use_sharing_v1 === true,
      productControlV1: caps?.product_control_v1 === true,
      remoteConnectControlV1: caps?.remote_connect_control_v1 === true,
      productControlNativeV1: caps?.product_control_native_v1 === true,
      productControlPresentationV1:
        caps?.product_control_presentation_v1 === true,
      cancelTool,
      toolCatalog,
      reviewPlatformV1: caps?.review_platform_v1 === undefined ? null : caps.review_platform_v1 === true,
      chatMcpCatalogV1: caps?.chat_mcp_catalog_v1 === true,
      sessionReferenceBrowseV1: caps?.session_reference_browse_v1 === true,
      workspaceIconV1: caps?.workspace_icon_v1 === true,
      workspaceIdReferencesV1: caps?.workspace_id_references_v1 === true,
      gitTrackedChangeCountV1: caps?.git_tracked_change_count_v1 === true,
      workspaceLatexPreviewV1: caps?.workspace_latex_preview_v1 === true,
      userQuestionResponse,
      userQuestionInteraction: caps?.user_question_interaction_v1 === true,
      dialogQueueV1: caps?.dialog_queue_v1 === true,
      hostKind,
    } };
  }

  private async sendAttach(deviceId: string): Promise<void> {
    await this.hostInvoke(deviceId, 'peer_control_attach', {
      controller_device_id: await this.controllerId(),
    });
  }

  private async sendDetach(deviceId: string): Promise<void> {
    await this.hostInvoke(deviceId, 'peer_control_detach', {
      controller_device_id: await this.controllerId(),
    });
  }

  private queueDetachRetry(deviceId: string): void {
    this.retirePendingDetach(deviceId);
    const pending: PendingDetach = {
      deviceId,
      attempts: 0,
      timer: null,
      inFlight: null,
      presenceOnline: null,
      settled: false,
    };
    this.pendingDetaches.set(deviceId, pending);
    this.scheduleDetachRetry(pending);
  }

  private scheduleDetachRetry(pending: PendingDetach): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    const delayMs = Math.min(
      this.reconnectBaseDelayMs * (2 ** pending.attempts),
      this.reconnectMaxDelayMs,
    );
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.runDetachRetry(pending);
    }, delayMs);
  }

  /** One background detach attempt; never throws and never blocks a caller. */
  private runDetachRetry(pending: PendingDetach): void {
    if (pending.settled || pending.inFlight) return;
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.attempts += 1;
    const finish = () => {
      pending.settled = true;
      if (this.pendingDetaches.get(pending.deviceId) === pending) {
        this.pendingDetaches.delete(pending.deviceId);
      }
    };
    pending.inFlight = this.sendDetach(pending.deviceId).then(
      () => {
        if (pending.settled) return;
        log.info('Peer detach delivered after retry', {
          deviceId: pending.deviceId,
          attempts: pending.attempts,
        });
        finish();
      },
      (error: unknown) => {
        if (pending.settled) return;
        if (error instanceof PeerControlRefusalError) {
          log.warn('Peer host refused a retried detach', { deviceId: pending.deviceId, error });
          finish();
        } else if (pending.attempts >= PEER_DETACH_MAX_RETRIES) {
          log.warn('Peer detach could not reach the host; it drops this controller on presence loss', {
            deviceId: pending.deviceId,
            attempts: pending.attempts,
            error,
          });
          finish();
        } else {
          this.scheduleDetachRetry(pending);
        }
      },
    ).finally(() => {
      pending.inFlight = null;
    });
  }

  /**
   * Stop retrying a detach for `deviceId`. Returns the attempt still in
   * flight, if any, so a new attach can be ordered after it.
   */
  private retirePendingDetach(deviceId: string): Promise<void> | undefined {
    const pending = this.pendingDetaches.get(deviceId);
    if (!pending) return undefined;
    this.pendingDetaches.delete(deviceId);
    pending.settled = true;
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    return pending.inFlight ?? undefined;
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

  /** While the host UI starts, poll it with its own capped backoff. */
  private scheduleStartingProbe(entry: ConnectionEntry): void {
    this.cancelTimer(entry);
    const delayMs = Math.min(
      this.reconnectBaseDelayMs * (2 ** Math.max(0, entry.startingChecks - 1)),
      this.reconnectMaxDelayMs,
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.runHealthCheck(entry);
    }, delayMs);
  }

  private markHostStarting(entry: ConnectionEntry): void {
    if (this.entries.get(entry.deviceId) !== entry || entry.disposed) return;
    if (!entry.hostStarting) {
      entry.hostStarting = true;
      this.publish();
    }
    if (!entry.healthCheckInFlight && entry.health === 'ready') this.scheduleStartingProbe(entry);
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
      entry.probeRequested = false;
      if (this.entries.get(entry.deviceId) !== entry || entry.disposed) return;
      if (entry.health !== 'ready' || entry.needsReattach) this.scheduleReconnect(entry);
      else if (entry.hostStarting) this.scheduleStartingProbe(entry);
      else this.scheduleKeepalive(entry);
    });
    entry.healthCheckInFlight = check;
    return check;
  }

  private async checkHealth(entry: ConnectionEntry): Promise<void> {
    try {
      const { capabilities, status } = await this.probeCapabilities(entry);
      // The host may have dropped this controller (presence loss, routing
      // restart) while every request still succeeded; re-attach instead of
      // reporting `ready` for a link that receives no events.
      const lostAttachment = status.callerAttached === false;
      if (lostAttachment) {
        log.info('Peer host no longer has this controller attached; re-attaching', {
          deviceId: entry.deviceId,
        });
      }
      // A request/presence failure may have arrived while the ping was in
      // flight. Check the current state, not the state at probe start.
      const reattached = entry.health === 'degraded' || entry.needsReattach || lostAttachment;
      if (reattached) {
        entry.needsReattach = false;
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
        supportsMiniAppAgentImagesV1: capabilities.miniAppAgentImagesV1,
        supportsWslWorkspacesV1: capabilities.wslWorkspacesV1,
        supportsSshNoneAuthV1: capabilities.sshNoneAuthV1,
        supportsSshPortScopedIdentityV1: capabilities.sshPortScopedIdentityV1,
        supportsWholeSessionCopyV1: capabilities.wholeSessionCopyV1,
        supportsGenUiLibrariesV1: capabilities.genUiLibrariesV1,
        supportsModelRoutingV1: capabilities.modelRoutingV1,
        supportsModelPoolSelectionV1: capabilities.modelPoolSelectionV1,
        supportsMagpieDiscoveryV1: capabilities.magpieDiscoveryV1,
        supportsBtwModelPoolSelectionV1: capabilities.btwModelPoolSelectionV1,
        supportsComputerUseSharingV1: capabilities.computerUseSharingV1,
        supportsProductControlV1: capabilities.productControlV1,
        supportsRemoteConnectControlV1: capabilities.remoteConnectControlV1,
      });
      entry.consecutiveFailures = 0;
      const recovered = entry.health !== 'ready';
      entry.health = 'ready';
      const startingChanged = entry.hostStarting !== !status.hostUiReady;
      entry.hostStarting = !status.hostUiReady;
      entry.startingChecks = entry.hostStarting ? entry.startingChecks + 1 : 0;
      // Events emitted while this controller was not attached were not
      // delivered; owners re-read their interaction mailboxes.
      if (reattached) this.notifyReattached(entry.deviceId);
      // Publish when the host's advertised capabilities changed too, not only
      // on recovery: a peer that stayed `ready` but restarted on a different
      // build mid-session must push a fresh React snapshot, or UI keeps gating
      // on stale capabilities (e.g. a tool-catalog flag flipping). See #2428 #6.
      const capabilitiesChanged = !capabilitiesEqual(previousCapabilities, capabilities);
      if (recovered || capabilitiesChanged || startingChanged) {
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
    // Roster omissions and product timeouts are hints, not proof of a broken
    // control link. Verify silently; only a failed dedicated probe degrades UI.
    if (reason === 'presence') entry.needsReattach = true;
    if (entry.probeRequested) return;
    entry.probeRequested = true;
    log.debug('Checking peer control link after a transport hint', {
      deviceId: entry.deviceId, reason, action,
    });
    if (!entry.healthCheckInFlight) this.scheduleReconnect(entry);
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
      throw new PeerControlRefusalError(envelope.message || `Peer '${command}' failed`);
    }
    if (envelope.resp === 'host_invoke_result' && !envelope.ok) {
      throw new PeerControlRefusalError(envelope.error || `Peer '${command}' failed`);
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
      hostStarting: entry.hostStarting,
    };
  }

  private notifyReattached(deviceId: string): void {
    for (const listener of Array.from(this.reattachListeners)) {
      try {
        listener(deviceId);
      } catch (error) {
        log.warn('Peer re-attach listener threw', error);
      }
    }
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
 * Shallow-compare every capability field a React snapshot exposes. Used by the
 * keepalive path to decide whether a fresh `publish()` is warranted when a
 * `ready` peer's host reports different capabilities (e.g. after a restart on
 * a different build) without a state transition. `null` (unknown) and a boolean
 * are intentionally distinct: an unprobed field flipping to a concrete value is
 * a change the UI should react to. The comparison walks the union of keys so a
 * newly negotiated capability can never be forgotten here.
 */
export function capabilitiesEqual(
  a: PeerHostCapabilities,
  b: PeerHostCapabilities,
): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function isUnsupportedPeerCommandError(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(`command '${command}' is not supported on CLI peer host`);
}

/** Window-wide instance; peer links outlive any component that renders them. */
export const peerConnectionManager = new PeerConnectionManager();
