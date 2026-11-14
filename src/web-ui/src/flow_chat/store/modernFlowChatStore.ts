/**
 * Modern FlowChat Store
 * High-performance state management using Zustand
 * Preserves original concept: Session → DialogTurn → ModelRound → FlowItem
 */

import { create, useStore } from 'zustand';
import { createContext, useContext } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, DialogTurn, ModelRound, ModelRoundAttempt, FlowThinkingItem, FlowUserSteeringItem, AnyFlowItem } from '../types/flow-chat';
import { flowChatStore } from './FlowChatStore';
import { getTurnCompletionNotice } from '../utils/turnCompletionNotice';
import { createAbsoluteSessionTurnIndexResolver } from '../utils/flowChatTurnOrdinal';
import { getTurnOutputDurationMs, getTurnTtftMs } from '../utils/turnUsageMetrics';
import { projectAdjacentFlowGroups, canStartFreshFlowGroupRunAt } from '../grouping/groupProjection';
import { hasModelRoundNarrative } from '../grouping/roundGroups';
import { isSuppressedBackgroundTurn } from '../utils/backgroundDelivery';

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

const mergedRoundDisplayCache = new WeakMap<ModelRound, WeakMap<ModelRound, ModelRound>>();

function mergeRoundGroupForDisplay(currentRound: ModelRound, nextRound: ModelRound): ModelRound {
  let byNext = mergedRoundDisplayCache.get(currentRound);
  const cached = byNext?.get(nextRound);
  if (cached) return cached;
  const merged = {
    ...nextRound,
    historyRounds: [
      ...(currentRound.historyRounds ?? []),
      {
        ...currentRound,
        historyRounds: undefined,
      },
    ],
  };
  if (!byNext) mergedRoundDisplayCache.set(currentRound, byNext = new WeakMap());
  byNext.set(nextRound, merged);
  return merged;
}

const normalizedRoundDisplayCache = new WeakMap<ModelRound, { ordinary?: ModelRound; continued?: ModelRound }>();

/** Immutable recorded rounds own both display variants, including retry repair. */
function normalizeRoundForDisplay(round: ModelRound, continuedAfterInterruption: boolean): ModelRound {
  let entry = normalizedRoundDisplayCache.get(round);
  const variant = continuedAfterInterruption ? 'continued' : 'ordinary';
  const cached = entry?.[variant];
  if (cached) return cached;
  const nonSteeringItems = round.items.filter(item => item.type !== 'user-steering');
  let normalized = nonSteeringItems.length === round.items.length ? round : { ...round, items: nonSteeringItems };
  // Older runtimes recorded a cancelled stream as a superseded retry.
  // Repair only that terminal attempt in the display projection.
  const lastAttempt = round.attempts?.reduce<ModelRoundAttempt | undefined>(
    (last, attempt) => !last || attempt.index > last.index ? attempt : last, undefined,
  );
  if (round.status === 'cancelled' && lastAttempt?.diagnostic?.category === 'stream_error'
    && lastAttempt.diagnostic.rawError?.startsWith('Cancelled: ')) {
    normalized = { ...normalized, attempts: round.attempts?.map(attempt => (
      attempt === lastAttempt ? { ...attempt, status: 'cancelled', diagnostic: undefined } : attempt
    )) };
  }
  if (continuedAfterInterruption) {
    normalized = { ...normalized, renderHints: { ...normalized.renderHints, continuedAfterInterruption: true } };
  }
  if (!entry) normalizedRoundDisplayCache.set(round, entry = {});
  entry[variant] = normalized;
  return normalized;
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

interface SessionProjectionCache {
  sessionId: Session['sessionId'];
  turnCatalogRef: Session['turnCatalog'] | undefined;
  isPartial: boolean | undefined;
  totalTurnCount: number | undefined;
  needsUserAttention: Session['needsUserAttention'];
  virtualItems: VirtualItem[];
}

// A retained projection stays reachable only while its source turn array does.
const retainedSessionProjections = new WeakMap<DialogTurn[], SessionProjectionCache>();

// Settled source Turns can be shared by live, history and side views without
// making any one view the owner of another view's streaming state or body.
type StableTurnPresentation = 'background' | 'normal';
const cachedTurnItems = new WeakMap<DialogTurn, Map<StableTurnPresentation, {
  items: VirtualItem[];
  absoluteTurnIndex: number;
}>>();

function rememberStableTurnItems(
  turn: DialogTurn,
  presentation: StableTurnPresentation,
  absoluteTurnIndex: number,
  items: VirtualItem[],
): void {
  let variants = cachedTurnItems.get(turn);
  if (!variants) cachedTurnItems.set(turn, variants = new Map());
  variants.set(presentation, { items, absoluteTurnIndex });
}

interface CachedTurnPrefixProjection {
  turnId: string;
  isTurnComplete: boolean;
  turnStartedAt: number;
  turnEndedAt: number | undefined;
  turnOutputDurationMs: number | undefined;
  turnTtftMs: number | undefined;
  turnTokenUsage: DialogTurn['tokenUsage'];
  rawItems: VirtualItem[];
  projectedItems: VirtualItem[];
}

function sameStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameFlowGroupData(
  a: import('../grouping/types').FlowGroupData | undefined,
  b: import('../grouping/types').FlowGroupData | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.groupId !== b.groupId ||
    a.category !== b.category ||
    a.isGroupStreaming !== b.isGroupStreaming ||
    a.phase !== b.phase ||
    a.needsAttention !== b.needsAttention ||
    a.isLastGroupInTurn !== b.isLastGroupInTurn ||
    a.wasCutByCritical !== b.wasCutByCritical ||
    a.allItems.length !== b.allItems.length ||
    a.rounds.length !== b.rounds.length ||
    !sameStringList(a.sourceGroupIds, b.sourceGroupIds)
  ) {
    return false;
  }
  for (let i = 0; i < a.allItems.length; i += 1) {
    if (a.allItems[i] !== b.allItems[i]) return false;
  }
  for (let i = 0; i < a.rounds.length; i += 1) {
    if (a.rounds[i] !== b.rounds[i]) return false;
  }
  return true;
}

function sameProjectedGroups(
  a: readonly import('../grouping/types').ModelRoundItemGroup[] | undefined,
  b: readonly import('../grouping/types').ModelRoundItemGroup[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ga = a[i];
    const gb = b[i];
    if (ga === gb) continue;
    if (ga.type !== gb.type) return false;
    if (ga.type === 'critical' && gb.type === 'critical') {
      if (ga.item !== gb.item) return false;
      continue;
    }
    if (ga.type !== 'critical' && gb.type !== 'critical') {
      if (
        ga.isLast !== gb.isLast ||
        ga.items.length !== gb.items.length ||
        !sameFlowGroupData(ga.projection, gb.projection)
      ) {
        return false;
      }
      for (let j = 0; j < ga.items.length; j += 1) {
        if (ga.items[j] !== gb.items[j]) return false;
      }
    }
  }
  return true;
}

function canReuseVirtualItem(prev: VirtualItem, next: VirtualItem): boolean {
  if (prev === next) return true;
  if (prev.type !== next.type || prev.turnId !== next.turnId) return false;
  switch (next.type) {
    case 'user-message': {
      const p = prev as typeof next;
      return (
        p.data === next.data &&
        p.absoluteTurnIndex === next.absoluteTurnIndex &&
        p.turnStatus === next.turnStatus &&
        p.submissionPhase === next.submissionPhase &&
        p.submissionError === next.submissionError &&
        p.hostQueueStatus === next.hostQueueStatus &&
        p.hostQueueAttachmentCount === next.hostQueueAttachmentCount
      );
    }
    case 'user-steering-message': {
      const p = prev as typeof next;
      return (
        p.steeringId === next.steeringId &&
        p.steeringStatus === next.steeringStatus &&
        p.data.id === next.data.id &&
        p.data.content === next.data.content &&
        p.data.timestamp === next.data.timestamp
      );
    }
    case 'model-round': {
      const p = prev as typeof next;
      return (
        p.data === next.data &&
        p.isLastRound === next.isLastRound &&
        p.isTurnComplete === next.isTurnComplete &&
        p.turnStartedAt === next.turnStartedAt &&
        p.turnEndedAt === next.turnEndedAt &&
        p.turnDurationMs === next.turnDurationMs &&
        p.turnOutputDurationMs === next.turnOutputDurationMs &&
        p.turnTtftMs === next.turnTtftMs &&
        p.turnTokenUsage === next.turnTokenUsage &&
        sameStringList(p.layoutHints?.expandedThinkingItemIds, next.layoutHints?.expandedThinkingItemIds) &&
        sameProjectedGroups(p.projectedGroups, next.projectedGroups)
      );
    }
    default:
      return false;
  }
}

function reconcileProjectedGroupsInPlace(
  prevGroups: readonly import('../grouping/types').ModelRoundItemGroup[] | undefined,
  nextGroups: import('../grouping/types').ModelRoundItemGroup[] | undefined,
): import('../grouping/types').ModelRoundItemGroup[] | undefined {
  if (!prevGroups || !nextGroups) return nextGroups;
  let allSame = prevGroups.length === nextGroups.length;
  const minLen = Math.min(prevGroups.length, nextGroups.length);
  for (let i = 0; i < minLen; i += 1) {
    const pg = prevGroups[i];
    const ng = nextGroups[i];
    if (pg === ng) continue;
    if (pg.type === ng.type) {
      if (pg.type === 'critical' && ng.type === 'critical') {
        if (pg.item === ng.item) {
          nextGroups[i] = pg;
          continue;
        }
      } else if (pg.type !== 'critical' && ng.type !== 'critical') {
        if (sameFlowGroupData(pg.projection, ng.projection)) {
          ng.projection = pg.projection;
        }
        if (
          pg.isLast === ng.isLast &&
          pg.items.length === ng.items.length &&
          pg.projection === ng.projection &&
          pg.items.every((item, idx) => item === ng.items[idx])
        ) {
          nextGroups[i] = pg;
          continue;
        }
      }
    }
    allSame = false;
  }
  return allSame ? (prevGroups as import('../grouping/types').ModelRoundItemGroup[]) : nextGroups;
}

function reconcileTurnVirtualItems(prevItems: VirtualItem[] | undefined, nextItems: VirtualItem[]): VirtualItem[] {
  if (!prevItems || prevItems.length === 0) {
    return nextItems;
  }
  for (let i = 0; i < nextItems.length; i += 1) {
    const candidate = prevItems[i];
    if (candidate && canReuseVirtualItem(candidate, nextItems[i])) {
      nextItems[i] = candidate;
    } else if (nextItems[i].type === 'model-round' && candidate?.type === 'model-round') {
      const prevRound = candidate;
      const nextRound = nextItems[i] as typeof prevRound;
      nextRound.projectedGroups = reconcileProjectedGroupsInPlace(
        prevRound.projectedGroups,
        nextRound.projectedGroups,
      );
    }
  }
  return nextItems;
}

function projectTurnItemsWithPrefixCache(
  turn: DialogTurn,
  rawTurnItems: VirtualItem[],
  isTurnComplete: boolean,
  turnOutputDurationMs: number | undefined,
  turnTtftMs: number | undefined,
  cachedTurnPrefixById: Map<string, CachedTurnPrefixProjection>,
): VirtualItem[] {
  const prev = cachedTurnPrefixById.get(turn.id);
  let reuseCount = 0;

  if (
    prev &&
    prev.isTurnComplete === isTurnComplete &&
    prev.turnStartedAt === turn.startTime &&
    prev.turnEndedAt === turn.endTime &&
    prev.turnOutputDurationMs === turnOutputDurationMs &&
    prev.turnTtftMs === turnTtftMs &&
    prev.turnTokenUsage === turn.tokenUsage &&
    prev.rawItems.length === prev.projectedItems.length
  ) {
    const limit = Math.min(prev.rawItems.length, rawTurnItems.length) - 1;
    let commonLen = 0;
    while (
      commonLen < limit &&
      canReuseVirtualItem(prev.rawItems[commonLen], rawTurnItems[commonLen])
    ) {
      commonLen += 1;
    }
    for (let k = commonLen - 1; k >= 2; k -= 1) {
      if (canStartFreshFlowGroupRunAt(rawTurnItems[k - 1], rawTurnItems[k])) {
        reuseCount = k;
        break;
      }
    }
  }

  const projectedTurnItems = reuseCount > 1 && prev
    ? [
        prev.projectedItems[0],
        ...prev.projectedItems.slice(1, reuseCount),
        ...projectAdjacentFlowGroups(rawTurnItems.slice(reuseCount), { isTurnComplete }),
      ]
    : projectAdjacentFlowGroups(rawTurnItems, { isTurnComplete });

  const reconciled = reconcileTurnVirtualItems(prev?.projectedItems, projectedTurnItems);
  cachedTurnPrefixById.set(turn.id, {
    turnId: turn.id,
    isTurnComplete,
    turnStartedAt: turn.startTime,
    turnEndedAt: turn.endTime,
    turnOutputDurationMs,
    turnTtftMs,
    turnTokenUsage: turn.tokenUsage,
    rawItems: rawTurnItems,
    projectedItems: reconciled,
  });
  return reconciled;
}

/** Each mounted projection owns its mutable streaming prefix. */
export function createSessionVirtualItemProjector(
  { reuseSnapshotsAcrossMounts = false }: { reuseSnapshotsAcrossMounts?: boolean } = {},
): (session: Session | null) => VirtualItem[] {
  let sessionId: string | null = null;
  let previousProjection: SessionProjectionCache | undefined;
  let warmProjections = reuseSnapshotsAcrossMounts
    ? retainedSessionProjections
    : new WeakMap<DialogTurn[], SessionProjectionCache>();
  const cachedTurnPrefixById = new Map<string, CachedTurnPrefixProjection>();
  const emptyItems: VirtualItem[] = [];

  return (session: Session | null): VirtualItem[] => {
    if (!session) {
      sessionId = null;
      previousProjection = undefined;
      if (!reuseSnapshotsAcrossMounts) warmProjections = new WeakMap();
      cachedTurnPrefixById.clear();
      return emptyItems;
    }
    if (sessionId !== session.sessionId) cachedTurnPrefixById.clear();
    sessionId = session.sessionId;
    const restored = warmProjections.get(session.dialogTurns);
    if (restored
      && restored.sessionId === session.sessionId
      && restored.turnCatalogRef === session.turnCatalog
      && restored.isPartial === session.isPartial
      && restored.totalTurnCount === session.totalTurnCount
      && restored.needsUserAttention === session.needsUserAttention) {
      // Returning to another snapshot must release the previous window's body.
      if (restored !== previousProjection) cachedTurnPrefixById.clear();
      previousProjection = restored;
      return restored.virtualItems;
    }

    // Paging and rollback can discard Turns while this same view stays mounted.
    const turnIds = new Set(session.dialogTurns.map(turn => turn.id));
    for (const turnId of cachedTurnPrefixById.keys()) {
      if (!turnIds.has(turnId)) cachedTurnPrefixById.delete(turnId);
    }

    const items = projectSessionItems(session, cachedTurnPrefixById);
    const projection = {
      sessionId: session.sessionId,
      turnCatalogRef: session.turnCatalog,
      isPartial: session.isPartial,
      totalTurnCount: session.totalTurnCount,
      needsUserAttention: session.needsUserAttention,
      virtualItems: items,
    };
    warmProjections.set(session.dialogTurns, projection);
    previousProjection = projection;
    return items;
  };
}

function projectSessionItems(
  session: Session,
  cachedTurnPrefixById: Map<string, CachedTurnPrefixProjection>,
): VirtualItem[] {
  const items: VirtualItem[] = [];
  const resolveAbsoluteTurnIndex = createAbsoluteSessionTurnIndexResolver(session);

  session.dialogTurns.forEach((turn, turnIndex) => {
    const absoluteTurnIndex = resolveAbsoluteTurnIndex(turnIndex);
    const backgroundCollapsed = isSuppressedBackgroundTurn(turn) && !session.needsUserAttention;
    const presentation = backgroundCollapsed ? 'background' : 'normal';
    const cachedItems = cachedTurnItems.get(turn)?.get(presentation);
    if (cachedItems?.absoluteTurnIndex === absoluteTurnIndex) {
      cachedTurnPrefixById.delete(turn.id);
      items.push(...cachedItems.items);
      return;
    }
    if (backgroundCollapsed) {
      cachedTurnPrefixById.delete(turn.id);
      const backgroundItems: VirtualItem[] = [{ type: 'background-run', data: turn.userMessage, turn, turnId: turn.id, absoluteTurnIndex, turnStatus: turn.status }];
      items.push(...backgroundItems);
      if (isStableTurnProjection(turn)) rememberStableTurnItems(turn, presentation, absoluteTurnIndex, backgroundItems);
      return;
    }
    const turnItemStart = items.length;

    // Host rendering evidence drives a repair turn but is not a user utterance.
    // Keep its model output while omitting the input row (and its spacing).
    if (turn.userMessage && !turn.userMessage.metadata?.genUIHostRepair) {
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
      const normalizedRound = normalizeRoundForDisplay(round, continuedAfterInterruption);
      if (normalizedRound.items.length > 0) {
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
    const turnOutputDurationMs = getTurnOutputDurationMs(turn.modelRounds);
    const turnTtftMs = getTurnTtftMs(turn.modelRounds);
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
          turnOutputDurationMs,
          turnTtftMs,
          turnTokenUsage: turn.tokenUsage,
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

    const projectedTurnItems = projectTurnItemsWithPrefixCache(
      turn,
      items.slice(turnItemStart),
      isTurnComplete,
      turnOutputDurationMs,
      turnTtftMs,
      cachedTurnPrefixById,
    );
    items.splice(turnItemStart, items.length - turnItemStart, ...projectedTurnItems);

    if (isStableTurnProjection(turn)) {
      cachedTurnPrefixById.delete(turn.id);
      rememberStableTurnItems(turn, presentation, absoluteTurnIndex, projectedTurnItems);
    }
  });

  return items;
}

function getInitialModernState(projectSession: ReturnType<typeof createSessionVirtualItemProjector>): Pick<
  ModernFlowChatState,
  'activeSession' | 'virtualItems' | 'visibleTurnInfo'
> {
  const legacyState = flowChatStore.getState();
  const activeSession = legacyState.activeSessionId
    ? legacyState.sessions.get(legacyState.activeSessionId) ?? null
    : null;

  return {
    activeSession,
    virtualItems: projectSession(activeSession),
    visibleTurnInfo: null,
  };
}

export const createModernFlowChatStore = (initialSession?: Session | null) => {
  const projectSession = createSessionVirtualItemProjector();
  return create<ModernFlowChatState>()(
    (set, get) => ({
      ...(initialSession === undefined ? getInitialModernState(projectSession) : {
        activeSession: initialSession,
        virtualItems: projectSession(initialSession),
        visibleTurnInfo: null,
      }),

      setActiveSession: (session) => {
        const items = projectSession(session);
        set((state) => ({
          ...(state.activeSession?.sessionId !== session?.sessionId ? { visibleTurnInfo: null } : null),
          activeSession: session,
          virtualItems: items,
        }));
      },

      updateVirtualItems: () => {
        const session = get().activeSession;
        const items = projectSession(session);

        set((state) => ({
          ...state,
          virtualItems: items,
        }));
      },

      setVisibleTurnInfo: (info) => {
        set((state) => ({
          ...state,
          visibleTurnInfo: info,
        }));
      },

      clear: () => {
        projectSession(null);

        set((state) => ({
          ...state,
          activeSession: null,
          virtualItems: [],
          visibleTurnInfo: null,
        }));
      },
    })
  );
};

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
