/**
 * Shared types for FlowChatManager modules.
 */

import type { FlowChatStore } from '../../store/FlowChatStore';
import type { EventBatcher } from '../EventBatcher';
import type { processingStatusManager } from '../ProcessingStatusManager';
import type { FlowToolEvent } from '../EventBatcher';

/**
 * Shared context for FlowChatManager modules.
 */
export interface FlowChatContext {
  flowChatStore: FlowChatStore;
  processingManager: typeof processingStatusManager;
  eventBatcher: EventBatcher;
  pendingTurnCompletions: Map<string, {
    turnId: string;
    lastActivityAt: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** Set when the turn completed with a partial stream recovery. */
    partialRecoveryReason?: string;
  }>;
  /** In-flight historical hydration keyed by device surface, epoch, and session. */
  pendingHistoryLoads: Map<string, Promise<void>>;
  /** Capabilities of each in-flight hydrate, used to avoid reusing a weaker preload. */
  pendingHistoryLoadCapabilities?: Map<string, {
    promise: Promise<void>;
    includeInternal: boolean;
    deferFullHistoryUntilActive: boolean;
    workspaceId: string;
  }>;
  /** In-flight backend context restore keyed by device surface and activation. */
  pendingContextRestores?: Map<string, Promise<void>>;
  /** Content buffers: sessionId -> (roundId -> content) */
  contentBuffers: Map<string, Map<string, string>>;
  /** Active text items: sessionId -> (roundId -> textItemId) */
  activeTextItems: Map<string, Map<string, string>>;
  /** Debounced save timers: key = "sessionId:turnId" */
  saveDebouncers: Map<string, ReturnType<typeof setTimeout>>;
  /** Last save timestamps: key = "sessionId:turnId" */
  lastSaveTimestamps: Map<string, number>;
  /** Last save content hashes: key = "sessionId:turnId" */
  lastSaveHashes: Map<string, string>;
  /** In-flight save tasks: key = "sessionId:turnId" */
  turnSaveInFlight: Map<string, Promise<void>>;
  /** Pending save marks for coalesced serial execution */
  turnSavePending: Set<string>;
  /** Turns requested for persistence before the backend supplied storage identity. */
  deferredStorageIdentitySaves?: Set<string>;
  /** Transient runtime status timers: key = "sessionId:turnId:roundId:scope" */
  runtimeStatusTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Session IDs that the user explicitly cancelled; used to skip unread marking */
  userCancelledSessionIds: Set<string>;
  /**
   * Sessions whose durable history fence (`SessionHistoryChanged`) arrived
   * while the local Turn was still finalizing. Consumed by the completion
   * finalizer so each settled Turn performs exactly one host-tail reconcile,
   * and only after the Runtime committed the terminal record.
   */
  pendingHistoryFenceSessions: Set<string>;
  /**
   * Turn IDs whose terminal lifecycle event (cancelled / failed / completed)
   * has already been applied. Backend may emit the same terminal event twice
   * (e.g. cancelled emitted both by the execution engine when a cancel is
   * detected mid-round and by the coordinator wrapper on the resulting Err);
   * this set is used to make handlers idempotent. Key format: `sessionId:turnId`.
   */
  handledTerminalTurnEvents: Set<string>;
  /**
   * Workspace this manager last initialized for. The ID is the identity used
   * to attribute external sessions whose events carry no workspace facts; the
   * path is only the matching IO projection.
   */
  currentWorkspaceId: string | null;
  currentWorkspacePath: string | null;
  /**
   * Re-arm this window's live agentic subscription. The reconcile loop calls it
   * when it observes a dead subscription, so recovery does not depend on a
   * workspace bootstrap that a newer surface switch may have superseded.
   */
  ensureLiveSubscription?: () => Promise<void>;
}

/**
 * Tool event handling options.
 */
export interface ToolEventOptions {
  /** Whether the event is from a subagent. */
  isSubagent?: boolean;
  /** Parent tool timestamp. */
  parentTimestamp?: number;
}

export interface SubagentTextChunkData {
  sessionId: string;
  turnId: string;
  roundId: string;
  attemptId?: string;
  attemptIndex?: number;
  text: string;
  contentType: string;
  reasoningKind?: 'reasoning' | 'summary';
  isThinkingEnd?: boolean;
}

export interface SubagentToolEventData {
  sessionId: string;
  turnId: string;
  roundId: string;
  attemptId?: string;
  attemptIndex?: number;
  toolEvent: FlowToolEvent;
}

export type { SessionConfig, DialogTurn, ModelRound, FlowTextItem, FlowToolItem } from '../../types/flow-chat';
