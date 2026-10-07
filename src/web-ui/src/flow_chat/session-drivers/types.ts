/**
 * SessionDriver — the seam between flow-chat orchestration and a session's
 * transport family.
 *
 * A driver owns everything flavor-specific about a session: how it is
 * created, deleted, renamed, readied, submitted to, and cancelled. Shared
 * choreography (optimistic turns, queues, title generation, store plumbing)
 * stays in flow-chat-manager and calls into the driver at the points where
 * flavors diverge. New chat features land for every flavor by adding one
 * driver member instead of branching in eight files.
 *
 * Naming note: this is deliberately not called "backend" — the codebase uses
 * "backend session" for the Rust-side agent session (`ensureBackendSession`).
 */

import type { FlowChatContext, SessionConfig } from '../services/flow-chat-manager/types';
import type { QueuedComposerDraft, Session } from '../types/flow-chat';
import type { SessionTitleDescriptor } from '../utils/sessionTitle';
import type { ImageContextData as ImageInputContextData } from '@/infrastructure/api/service-api/ImageContextTypes';
import type { SessionDriverId } from './resolve';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { LineRange } from '@/shared/editor/LineRange';

export type { SessionDriverId } from './resolve';

/** Options accepted by FlowChatManager.sendMessage, threaded to the driver. */
export interface SendMessageOptions {
  imageContexts?: ImageInputContextData[];
  imageDisplayData?: Array<{
    id: string;
    name: string;
    dataUrl?: string;
    imagePath?: string;
    mimeType?: string;
  }>;
  /**
   * Composer snapshot consumed only if shared orchestration queues this
   * submission. Session drivers must not interpret it as transport input.
   */
  pendingQueueDraft?: QueuedComposerDraft;
  /** Only an active composer submission may show the temporary user-message shell. */
  foregroundSubmission?: boolean;
  /**
   * When true, bypass the pending-queue check. Used by the queue drain path
   * to actually start a new dialog turn after the previous one finished.
   * Callers should not set this directly.
   */
  bypassPendingQueue?: boolean;
  /** Use the existing send-now path to steer running work when supported. */
  sendImmediately?: boolean;
  userMessageMetadata?: Record<string, unknown>;
  execution?: import('@/infrastructure/api/service-api/AgentAPI').AgentDialogTurnExecution;
  turnId?: string;
  preserveTurnOnStartError?: boolean;
  onSessionConflictRetryStart?: () => void;
  onSessionConflictRetrySuccess?: () => void;
  fromSessionConflictRetry?: boolean;
  /** Identifies the edit-rerun mutation lease allowed to submit this Turn. */
  sessionMutationLeaseId?: string;
}

/** The message content of one submission, before flavor routing. */
export interface SubmissionDraft {
  message: string;
  displayMessage?: string;
  /**
   * Composer image contexts for this submission. Steering carries them just
   * like a turn submission does, so a message with attachments does not have
   * to wait for a turn boundary.
   */
  imageContexts?: ImageInputContextData[];
}

/**
 * What to do with a submission while the session is busy or has queued
 * messages. `steer` injects into the running work, `queue` parks the message
 * for the drain listener, `reject` refuses with a reason.
 */
export type SubmissionPlan =
  | { kind: 'queue' }
  | { kind: 'steer' }
  | { kind: 'reject'; reason: string };

export interface StartTurnInput {
  /** Device activation that owns every projection write in this submission. */
  surfaceScope: SurfaceScope;
  sessionId: string;
  message: string;
  displayMessage?: string;
  /** Resolved agent type for this turn (falls back to session mode). */
  currentAgentType: string;
  /** Non-null when the session is driven by an external ACP client. */
  acpClientId: string | null;
  isFirstMessage: boolean;
  /** Session snapshot taken after ensureReady. */
  readySession: Session;
  options?: SendMessageOptions;
}

/**
 * Written by the driver as soon as it adds an optimistic turn it wants the
 * shared error path to delete on failure. Read by sendMessage's catch block.
 */
export interface TurnTracker {
  createdLocalTurnId: string | null;
  /**
   * Set once a host has accepted the turn. Until then the turn exists only as a
   * local projection, so a submission interrupted by a device-surface switch
   * must recover the message rather than assume it is running somewhere.
   */
  hostAcceptedTurn: boolean;
  /**
   * Set immediately before `start_dialog_turn` / ACP start is invoked.
   * The host may accept the turn before the client sees the ACK — a surface
   * switch that aborts the invoke must not re-queue a message the host is
   * already executing.
   */
  hostSubmitStarted?: boolean;
}

/**
 * `completed` runs the shared post-submission bookkeeping;
 * `detached` means the message was steered into (or continued) target-owned
 * work and the shared epilogue must be skipped.
 */
export type StartTurnResult = 'completed' | 'detached' | 'queued';

/** Localized strings the usage-report flow surfaces; supplied by the caller. */
export interface UsageReportUiParams {
  isProcessing: boolean;
  busyMessage: string;
  noWorkspaceMessage: string;
  failedTitle: string;
  unknownErrorMessage: string;
}

/**
 * Where a session's pending permission requests come from.
 *
 * `'live'` — the runtime pushes permission events over the transport; the
 * shared hook owns the subscription and reconciliation.
 * Otherwise — an external-store pair (`useSyncExternalStore`-shaped) over the
 * driver's own state; used when requests arrive by polling a durable mailbox.
 */
export type PermissionRequestSource =
  | 'live'
  | {
      subscribe: (listener: () => void) => () => void;
      getSnapshot: () => readonly PermissionRequestLike[];
    };

/** Transport health exposed without leaking a driver-specific store or type. */
export type SessionDriverReachability = 'unknown' | 'reachable' | 'unreachable';

export interface SessionDriverNavigationStatus {
  reachability?: SessionDriverReachability;
}

/**
 * External navigation facts owned by a driver. The source is stable for the
 * driver's lifetime so shared navigation can subscribe without knowing which
 * feature store backs it.
 */
export interface SessionDriverNavigationStatusSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: (sessionId: string) => SessionDriverNavigationStatus;
}

/** Driver-owned changes that can affect conversation ownership before session metadata arrives. */
export interface SessionDriverOwnershipSource {
  subscribe: (listener: () => void) => () => void;
}

/**
 * Structural stand-in for AgentAPI's PermissionRequest wire shape. `object`
 * so both the typed interface and raw store records assign without casts.
 */
export type PermissionRequestLike = object;

export type PermissionReplyKindLike = 'once' | 'always' | 'reject';

/**
 * Everything flavor-independent that session creation resolved before the
 * driver takes over: workspace identity, agent type, and the initial title.
 */
export interface SessionCreationSeed {
  /** Reserve the future session identity without creating a host session yet. */
  draftId?: string;
  /** Device activation that owns the created session projection. */
  surfaceScope: SurfaceScope;
  config: SessionConfig;
  agentType: string;
  sessionName: string;
  titleDescriptor: SessionTitleDescriptor;
  workspacePath: string;
  projectWorkspacePath: string;
  workspaceId?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

/** Cascade facts computed once by the shared caller before removal. */
export interface SessionCascadeRemoval {
  removedSessionIds: string[];
  removedActiveSession: boolean;
}

export interface SessionDriver {
  readonly id: SessionDriverId;

  /** When provided, all session file previews belong to this transport. */
  readonly fileAccess?: {
    open(sessionId: string, filePath: string, fileName: string, lineRange?: LineRange): Promise<void>;
    readImage?(sessionId: string, filePath: string, refresh?: boolean): Promise<string>;
    download?(sessionId: string, filePath: string): Promise<void>;
  };

  /** Optional driver-owned facts used by the shared session navigation UI. */
  readonly navigationStatusSource?: SessionDriverNavigationStatusSource;

  /** Notify shared composer selection when a driver's ownership facts change. */
  readonly ownershipSource?: SessionDriverOwnershipSource;

  /** Create the flavor's session and return its id. */
  createSession(context: FlowChatContext, seed: SessionCreationSeed): Promise<string>;

  /** Remove the session (and its cascade) from this controller. */
  deleteSession(
    context: FlowChatContext,
    sessionId: string,
    removal: SessionCascadeRemoval,
  ): Promise<void>;

  /** Archive the session; observer flavors treat this as a local dismiss. */
  archiveSession(
    context: FlowChatContext,
    sessionId: string,
    removal: SessionCascadeRemoval,
  ): Promise<void>;

  /** Rename and return the effective title. */
  renameSession(
    context: FlowChatContext,
    sessionId: string,
    title: string,
  ): Promise<string>;

  /**
   * Make the session able to accept a submission (backend session,
   * hydration). Drivers with nothing to prepare return void — synchronously —
   * so the caller introduces no microtask boundary before the optimistic
   * turn: a projection must show the user's message before any async work.
   */
  ensureReady(context: FlowChatContext, sessionId: string): Promise<void> | void;

  /** Cancel the in-flight work for this session. Returns whether anything was cancelled. */
  cancel(context: FlowChatContext, sessionId: string): Promise<boolean>;

  /**
   * Decide the fate of a submission arriving while the session is busy or
   * already has queued messages. Must test steer-eligibility before falling
   * back to queue: a steerable message that gets queued never drains for
   * flavors that do not drive the local state machine.
   */
  planSubmission(
    context: FlowChatContext,
    sessionId: string,
    draft: SubmissionDraft,
  ): SubmissionPlan;

  /** Inject a message into the session's currently running work. */
  steer(
    context: FlowChatContext,
    sessionId: string,
    draft: SubmissionDraft,
  ): Promise<void>;

  /**
   * Start (or continue) a turn for an idle session. Owns the flavor-specific
   * optimistic turn, transport call, and post-acknowledgement bookkeeping.
   * Reports any optimistic turn to `tracker` so the shared error path can
   * clean it up when this throws.
   */
  startTurn(
    context: FlowChatContext,
    input: StartTurnInput,
    tracker: TurnTracker,
  ): Promise<StartTurnResult>;

  /**
   * Manually compact the session's context. Local sessions call the runtime
   * directly; dispatch sessions queue a compact turn on the target.
   */
  compactSession(context: FlowChatContext, sessionId: string): Promise<void>;

  /**
   * Produce the session usage report and show it. `uiParams` carries the
   * caller's localized strings; the driver decides where the report data comes
   * from. The report is not written into the transcript.
   */
  runUsageReport(
    context: FlowChatContext,
    sessionId: string,
    uiParams: UsageReportUiParams,
  ): Promise<{ shown: boolean }>;

  /** How pending permission requests for this session are obtained. */
  permissionRequestSource(sessionId: string): PermissionRequestSource;

  /** Answer one permission request over this session's transport. */
  respondPermission(
    sessionId: string,
    requestId: string,
    reply: PermissionReplyKindLike,
    feedback?: string,
  ): Promise<void>;

  /**
   * Answer a request's whole batch. Returns the ids the transport reports as
   * resolved so a live-subscription caller can reconcile its local state;
   * external-store flavors return an empty list (their store refreshes).
   */
  respondPermissionBatch(
    sessionId: string,
    requestId: string,
    reply: PermissionReplyKindLike,
    feedback?: string,
  ): Promise<string[]>;
}
