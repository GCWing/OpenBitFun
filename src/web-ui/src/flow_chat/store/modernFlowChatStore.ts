/**
 * Modern FlowChat Store
 * High-performance state management using Zustand + Immer
 * Preserves original concept: Session → DialogTurn → ModelRound → FlowItem
 */

import { create, useStore } from 'zustand';
import { createContext, useContext } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { immer } from 'zustand/middleware/immer';
import type { Session, DialogTurn, ModelRound, ModelRoundAttempt, FlowThinkingItem, FlowUserSteeringItem, AnyFlowItem } from '../types/flow-chat';
import { flowChatStore } from './FlowChatStore';
import { getTurnCompletionNotice } from '../utils/turnCompletionNotice';
import { createAbsoluteSessionTurnIndexResolver } from '../utils/flowChatTurnOrdinal';
import { collectCanvasArtifactToolItems } from '../utils/canvasArtifactPresentation';
import { projectAdjacentFlowGroups } from '../grouping/groupProjection';
import { hasModelRoundNarrative } from '../grouping/roundGroups';

import type { VirtualItem } from '../types/flow-chat-projection';
export type { VirtualItem } from '../types/flow-chat-projection';
export type { ExploreGroupStats, ToolGroupData, ExploreGroupData, ContextLoadGroupData, CollapsibleToolGroupData } from '../grouping/types';

/**
 * Currently visible turn information
 */
export interface VisibleTurnInfo {
  turnIndex: number;
  totalTurns: number;
  userMessage: string;
  turnId: string;
  visibleTurnIds: string[];
}

export interface ModernFlowChatState {
  activeSession: Session | null;
  virtualItems: VirtualItem[];
  visibleTurnInfo: VisibleTurnInfo | null;

  setActiveSession: (session: Session | null) => void;
  updateVirtualItems: () => void;
  setVisibleTurnInfo: (info: VisibleTurnInfo | null) => void;
  clear: () => void;
}

function steeringItemToUserMessage(item: FlowUserSteeringItem): NonNullable<DialogTurn['userMessage']> {
  return {
    id: `user_steering_${item.steeringId}`,
    content: item.content,
    timestamp: item.timestamp,
  };
}

function mergeRoundGroupForDisplay(currentRound: ModelRound, nextRound: ModelRound): ModelRound {
  return {
    ...nextRound,
    historyRounds: [
      ...(currentRound.historyRounds ?? []),
      {
        ...currentRound,
        historyRounds: undefined,
      },
    ],
  };
}

function isTerminalTurnStatus(status: DialogTurn['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error';
}

function isTerminalRoundStatus(status: ModelRound['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'rejected' || status === 'error';
}

function isActiveFlowItem(item: AnyFlowItem): boolean {
  if (
    item.status === 'pending' ||
    item.status === 'preparing' ||
    item.status === 'running' ||
    item.status === 'streaming' ||
    item.status === 'receiving' ||
    item.status === 'analyzing' ||
    item.status === 'pending_confirmation'
  ) {
    return true;
  }

  if (item.type === 'text' || item.type === 'thinking') {
    return item.isStreaming;
  }

  if (item.type === 'tool') {
    return item.isParamsStreaming === true;
  }

  return false;
}

function isStableTurnProjection(turn: DialogTurn): boolean {
  if (!isTerminalTurnStatus(turn.status)) {
    return false;
  }

  return turn.modelRounds.every(round =>
    isTerminalRoundStatus(round.status) &&
    !round.isStreaming &&
    round.isComplete !== false &&
    round.items.every(item => !isActiveFlowItem(item))
  );
}

let cachedSession: Session | null = null;
let cachedDialogTurnsRef: DialogTurn[] | null = null;
let cachedTurnCatalogRef: Session['turnCatalog'] | undefined;
let cachedIsPartial: boolean | undefined;
let cachedTotalTurnCount: number | undefined;
let cachedVirtualItems: VirtualItem[] = [];
let cachedTurnItems = new WeakMap<
  DialogTurn,
  { items: VirtualItem[]; hasNewerDialogTurn: boolean; absoluteTurnIndex: number }
>();

/**
 * Convert Session to virtualized render items
 *
 * Performance optimizations:
 * 1. Uses references directly, relies on FlowChatStore immutable updates to detect reference changes
 * 2. Memoization cache: only recalculates when dialogTurns reference changes
 * 
 * Stable model-round rows host category groups from first execution through completion.
 */
export function sessionToVirtualItems(session: Session | null): VirtualItem[] {
  if (!session) {
    if (cachedSession !== null) {
      cachedSession = null;
      cachedDialogTurnsRef = null;
      cachedTurnCatalogRef = undefined;
      cachedIsPartial = undefined;
      cachedTotalTurnCount = undefined;
      cachedVirtualItems = [];
      cachedTurnItems = new WeakMap();
    }
    return cachedVirtualItems;
  }
  
  if (
    cachedSession?.sessionId === session.sessionId && 
    cachedDialogTurnsRef === session.dialogTurns &&
    cachedTurnCatalogRef === session.turnCatalog &&
    cachedIsPartial === session.isPartial &&
    cachedTotalTurnCount === session.totalTurnCount
  ) {
    return cachedVirtualItems;
  }
  
  cachedSession = session;
  cachedDialogTurnsRef = session.dialogTurns;
  cachedTurnCatalogRef = session.turnCatalog;
  cachedIsPartial = session.isPartial;
  cachedTotalTurnCount = session.totalTurnCount;

  const items: VirtualItem[] = [];
  const resolveAbsoluteTurnIndex = createAbsoluteSessionTurnIndexResolver(session);

  session.dialogTurns.forEach((turn, turnIndex) => {
    const hasNewerDialogTurn = turnIndex < session.dialogTurns.length - 1;
    const absoluteTurnIndex = resolveAbsoluteTurnIndex(turnIndex);
    const cachedItems = cachedTurnItems.get(turn);
    if (
      cachedItems &&
      cachedItems.hasNewerDialogTurn === hasNewerDialogTurn &&
      cachedItems.absoluteTurnIndex === absoluteTurnIndex
    ) {
      items.push(...cachedItems.items);
      return;
    }
    const turnItemStart = items.length;

    if (turn.userMessage) {
      items.push({
        type: 'user-message',
        data: turn.userMessage,
        turnId: turn.id,
        absoluteTurnIndex,
        turnStatus: turn.status,
      });
    }

    if (turn.status === 'image_analyzing' && turn.modelRounds.length === 0) {
      items.push({ type: 'image-analyzing', turnId: turn.id });
      return;
    }

    const renderEntries: Array<
      | { type: 'round'; round: ModelRound }
      | { type: 'steering'; item: FlowUserSteeringItem }
    > = [];

    let continuationPending = false;
    const hasRecovery = (turn.recoveryEpoch ?? turn.recovery?.executionGeneration ?? 0) > 0;
    turn.modelRounds.forEach(round => {
      const continuedAfterInterruption = hasRecovery && continuationPending;
      continuationPending ||= round.status === 'cancelled';
      if (!round.items || round.items.length === 0) return;
      const nonSteeringItems = round.items.filter(item => item.type !== 'user-steering');
      if (nonSteeringItems.length > 0) {
        let normalizedRound = nonSteeringItems.length === round.items.length
          ? round
          : { ...round, items: nonSteeringItems };
        // Older runtimes recorded a cancelled stream as a superseded retry.
        // Repair only that terminal attempt in the display projection.
        const lastAttempt = round.attempts?.reduce<ModelRoundAttempt | undefined>(
          (last, attempt) => !last || attempt.index > last.index ? attempt : last, undefined,
        );
        if (round.status === 'cancelled' && lastAttempt?.diagnostic?.category === 'stream_error'
          && lastAttempt.diagnostic.rawError?.startsWith('Cancelled: ')) {
          normalizedRound = { ...normalizedRound, attempts: round.attempts?.map(attempt => (
            attempt === lastAttempt ? { ...attempt, status: 'cancelled', diagnostic: undefined } : attempt
          )) };
        }
        if (continuedAfterInterruption) {
          normalizedRound = { ...normalizedRound, renderHints: {
            ...normalizedRound.renderHints, continuedAfterInterruption: true,
          } };
        }
        continuationPending = round.status === 'cancelled';
        const lastRenderEntry = renderEntries[renderEntries.length - 1];

        if (
          normalizedRound.roundGroupId &&
          !continuedAfterInterruption &&
          lastRenderEntry?.type === 'round' &&
          !lastRenderEntry.round.renderHints?.continuedAfterInterruption &&
          // A shared group id alone does not make earlier successful prose a
          // superseded retry. Preserve its original place in the transcript.
          (lastRenderEntry.round.status === 'error' || !hasModelRoundNarrative(lastRenderEntry.round)) &&
          lastRenderEntry.round.roundGroupId === normalizedRound.roundGroupId
        ) {
          lastRenderEntry.round = mergeRoundGroupForDisplay(lastRenderEntry.round, normalizedRound);
        } else {
          renderEntries.push({
            type: 'round',
            round: normalizedRound,
          });
        }
      }
      round.items
        .filter((item): item is FlowUserSteeringItem => item.type === 'user-steering')
        .forEach(item => {
          renderEntries.push({ type: 'steering', item });
        });
    });
    
    const isTurnComplete = turn.status === 'completed' || turn.status === 'cancelled' || turn.status === 'error';
    const canvasArtifactItems = collectCanvasArtifactToolItems(turn.modelRounds);
    const canvasAttachmentHostRoundId = [...renderEntries]
      .reverse()
      .find((entry): entry is Extract<(typeof renderEntries)[number], { type: 'round' }> => (
        entry.type === 'round'
      ))
      ?.round.id;

    const flushRoundEntries = (rounds: ModelRound[]) => {
      rounds.forEach((round, roundIndex) => {
        // Keep the same owner row when a tool or model round completes.
        const trailingItem = round.items.at(-1);
        const shouldExpandTrailingThinking = roundIndex === rounds.length - 1
          && trailingItem?.type === 'thinking'
          && (trailingItem as FlowThinkingItem).reasoningKind !== 'summary'
          && ((trailingItem as FlowThinkingItem).isStreaming || trailingItem.status === 'streaming');
        items.push({
          type: 'model-round',
          data: round,
          turnId: turn.id,
          isLastRound: roundIndex === rounds.length - 1,
          isTurnComplete,
          layoutHints: {
            expandedThinkingItemIds: shouldExpandTrailingThinking
              ? [trailingItem.id]
              : [],
          },
          turnStartedAt: turn.startTime,
          turnEndedAt: turn.endTime,
          turnDurationMs: typeof turn.endTime === 'number'
            ? Math.max(0, turn.endTime - turn.startTime)
            : undefined,
          turnTokenUsage: turn.tokenUsage,
          canvasArtifactItems: isTurnComplete && round.id === canvasAttachmentHostRoundId
            ? canvasArtifactItems
            : undefined,
        });
      });
    };

    const completionNotice = getTurnCompletionNotice(turn);
    const hasFailureNotice = turn.status === 'error' && Boolean(turn.error || turn.errorDetail);
    let pendingRounds: ModelRound[] = [];

    renderEntries.forEach(entry => {
      if (entry.type === 'round') {
        pendingRounds.push(entry.round);
        return;
      }

      flushRoundEntries(pendingRounds);
      pendingRounds = [];

      items.push({
        type: 'user-steering-message',
        data: steeringItemToUserMessage(entry.item),
        turnId: turn.id,
        steeringId: entry.item.steeringId,
        steeringStatus: entry.item.status,
      });
    });

    flushRoundEntries(pendingRounds);

    if (completionNotice) {
      items.push({
        type: 'turn-completion-notice',
        turnId: turn.id,
        data: completionNotice,
      });
    }

    if (hasFailureNotice) {
      items.push({
        type: 'turn-failure-notice',
        turnId: turn.id,
        data: {
          error: turn.error ?? turn.errorDetail?.providerMessage ?? '',
          errorDetail: turn.errorDetail,
        },
      });
    }

    const projectedTurnItems = projectAdjacentFlowGroups(items.slice(turnItemStart), { isTurnComplete });
    items.splice(turnItemStart, items.length - turnItemStart, ...projectedTurnItems);

    if (isStableTurnProjection(turn)) {
      cachedTurnItems.set(turn, {
        items: items.slice(turnItemStart),
        hasNewerDialogTurn,
        absoluteTurnIndex,
      });
    }
  });

  cachedVirtualItems = items;
  return items;
}

function getInitialModernState(): Pick<
  ModernFlowChatState,
  'activeSession' | 'virtualItems' | 'visibleTurnInfo'
> {
  const legacyState = flowChatStore.getState();
  const activeSession = legacyState.activeSessionId
    ? legacyState.sessions.get(legacyState.activeSessionId) ?? null
    : null;

  return {
    activeSession,
    virtualItems: sessionToVirtualItems(activeSession),
    visibleTurnInfo: null,
  };
}

export const createModernFlowChatStore = (initialSession?: Session | null) => create<ModernFlowChatState>()(
  immer((set, get) => ({
    ...(initialSession === undefined ? getInitialModernState() : {
      activeSession: initialSession,
      virtualItems: sessionToVirtualItems(initialSession),
      visibleTurnInfo: null,
    }),

    setActiveSession: (session) => {
      const items = sessionToVirtualItems(session);
      set((state) => {
        if (state.activeSession?.sessionId !== session?.sessionId) {
          state.visibleTurnInfo = null;
        }
        state.activeSession = session;
        state.virtualItems = items;
      });
    },

    updateVirtualItems: () => {
      const session = get().activeSession;
      const items = sessionToVirtualItems(session);
      
      set((state) => {
        state.virtualItems = items;
      });
    },

    setVisibleTurnInfo: (info) => {
      set((state) => {
        state.visibleTurnInfo = info;
      });
    },

    clear: () => {
      cachedSession = null;
      cachedDialogTurnsRef = null;
      cachedTurnCatalogRef = undefined;
      cachedIsPartial = undefined;
      cachedTotalTurnCount = undefined;
      cachedVirtualItems = [];
      cachedTurnItems = new WeakMap();

      set((state) => {
        state.activeSession = null;
        state.virtualItems = [];
        state.visibleTurnInfo = null;
      });
    },
  }))
);

const defaultModernFlowChatStore = createModernFlowChatStore();
export const ModernFlowChatStoreContext = createContext<ReturnType<typeof createModernFlowChatStore> | null>(null);
export const useModernFlowChatStoreApi = () => useContext(ModernFlowChatStoreContext) ?? defaultModernFlowChatStore;
export const useModernFlowChatStore = Object.assign(
  function useScopedModernFlowChatStore<T>(selector: (state: ModernFlowChatState) => T): T {
    return useStore(useModernFlowChatStoreApi(), selector);
  },
  defaultModernFlowChatStore,
);

export const useVirtualItems = () =>
  useModernFlowChatStore(state => state.virtualItems);

export const useActiveSession = () =>
  useModernFlowChatStore(state => state.activeSession);

export const useVisibleTurnInfo = () =>
  useModernFlowChatStore(state => state.visibleTurnInfo);

/**
 * Get actions (does not trigger re-render)
 */
export const useFlowChatActions = () =>
  useModernFlowChatStore(useShallow(state => ({
    setActiveSession: state.setActiveSession,
    updateVirtualItems: state.updateVirtualItems,
    setVisibleTurnInfo: state.setVisibleTurnInfo,
    clear: state.clear,
  })));
