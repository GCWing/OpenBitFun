/**
 * Modern FlowChat Store
 * High-performance state management using Zustand + Immer
 * Preserves original concept: Session → DialogTurn → ModelRound → FlowItem
 */

import { create, useStore } from 'zustand';
import { createContext, useContext } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { immer } from 'zustand/middleware/immer';
import type { Session, DialogTurn, ModelRound, ModelRoundAttempt, FlowItem, FlowThinkingItem, FlowToolItem, FlowUserSteeringItem, AnyFlowItem, TokenUsage } from '../types/flow-chat';
import {
  isCollapsibleTool,
  READ_TOOL_NAMES,
  SEARCH_TOOL_NAMES,
  COMMAND_TOOL_NAMES,
} from '../tool-cards/toolCardMetadata';
import { flowChatStore } from './FlowChatStore';
import { getEffectiveToolName } from '../utils/toolInvocationIdentity';
import {
  getTurnCompletionNotice,
  type TurnCompletionNotice,
} from '../utils/turnCompletionNotice';
import { createAbsoluteSessionTurnIndexResolver } from '../utils/flowChatTurnOrdinal';
import { parseDeepResearchContent } from '../deep-research/deepResearchProtocol';
import { collectCanvasArtifactToolItems } from '../utils/canvasArtifactPresentation';

/**
 * Explore group statistics (merged computed stats)
 */
export interface ExploreGroupStats {
  readCount: number;
  searchCount: number;
  commandCount: number;
}

/**
 * Explore group data (for explore-group type VirtualItem)
 * Merges consecutive explore-only rounds into a single render unit
 */
export interface ExploreGroupData {
  groupId: string;
  rounds: ModelRound[];
  allItems: FlowItem[];
  stats: ExploreGroupStats;
  isGroupStreaming: boolean;
  isLastGroupInTurn: boolean;
  /**
   * True when this group is no longer the tail of the turn. Expansion no
   * longer depends on this flag; it is retained for bounded tail presentation
   * and projection diagnostics.
   */
  wasCutByCritical: boolean;
}

/**
 * Virtualized render unit
 * Used for virtual scrolling, flattens DialogTurn into renderable items
 */
export type VirtualItem =
  | {
      type: 'user-message';
      data: DialogTurn['userMessage'];
      turnId: string;
      absoluteTurnIndex?: number;
      turnStatus?: DialogTurn['status'];
    }
  | {
      type: 'user-steering-message';
      data: NonNullable<DialogTurn['userMessage']>;
      turnId: string;
      steeringId: string;
      steeringStatus: FlowUserSteeringItem['status'];
    }
  | {
      type: 'model-round';
      data: ModelRound;
      turnId: string;
      isLastRound: boolean;
      isTurnComplete: boolean;
      layoutHints?: {
        expandedThinkingItemIds: string[];
      };
      turnStartedAt?: number;
      turnEndedAt?: number;
      turnDurationMs?: number;
      turnTokenUsage?: TokenUsage;
      canvasArtifactItems?: FlowToolItem[];
    }
  | { type: 'explore-group'; data: ExploreGroupData; turnId: string }
  | { type: 'turn-completion-notice'; data: TurnCompletionNotice; turnId: string }
  | {
      type: 'turn-failure-notice';
      data: {
        error: string;
        errorDetail?: DialogTurn['errorDetail'];
      };
      turnId: string;
    }
  | { type: 'image-analyzing'; turnId: string };

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

/**
 * Check if ModelRound is explore-only (contains only exploration tools)
 * Explore-only rounds can be collapsed
 * 
 * Key check: the round must be fully settled and contain at least one
 * collapsible tool. Active rounds stay as ordinary model-round items so a
 * running tool is never hidden inside a collapsed explore group.
 * Pure text rounds (like final replies) should not be collapsed.
 */
function hasTrailingVisibleText(round: ModelRound): boolean {
  for (let index = round.items.length - 1; index >= 0; index -= 1) {
    const item = round.items[index];
    if (!item || item.type === 'user-steering') {
      continue;
    }

    if (item.type !== 'text') {
      return false;
    }

    return typeof item.content === 'string' && item.content.trim().length > 0;
  }

  return false;
}

function isExploreOnlyRound(round: ModelRound): boolean {
  if (!round.items || round.items.length === 0) return false;

  if (
    !isTerminalRoundStatus(round.status) ||
    round.isStreaming ||
    !round.isComplete ||
    round.items.some(isActiveFlowItem)
  ) {
    return false;
  }

  if (round.renderHints?.disableExploreGrouping === true || round.renderHints?.continuedAfterInterruption) {
    return false;
  }

  if (hasTrailingVisibleText(round)) {
    return false;
  }

  // Deep Research markers are user-visible progress, not narrative attached to
  // an exploration tool. Keep their round stable and outside collapsed explore
  // groups after the tool settles. Check this after trailing text so ordinary
  // final responses stay on the existing constant-time path.
  if (round.items.some(item => (
    item.type === 'text' && parseDeepResearchContent(item.content).hasProtocol
  ))) {
    return false;
  }
  
  const hasCollapsibleTool = round.items.some(item => 
    item.type === 'tool' && isCollapsibleTool(getEffectiveToolName(item as FlowToolItem))
  );
  
  const hasAnyTool = round.items.some(item => item.type === 'tool');
  if (!hasAnyTool) return false;
  
  if (!hasCollapsibleTool) return false;
  
  const allItemsCollapsible = round.items.every(item => {
    if (item.type === 'tool') {
      return isCollapsibleTool(getEffectiveToolName(item as FlowToolItem));
    }
    return item.type === 'text' || item.type === 'thinking';
  });
  
  return allItemsCollapsible;
}

/**
 * Compute statistics for a single ModelRound
 */
function computeRoundStats(round: ModelRound): ExploreGroupStats {
  let readCount = 0;
  let searchCount = 0;
  let commandCount = 0;
  
  for (const item of round.items) {
    if (item.type === 'tool') {
      const toolName = getEffectiveToolName(item as FlowToolItem);
      if (READ_TOOL_NAMES.has(toolName)) readCount++;
      else if (SEARCH_TOOL_NAMES.has(toolName)) searchCount++;
      else if (COMMAND_TOOL_NAMES.has(toolName)) commandCount++;
    }
  }
  
  return { readCount, searchCount, commandCount };
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
 * Explore group merging: consecutive explore-only rounds merged into single explore-group VirtualItem
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
      cachedItems.absoluteTurnIndex === absoluteTurnIndex &&
      isStableTurnProjection(turn)
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
        entry.type === 'round' && !isExploreOnlyRound(entry.round)
      ))
      ?.round.id;

    const flushRoundEntries = (
      rounds: ModelRound[],
      options: { collapseTrailingExploreGroup: boolean },
    ) => {
      if (rounds.length === 0) return;

      interface TempExploreGroup {
        rounds: ModelRound[];
        allItems: FlowItem[];
        readCount: number;
        searchCount: number;
        commandCount: number;
        startIndex: number;
        endIndex: number;
      }

      const tempGroups: TempExploreGroup[] = [];
      let currentGroup: TempExploreGroup | null = null;

      rounds.forEach((round, index) => {
        const exploreOnly = isExploreOnlyRound(round);
        if (exploreOnly) {
          const stats = computeRoundStats(round);
          if (currentGroup) {
            currentGroup.rounds.push(round);
            currentGroup.allItems.push(...round.items);
            currentGroup.readCount += stats.readCount;
            currentGroup.searchCount += stats.searchCount;
            currentGroup.commandCount += stats.commandCount;
            currentGroup.endIndex = index;
          } else {
            currentGroup = {
              rounds: [round],
              allItems: [...round.items],
              readCount: stats.readCount,
              searchCount: stats.searchCount,
              commandCount: stats.commandCount,
              startIndex: index,
              endIndex: index,
            };
          }
        } else {
          if (currentGroup) {
            tempGroups.push(currentGroup);
            currentGroup = null;
          }
        }
      });

      // Flush the trailing settled explore group. Active rounds never enter a
      // group and remain visible as ordinary model-round items until terminal.
      if (currentGroup) {
        tempGroups.push(currentGroup);
      }

      let roundIndex = 0;
      let groupIndex = 0;

      while (roundIndex < rounds.length) {
        const round = rounds[roundIndex];
        const group = tempGroups[groupIndex];

        if (group && group.startIndex === roundIndex) {
          const isLastGroupInTurn =
            group.endIndex === rounds.length - 1 &&
            !options.collapseTrailingExploreGroup;
          const isGroupStreaming = group.rounds.some(
            r => r.isStreaming || r.items.some(isActiveFlowItem),
          );
          const wasCutByCritical =
            group.endIndex < rounds.length - 1 ||
            options.collapseTrailingExploreGroup;

          const groupId = group.rounds[0]?.id ?? `explore-group-${turn.id}-${group.startIndex}`;

          items.push({
            type: 'explore-group',
            turnId: turn.id,
            data: {
              groupId,
              rounds: group.rounds,
              allItems: group.allItems,
              stats: {
                readCount: group.readCount,
                searchCount: group.searchCount,
                commandCount: group.commandCount,
              },
              isGroupStreaming,
              isLastGroupInTurn,
              wasCutByCritical,
            },
          });

          roundIndex = group.endIndex + 1;
          groupIndex++;
        } else {
          // One round is always exactly one virtual item. Splitting a completed
          // round into segments swaps a single virtual-item key for N new keys,
          // which remounts the visible assistant message and flashes the pane.
          const trailingItem = round.items.at(-1);
          const shouldExpandTrailingThinking = roundIndex === rounds.length - 1
            && trailingItem?.type === 'thinking'
            && (trailingItem as FlowThinkingItem).reasoningKind !== 'summary';
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
          roundIndex++;
        }
      }
    };

    const completionNotice = getTurnCompletionNotice(turn);
    const hasFailureNotice = turn.status === 'error' && Boolean(turn.error || turn.errorDetail);
    let pendingRounds: ModelRound[] = [];

    renderEntries.forEach(entry => {
      if (entry.type === 'round') {
        pendingRounds.push(entry.round);
        return;
      }

      flushRoundEntries(pendingRounds, { collapseTrailingExploreGroup: true });
      pendingRounds = [];

      items.push({
        type: 'user-steering-message',
        data: steeringItemToUserMessage(entry.item),
        turnId: turn.id,
        steeringId: entry.item.steeringId,
        steeringStatus: entry.item.status,
      });
    });

    flushRoundEntries(pendingRounds, {
      collapseTrailingExploreGroup:
        hasNewerDialogTurn ||
        completionNotice !== null ||
        hasFailureNotice,
    });

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
