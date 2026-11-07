/**
 * Long-round FlowChat performance harness.
 *
 * Categorized into 5 focused benchmark suites so each optimization area can be
 * measured, verified, and regressed independently:
 *
 * - Category 1 (`benchStoreProjection`): Store & Adjacent Group Projection
 *   (`sessionToVirtualItems` + `projectAdjacentFlowGroups`, reference stability of `VirtualItem`s)
 * - Category 2 (`benchTimelineDocument`): Timeline Document & Rhythm Pass
 *   (`ConversationDocumentProjection.project` + `getNextVisibleVirtualItemIndexes`, `TimelineBlock` reference stability)
 * - Category 3 (`benchGroupStateAndSearch`): Container Derived Passes
 *   (`indexFlowGroups`, `captureFlowGroupFeedbackSnapshot`, `collectFlowGroupReceiveFeedback`, `buildFlowChatSearchMatches`)
 * - Category 4 (`benchBackgroundBudgetAndPersistence`): Background Budget & Persistence Overhead
 *   (`estimateRetainedBytes` full-turn object walk, `calculateTurnHash` JSON serialization)
 * - Category 5 (in `longRoundPerfHarness.test.tsx`): React Framework & Virtualizer DOM Interaction
 *   (Streaming tail updates vs viewport scroll windowing)
 */

import { createSessionVirtualItemProjector, sessionToVirtualItems, type VirtualItem } from '../store/modernFlowChatStore';
import { indexFlowGroups, getVirtualItemFlowGroups } from '../grouping/selectors';
import {
  captureFlowGroupFeedbackSnapshot,
  collectFlowGroupReceiveFeedback,
} from '../grouping/receiveFeedback';
import { ConversationDocumentProjection, type TimelineProjectionOptions } from '../timeline/document';
import { FlowChatReaderState } from '../timeline/readerState';
import { getNextVisibleVirtualItemIndexes } from '../components/modern/flowChatRhythm';
import { createFlowChatSearchMatcher } from '../components/modern/useFlowChatSearch';
import { calculateTurnHash } from '../services/flow-chat-manager/PersistenceModule';
import { estimateRetainedBytes } from '@/shared/utils/resourceBudget';
import { getVirtualItemStableKey } from '../components/modern/virtualItemIdentity';
import type {
  AnyFlowItem,
  DialogTurn,
  FlowTextItem,
  FlowThinkingItem,
  FlowToolItem,
  ModelRound,
  Session,
} from '../types/flow-chat';

export interface LongRoundScenarioOptions {
  roundCount: number;
  priorCompletedTurns?: number;
  sessionId?: string;
  turnId?: string;
}

export interface StreamingStepMetrics {
  roundIndex: number;
  stepKind: 'round-start' | 'text-chunk' | 'tool-partial' | 'round-complete';
  totalPipelineMs: number;
  stageMs: {
    storeProjectionMs: number;
    groupIndexAndFeedbackMs: number;
    documentProjectionMs: number;
    rhythmPassMs: number;
    retainedBytesEstimateMs: number;
  };
  counts: {
    rounds: number;
    virtualItems: number;
    timelineBlocks: number;
    indexedGroups: number;
  };
  churn: {
    /** Total VirtualItems emitted before the active last round */
    settledVirtualItemCount: number;
    /** Settled VirtualItems that kept exact `===` object identity from previous flush */
    reusedSettledVirtualItems: number;
    /** Settled VirtualItem reference reuse ratio (0..1) */
    settledVirtualItemReuseRatio: number;
    /** Total TimelineBlocks emitted before the active last round */
    settledTimelineBlockCount: number;
    /** Settled TimelineBlocks that kept exact `===` object identity from previous flush */
    reusedSettledTimelineBlocks: number;
    /** Settled TimelineBlock reference reuse ratio (0..1) */
    settledTimelineBlockReuseRatio: number;
  };
}

export interface LongRoundBenchmarkSummary {
  roundCount: number;
  totalFlushes: number;
  totalPipelineMs: number;
  avgFlushMs: number;
  p50FlushMs: number;
  p95FlushMs: number;
  maxFlushMs: number;
  earlyFlushAvgMs: number;
  lateFlushAvgMs: number;
  lateToEarlyScalingRatio: number;
  stageTotalsMs: {
    storeProjectionMs: number;
    groupIndexAndFeedbackMs: number;
    documentProjectionMs: number;
    rhythmPassMs: number;
    retainedBytesEstimateMs: number;
  };
  avgSettledVirtualItemReuseRatio: number;
  avgSettledTimelineBlockReuseRatio: number;
  steps: StreamingStepMetrics[];
}

export interface StoreProjectionBenchResult {
  checkpoints: number[];
  totalFlushes: number;
  totalMs: number;
  avgFlushMs: number;
  earlyFlushAvgMs: number;
  lateFlushAvgMs: number;
  scalingRatio: number;
  settledVirtualItemReuseRatio: number;
}

export interface TimelineDocumentBenchResult {
  checkpoints: number[];
  totalFlushes: number;
  documentProjectionTotalMs: number;
  rhythmPassTotalMs: number;
  avgFlushMs: number;
  earlyFlushAvgMs: number;
  lateFlushAvgMs: number;
  scalingRatio: number;
  settledTimelineBlockReuseRatio: number;
  /** TimelineBlock reuse when upstream VirtualItem references are held stable for settled rounds */
  isolatedSettledTimelineBlockReuseRatio: number;
  isolatedAvgFlushMs: number;
}

export interface GroupStateAndSearchBenchResult {
  checkpoints: number[];
  totalFlushes: number;
  indexFlowGroupsTotalMs: number;
  receiveFeedbackTotalMs: number;
  searchPassTotalMs: number;
  avgCombinedMs: number;
  earlyCombinedAvgMs: number;
  lateCombinedAvgMs: number;
  scalingRatio: number;
}

export interface BackgroundBudgetAndPersistenceBenchResult {
  checkpoints: number[];
  iterationsPerCheckpoint: number;
  retainedBytesTotalMs: number;
  retainedBytesEarlyAvgMs: number;
  retainedBytesLateAvgMs: number;
  retainedBytesScalingRatio: number;
  turnHashTotalMs: number;
  turnHashEarlyAvgMs: number;
  turnHashLateAvgMs: number;
  estimatedActiveTurnBytesAtMaxRound: number;
}

const SAMPLE_TOOL_SEQUENCE = [
  { toolName: 'Read', inputKey: 'file_path', valuePrefix: 'src/web-ui/src/flow_chat/Module' },
  { toolName: 'Grep', inputKey: 'pattern', valuePrefix: 'useVirtualItems|sessionToVirtualItems' },
  { toolName: 'Read', inputKey: 'file_path', valuePrefix: 'src/web-ui/src/flow_chat/timeline/Block' },
  { toolName: 'Edit', inputKey: 'file_path', valuePrefix: 'src/web-ui/src/flow_chat/store/Store' },
  { toolName: 'ExecCommand', inputKey: 'cmd', valuePrefix: 'pnpm --dir src/web-ui test' },
] as const;

export function buildCompletedRoundFixture(roundIndex: number, turnStartTime = 1_700_000_000_000): ModelRound {
  const startTime = turnStartTime + roundIndex * 1_500;
  const specA = SAMPLE_TOOL_SEQUENCE[roundIndex % SAMPLE_TOOL_SEQUENCE.length];
  const specB = SAMPLE_TOOL_SEQUENCE[(roundIndex + 1) % SAMPLE_TOOL_SEQUENCE.length];
  const items: AnyFlowItem[] = [];

  if (roundIndex % 3 === 0) {
    const thinking: FlowThinkingItem = {
      id: `thinking-${roundIndex}`,
      type: 'thinking',
      content: `Analyzing step ${roundIndex}: checking component boundaries and virtual row stability.`,
      isStreaming: false,
      isCollapsed: true,
      timestamp: startTime + 50,
      status: 'completed',
    };
    items.push(thinking);
  }

  const toolA: FlowToolItem = {
    id: `tool-${roundIndex}-a`,
    type: 'tool',
    toolName: specA.toolName,
    timestamp: startTime + 120,
    startTime: startTime + 120,
    endTime: startTime + 450,
    status: 'completed',
    toolCall: {
      id: `tool-${roundIndex}-a`,
      input: { [specA.inputKey]: `${specA.valuePrefix}_${roundIndex}.ts` },
    },
    toolResult: {
      success: true,
      result: `Result payload for ${specA.toolName} in round ${roundIndex}: ` + 'line content\n'.repeat(12),
    },
  };
  items.push(toolA);

  if (roundIndex % 2 === 0) {
    const toolB: FlowToolItem = {
      id: `tool-${roundIndex}-b`,
      type: 'tool',
      toolName: specB.toolName,
      timestamp: startTime + 480,
      startTime: startTime + 480,
      endTime: startTime + 820,
      status: 'completed',
      toolCall: {
        id: `tool-${roundIndex}-b`,
        input: { [specB.inputKey]: `${specB.valuePrefix}_${roundIndex}_b.ts` },
      },
      toolResult: {
        success: true,
        result: `Secondary payload for ${specB.toolName} in round ${roundIndex}: ` + 'match line\n'.repeat(8),
      },
    };
    items.push(toolB);
  }

  if (roundIndex % 4 === 0) {
    const text: FlowTextItem = {
      id: `text-${roundIndex}`,
      type: 'text',
      content:
        `### Round ${roundIndex} Summary\n\n` +
        `Inspected \`${specA.valuePrefix}_${roundIndex}.ts\` and verified projection invariants.\n\n` +
        `- Checked item references\n- Checked group boundaries\n`,
      isStreaming: false,
      isMarkdown: true,
      timestamp: startTime + 900,
      status: 'completed',
    };
    items.push(text);
  }

  return {
    id: `round-${roundIndex}`,
    index: roundIndex,
    items,
    isStreaming: false,
    isComplete: true,
    status: 'completed',
    startTime,
    endTime: startTime + 1_200,
    firstChunkMs: startTime + 40,
    firstVisibleOutputMs: startTime + 50,
    ttftMs: 50,
    streamDurationMs: 1_150,
  };
}

export function buildLongRoundSessionFixture(options: LongRoundScenarioOptions): Session {
  const sessionId = options.sessionId ?? 'perf-session-long-round';
  const turnId = options.turnId ?? 'turn-active';
  const priorCount = options.priorCompletedTurns ?? 1;
  const baseTime = 1_700_000_000_000;

  const priorTurns: DialogTurn[] = Array.from({ length: priorCount }, (_, idx) => ({
    id: `turn-prior-${idx}`,
    sessionId,
    storageTurnIndex: idx,
    userMessage: {
      id: `user-prior-${idx}`,
      content: `Prior user request ${idx}`,
      timestamp: baseTime - (priorCount - idx) * 60_000,
    },
    modelRounds: [
      buildCompletedRoundFixture(0, baseTime - (priorCount - idx) * 60_000 + 100),
      buildCompletedRoundFixture(1, baseTime - (priorCount - idx) * 60_000 + 2_000),
    ],
    status: 'completed',
    startTime: baseTime - (priorCount - idx) * 60_000,
    endTime: baseTime - (priorCount - idx) * 60_000 + 5_000,
  }));

  const rounds: ModelRound[] = Array.from({ length: options.roundCount }, (_, idx) =>
    buildCompletedRoundFixture(idx, baseTime)
  );

  const activeTurn: DialogTurn = {
    id: turnId,
    sessionId,
    storageTurnIndex: priorCount,
    userMessage: {
      id: `user-${turnId}`,
      content: 'Optimize long-round session scrolling and rendering performance.',
      timestamp: baseTime - 100,
    },
    modelRounds: rounds,
    status: 'processing',
    startTime: baseTime - 100,
  };

  return {
    sessionId,
    sessionKind: 'normal',
    dialogTurns: [...priorTurns, activeTurn],
    status: 'active',
    config: { workspaceId: 'workspace-perf', workspacePath: '/workspace/perf' },
    createdAt: baseTime - 300_000,
    lastActiveAt: baseTime + options.roundCount * 1_500,
    error: null,
    historyState: 'ready',
  };
}

function buildStreamingChunkSession(
  baseSession: Session,
  chunkIdx: number,
  chunksPerCheckpoint: number,
): { session: Session; updatedTurn: DialogTurn; activeTailRound: ModelRound } {
  const activeTurnIndex = baseSession.dialogTurns.length - 1;
  const baseTurn = baseSession.dialogTurns[activeTurnIndex];
  const settledRounds = baseTurn.modelRounds.slice(0, -1);
  const tailRoundIndex = baseTurn.modelRounds.length - 1;
  const tailStartTime = 1_700_000_000_000 + tailRoundIndex * 1_500;
  const isLastChunk = chunkIdx === chunksPerCheckpoint - 1;

  const streamingText: FlowTextItem = {
    id: `stream-text-${tailRoundIndex}`,
    type: 'text',
    content: `Streaming response in round ${tailRoundIndex}: ` + 'chunk token payload '.repeat(chunkIdx + 1),
    isStreaming: !isLastChunk,
    isMarkdown: true,
    timestamp: tailStartTime + 200 + chunkIdx * 32,
    status: isLastChunk ? 'completed' : 'streaming',
  };
  const streamingTool: FlowToolItem = {
    id: `stream-tool-${tailRoundIndex}`,
    type: 'tool',
    toolName: 'Read',
    timestamp: tailStartTime + 50,
    startTime: tailStartTime + 50,
    endTime: tailStartTime + 180,
    status: 'completed',
    toolCall: {
      id: `stream-tool-${tailRoundIndex}`,
      input: { file_path: `src/file_${tailRoundIndex}.ts` },
    },
    toolResult: {
      success: true,
      result: 'file line\n'.repeat(10),
    },
  };

  const activeTailRound: ModelRound = {
    id: `round-${tailRoundIndex}`,
    index: tailRoundIndex,
    items: [streamingTool, streamingText],
    isStreaming: !isLastChunk,
    isComplete: isLastChunk,
    status: isLastChunk ? 'completed' : 'streaming',
    startTime: tailStartTime,
    ...(isLastChunk ? { endTime: tailStartTime + 500 } : {}),
  };

  const updatedTurn: DialogTurn = {
    ...baseTurn,
    modelRounds: [...settledRounds, activeTailRound],
  };
  const session: Session = {
    ...baseSession,
    dialogTurns: [...baseSession.dialogTurns.slice(0, activeTurnIndex), updatedTurn],
    lastActiveAt: tailStartTime + chunkIdx * 32,
  };

  return { session, updatedTurn, activeTailRound };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/**
 * Category 1: Store & Adjacent Group Projection (`sessionToVirtualItems` + `projectAdjacentFlowGroups`)
 */
export function benchStoreProjection(options?: {
  checkpoints?: number[];
  chunksPerCheckpoint?: number;
  interleaveViews?: boolean;
}): StoreProjectionBenchResult {
  const checkpoints = options?.checkpoints ?? [10, 50, 100, 200, 300];
  const chunksPerCheckpoint = options?.chunksPerCheckpoint ?? 5;

  const projectLive = createSessionVirtualItemProjector();
  const projectHistory = createSessionVirtualItemProjector();
  const projectSide = createSessionVirtualItemProjector();
  const side = buildLongRoundSessionFixture({ roundCount: 10, sessionId: 'side-session' });
  let previousVirtualItems: VirtualItem[] = [];
  const stepMs: Array<{ roundCount: number; ms: number; reuseRatio: number }> = [];

  for (const roundCount of checkpoints) {
    const baseSession = buildLongRoundSessionFixture({ roundCount });
    for (let chunkIdx = 0; chunkIdx < chunksPerCheckpoint; chunkIdx += 1) {
      const { session, activeTailRound } = buildStreamingChunkSession(
        baseSession,
        chunkIdx,
        chunksPerCheckpoint,
      );
      if (options?.interleaveViews) {
        projectHistory({ ...session, dialogTurns: session.dialogTurns.slice(0, -1) });
        projectSide(buildStreamingChunkSession(side, chunkIdx, chunksPerCheckpoint).session);
      }
      const t0 = performance.now();
      const virtualItems = projectLive(session);
      const t1 = performance.now();

      if (chunkIdx > 0) {
        const settled = virtualItems.filter(
          item => !(item.type === 'model-round' && item.data.id === activeTailRound.id),
        );
        const prevSet = new Set(previousVirtualItems);
        const reused = settled.filter(item => prevSet.has(item)).length;
        stepMs.push({
          roundCount,
          ms: t1 - t0,
          reuseRatio: settled.length > 0 ? reused / settled.length : 1,
        });
      }
      previousVirtualItems = virtualItems;
    }
  }

  const totalMs = stepMs.reduce((s, x) => s + x.ms, 0);
  const early = stepMs.filter(x => x.roundCount === checkpoints[0]);
  const late = stepMs.filter(x => x.roundCount === checkpoints[checkpoints.length - 1]);
  const earlyFlushAvgMs = early.reduce((s, x) => s + x.ms, 0) / Math.max(1, early.length);
  const lateFlushAvgMs = late.reduce((s, x) => s + x.ms, 0) / Math.max(1, late.length);

  return {
    checkpoints,
    totalFlushes: stepMs.length,
    totalMs,
    avgFlushMs: totalMs / Math.max(1, stepMs.length),
    earlyFlushAvgMs,
    lateFlushAvgMs,
    scalingRatio: earlyFlushAvgMs > 0 ? lateFlushAvgMs / earlyFlushAvgMs : 1,
    settledVirtualItemReuseRatio:
      stepMs.reduce((s, x) => s + x.reuseRatio, 0) / Math.max(1, stepMs.length),
  };
}

/**
 * Category 2: Timeline Document Projection & Rhythm Spacing (`ConversationDocumentProjection.project` + `getNextVisibleVirtualItemIndexes`)
 */
export function benchTimelineDocument(options?: {
  checkpoints?: number[];
  chunksPerCheckpoint?: number;
}): TimelineDocumentBenchResult {
  const checkpoints = options?.checkpoints ?? [10, 50, 100, 200, 300];
  const chunksPerCheckpoint = options?.chunksPerCheckpoint ?? 5;

  const reader = new FlowChatReaderState();
  const docProjection = new ConversationDocumentProjection();
  const docOptions: TimelineProjectionOptions = {
    reader,
    sessionId: 'perf-session-long-round',
    groupStates: new Map(),
    expandedToolCapsules: new Set(),
    pendingPermissionToolCallIds: new Set(),
    toolLabels: new Map(),
  };

  let previousTimelineBlocks: VirtualItem[] = [];
  const steps: Array<{ roundCount: number; docMs: number; rhythmMs: number; reuseRatio: number }> = [];

  for (const roundCount of checkpoints) {
    const baseSession = buildLongRoundSessionFixture({ roundCount });
    for (let chunkIdx = 0; chunkIdx < chunksPerCheckpoint; chunkIdx += 1) {
      const { session, activeTailRound } = buildStreamingChunkSession(
        baseSession,
        chunkIdx,
        chunksPerCheckpoint,
      );
      const virtualItems = sessionToVirtualItems(session);

      const t0 = performance.now();
      const timelineBlocks = docProjection.project(virtualItems, docOptions);
      const t1 = performance.now();
      getNextVisibleVirtualItemIndexes(timelineBlocks);
      const t2 = performance.now();

      if (chunkIdx > 0) {
        const settled = timelineBlocks.filter(
          block => !(block.type === 'model-round' && block.data.id === activeTailRound.id),
        );
        const prevSet = new Set(previousTimelineBlocks);
        const reused = settled.filter(block => prevSet.has(block)).length;
        steps.push({
          roundCount,
          docMs: t1 - t0,
          rhythmMs: t2 - t1,
          reuseRatio: settled.length > 0 ? reused / settled.length : 1,
        });
      }
      previousTimelineBlocks = timelineBlocks;
    }
  }

  // Also measure isolated document projection when settled VirtualItem references ARE held stable
  const isolatedProjection = new ConversationDocumentProjection();
  const maxRoundCount = checkpoints[checkpoints.length - 1];
  const baseMaxSession = buildLongRoundSessionFixture({ roundCount: maxRoundCount });
  const initialVirtualItems = sessionToVirtualItems(baseMaxSession);
  const stableSettledPrefix = initialVirtualItems.slice(0, -1);
  let prevIsolatedBlocks = isolatedProjection.project(initialVirtualItems, docOptions);
  let isolatedTotalMs = 0;
  let isolatedReuseSum = 0;
  const isolatedFlushes = chunksPerCheckpoint - 1;

  for (let chunkIdx = 1; chunkIdx < chunksPerCheckpoint; chunkIdx += 1) {
    const { session, activeTailRound } = buildStreamingChunkSession(
      baseMaxSession,
      chunkIdx,
      chunksPerCheckpoint,
    );
    const freshVirtualItems = sessionToVirtualItems(session);
    const stabilizedInput = [...stableSettledPrefix, freshVirtualItems[freshVirtualItems.length - 1]];
    const t0 = performance.now();
    const nextBlocks = isolatedProjection.project(stabilizedInput, docOptions);
    const t1 = performance.now();
    isolatedTotalMs += t1 - t0;

    const settled = nextBlocks.filter(
      block => !(block.type === 'model-round' && block.data.id === activeTailRound.id),
    );
    const prevSet = new Set(prevIsolatedBlocks);
    const reused = settled.filter(block => prevSet.has(block)).length;
    isolatedReuseSum += settled.length > 0 ? reused / settled.length : 1;
    prevIsolatedBlocks = nextBlocks;
  }

  const documentProjectionTotalMs = steps.reduce((s, x) => s + x.docMs, 0);
  const rhythmPassTotalMs = steps.reduce((s, x) => s + x.rhythmMs, 0);
  const early = steps.filter(x => x.roundCount === checkpoints[0]);
  const late = steps.filter(x => x.roundCount === checkpoints[checkpoints.length - 1]);
  const earlyFlushAvgMs =
    early.reduce((s, x) => s + x.docMs + x.rhythmMs, 0) / Math.max(1, early.length);
  const lateFlushAvgMs =
    late.reduce((s, x) => s + x.docMs + x.rhythmMs, 0) / Math.max(1, late.length);

  return {
    checkpoints,
    totalFlushes: steps.length,
    documentProjectionTotalMs,
    rhythmPassTotalMs,
    avgFlushMs: (documentProjectionTotalMs + rhythmPassTotalMs) / Math.max(1, steps.length),
    earlyFlushAvgMs,
    lateFlushAvgMs,
    scalingRatio: earlyFlushAvgMs > 0 ? lateFlushAvgMs / earlyFlushAvgMs : 1,
    settledTimelineBlockReuseRatio:
      steps.reduce((s, x) => s + x.reuseRatio, 0) / Math.max(1, steps.length),
    isolatedSettledTimelineBlockReuseRatio: isolatedReuseSum / Math.max(1, isolatedFlushes),
    isolatedAvgFlushMs: isolatedTotalMs / Math.max(1, isolatedFlushes),
  };
}

/**
 * Category 3: Container Group Indexing, Receive Feedback & Search Passes
 * (`indexFlowGroups`, `captureFlowGroupFeedbackSnapshot`, `collectFlowGroupReceiveFeedback`, `buildFlowChatSearchMatches`)
 */
export function benchGroupStateAndSearch(options?: {
  checkpoints?: number[];
  chunksPerCheckpoint?: number;
  activeSearchQuery?: string;
}): GroupStateAndSearchBenchResult {
  const checkpoints = options?.checkpoints ?? [10, 50, 100, 200, 300];
  const chunksPerCheckpoint = options?.chunksPerCheckpoint ?? 5;
  const activeSearchQuery = options?.activeSearchQuery ?? 'projection';
  const findMatches = createFlowChatSearchMatcher();

  let feedbackSnapshot: ReturnType<typeof captureFlowGroupFeedbackSnapshot> | undefined;

  const steps: Array<{
    roundCount: number;
    indexMs: number;
    feedbackMs: number;
    searchMs: number;
  }> = [];

  for (const roundCount of checkpoints) {
    const baseSession = buildLongRoundSessionFixture({ roundCount });
    for (let chunkIdx = 0; chunkIdx < chunksPerCheckpoint; chunkIdx += 1) {
      const { session } = buildStreamingChunkSession(baseSession, chunkIdx, chunksPerCheckpoint);
      const virtualItems = sessionToVirtualItems(session);

      const t0 = performance.now();
      indexFlowGroups(virtualItems);
      const t1 = performance.now();
      collectFlowGroupReceiveFeedback(
        feedbackSnapshot,
        virtualItems,
        session.sessionId,
      );
      feedbackSnapshot = captureFlowGroupFeedbackSnapshot(virtualItems, session.sessionId);
      const t2 = performance.now();
      findMatches(virtualItems, activeSearchQuery);
      const t3 = performance.now();

      if (chunkIdx > 0) {
        steps.push({
          roundCount,
          indexMs: t1 - t0,
          feedbackMs: t2 - t1,
          searchMs: t3 - t2,
        });
      }
    }
  }

  const indexFlowGroupsTotalMs = steps.reduce((s, x) => s + x.indexMs, 0);
  const receiveFeedbackTotalMs = steps.reduce((s, x) => s + x.feedbackMs, 0);
  const searchPassTotalMs = steps.reduce((s, x) => s + x.searchMs, 0);
  const totalCombinedMs = indexFlowGroupsTotalMs + receiveFeedbackTotalMs + searchPassTotalMs;

  const early = steps.filter(x => x.roundCount === checkpoints[0]);
  const late = steps.filter(x => x.roundCount === checkpoints[checkpoints.length - 1]);
  const earlyCombinedAvgMs =
    early.reduce((s, x) => s + x.indexMs + x.feedbackMs + x.searchMs, 0) / Math.max(1, early.length);
  const lateCombinedAvgMs =
    late.reduce((s, x) => s + x.indexMs + x.feedbackMs + x.searchMs, 0) / Math.max(1, late.length);

  return {
    checkpoints,
    totalFlushes: steps.length,
    indexFlowGroupsTotalMs,
    receiveFeedbackTotalMs,
    searchPassTotalMs,
    avgCombinedMs: totalCombinedMs / Math.max(1, steps.length),
    earlyCombinedAvgMs,
    lateCombinedAvgMs,
    scalingRatio: earlyCombinedAvgMs > 0 ? lateCombinedAvgMs / earlyCombinedAvgMs : 1,
  };
}

/**
 * Category 4: Background Memory Budget & Persistence Hash Overhead
 * (`estimateRetainedBytes(turn)` + `calculateTurnHash(turn)`)
 */
export function benchBackgroundBudgetAndPersistence(options?: {
  checkpoints?: number[];
  iterationsPerCheckpoint?: number;
}): BackgroundBudgetAndPersistenceBenchResult {
  const checkpoints = options?.checkpoints ?? [10, 50, 100, 200, 300];
  const iterationsPerCheckpoint = options?.iterationsPerCheckpoint ?? 5;

  const steps: Array<{ roundCount: number; bytesMs: number; hashMs: number; bytes: number }> = [];

  for (const roundCount of checkpoints) {
    const baseSession = buildLongRoundSessionFixture({ roundCount });
    // Sample the initial turn before the later 500ms budget ticks. Production
    // caches immutable whole Turns at the history owner, not round prefixes here.
    const { updatedTurn: initialTurn } = buildStreamingChunkSession(baseSession, 0, iterationsPerCheckpoint + 1);
    estimateRetainedBytes(initialTurn);
    for (let i = 1; i <= iterationsPerCheckpoint; i += 1) {
      const { updatedTurn } = buildStreamingChunkSession(baseSession, i, iterationsPerCheckpoint + 1);
      const t0 = performance.now();
      const bytes = estimateRetainedBytes(updatedTurn);
      const t1 = performance.now();
      calculateTurnHash(updatedTurn);
      const t2 = performance.now();

      steps.push({
        roundCount,
        bytesMs: t1 - t0,
        hashMs: t2 - t1,
        bytes,
      });
    }
  }

  const retainedBytesTotalMs = steps.reduce((s, x) => s + x.bytesMs, 0);
  const turnHashTotalMs = steps.reduce((s, x) => s + x.hashMs, 0);
  const early = steps.filter(x => x.roundCount === checkpoints[0]);
  const late = steps.filter(x => x.roundCount === checkpoints[checkpoints.length - 1]);

  const retainedBytesEarlyAvgMs =
    early.reduce((s, x) => s + x.bytesMs, 0) / Math.max(1, early.length);
  const retainedBytesLateAvgMs =
    late.reduce((s, x) => s + x.bytesMs, 0) / Math.max(1, late.length);
  const turnHashEarlyAvgMs = early.reduce((s, x) => s + x.hashMs, 0) / Math.max(1, early.length);
  const turnHashLateAvgMs = late.reduce((s, x) => s + x.hashMs, 0) / Math.max(1, late.length);

  return {
    checkpoints,
    iterationsPerCheckpoint,
    retainedBytesTotalMs,
    retainedBytesEarlyAvgMs,
    retainedBytesLateAvgMs,
    retainedBytesScalingRatio:
      retainedBytesEarlyAvgMs > 0 ? retainedBytesLateAvgMs / retainedBytesEarlyAvgMs : 1,
    turnHashTotalMs,
    turnHashEarlyAvgMs,
    turnHashLateAvgMs,
    estimatedActiveTurnBytesAtMaxRound: late[late.length - 1]?.bytes ?? 0,
  };
}

/**
 * Runs a combined end-to-end multi-stage benchmark simulating streaming flushes
 * at the tail of a growing long-round turn.
 */
export function runLongRoundPipelineBenchmark(options: {
  checkpoints?: number[];
  chunksPerCheckpoint?: number;
  measureRetainedBytesEveryFlush?: boolean;
}): LongRoundBenchmarkSummary {
  const checkpoints = options.checkpoints ?? [10, 50, 100, 150, 200];
  const chunksPerCheckpoint = options.chunksPerCheckpoint ?? 4;
  const measureRetainedBytesEveryFlush = options.measureRetainedBytesEveryFlush ?? true;

  const reader = new FlowChatReaderState();
  const docProjection = new ConversationDocumentProjection();
  const groupStates = new Map<string, boolean>();
  const expandedToolCapsules = new Set<string>();
  const pendingPermissionToolCallIds = new Set<string>();
  const toolLabels = new Map<string, string>();

  let previousVirtualItems: VirtualItem[] = [];
  let previousTimelineBlocks: VirtualItem[] = [];
  let feedbackSnapshot: ReturnType<typeof captureFlowGroupFeedbackSnapshot> | undefined;

  const steps: StreamingStepMetrics[] = [];

  for (const roundCount of checkpoints) {
    const baseSession = buildLongRoundSessionFixture({ roundCount });
    const tailRoundIndex = roundCount - 1;

    for (let chunkIdx = 0; chunkIdx < chunksPerCheckpoint; chunkIdx += 1) {
      const isLastChunk = chunkIdx === chunksPerCheckpoint - 1;
      const { session, updatedTurn, activeTailRound } = buildStreamingChunkSession(
        baseSession,
        chunkIdx,
        chunksPerCheckpoint,
      );

      // Stage 1: Store projection (sessionToVirtualItems + projectAdjacentFlowGroups)
      const t0 = performance.now();
      const virtualItems = sessionToVirtualItems(session);
      const t1 = performance.now();

      // Stage 2: Group indexing & receive feedback (useFlowGroupState equivalents)
      const indexedGroups = indexFlowGroups(virtualItems);
      collectFlowGroupReceiveFeedback(
        feedbackSnapshot,
        virtualItems,
        session.sessionId,
      );
      feedbackSnapshot = captureFlowGroupFeedbackSnapshot(virtualItems, session.sessionId);
      const t2 = performance.now();

      // Stage 3: ConversationDocumentProjection.project
      const docOptions: TimelineProjectionOptions = {
        reader,
        sessionId: session.sessionId,
        groupStates,
        expandedToolCapsules,
        pendingPermissionToolCallIds,
        toolLabels,
      };
      const timelineBlocks = docProjection.project(virtualItems, docOptions);
      const t3 = performance.now();

      // Stage 4: Rhythm visible-index pass
      getNextVisibleVirtualItemIndexes(timelineBlocks);
      const t4 = performance.now();

      // Stage 5: Retained bytes estimation on active turn
      if (measureRetainedBytesEveryFlush) {
        estimateRetainedBytes(updatedTurn);
      }
      const t5 = performance.now();

      // Audit reference stability of settled items (excluding the active tail round)
      const activeRoundId = activeTailRound.id;
      const settledVirtualItems = virtualItems.filter(
        item => !(item.type === 'model-round' && item.data.id === activeRoundId)
      );
      const prevVirtualSet = new Set(previousVirtualItems);
      const reusedSettledVirtualItems = settledVirtualItems.filter(item => prevVirtualSet.has(item)).length;

      const settledTimelineBlocks = timelineBlocks.filter(
        block => !(block.type === 'model-round' && block.data.id === activeRoundId)
      );
      const prevTimelineSet = new Set(previousTimelineBlocks);
      const reusedSettledTimelineBlocks = settledTimelineBlocks.filter(block => prevTimelineSet.has(block)).length;

      if (chunkIdx > 0) {
        steps.push({
          roundIndex: tailRoundIndex,
          stepKind: isLastChunk ? 'round-complete' : 'text-chunk',
          totalPipelineMs: t5 - t0,
          stageMs: {
            storeProjectionMs: t1 - t0,
            groupIndexAndFeedbackMs: t2 - t1,
            documentProjectionMs: t3 - t2,
            rhythmPassMs: t4 - t3,
            retainedBytesEstimateMs: t5 - t4,
          },
          counts: {
            rounds: roundCount,
            virtualItems: virtualItems.length,
            timelineBlocks: timelineBlocks.length,
            indexedGroups: indexedGroups.byId.size,
          },
          churn: {
            settledVirtualItemCount: settledVirtualItems.length,
            reusedSettledVirtualItems,
            settledVirtualItemReuseRatio:
              settledVirtualItems.length > 0 ? reusedSettledVirtualItems / settledVirtualItems.length : 1,
            settledTimelineBlockCount: settledTimelineBlocks.length,
            reusedSettledTimelineBlocks,
            settledTimelineBlockReuseRatio:
              settledTimelineBlocks.length > 0 ? reusedSettledTimelineBlocks / settledTimelineBlocks.length : 1,
          },
        });
      }

      previousVirtualItems = virtualItems;
      previousTimelineBlocks = timelineBlocks;
    }
  }

  const durations = steps.map(s => s.totalPipelineMs).sort((a, b) => a - b);
  const totalPipelineMs = steps.reduce((sum, s) => sum + s.totalPipelineMs, 0);
  const stageTotalsMs = steps.reduce(
    (acc, s) => ({
      storeProjectionMs: acc.storeProjectionMs + s.stageMs.storeProjectionMs,
      groupIndexAndFeedbackMs: acc.groupIndexAndFeedbackMs + s.stageMs.groupIndexAndFeedbackMs,
      documentProjectionMs: acc.documentProjectionMs + s.stageMs.documentProjectionMs,
      rhythmPassMs: acc.rhythmPassMs + s.stageMs.rhythmPassMs,
      retainedBytesEstimateMs: acc.retainedBytesEstimateMs + s.stageMs.retainedBytesEstimateMs,
    }),
    {
      storeProjectionMs: 0,
      groupIndexAndFeedbackMs: 0,
      documentProjectionMs: 0,
      rhythmPassMs: 0,
      retainedBytesEstimateMs: 0,
    },
  );

  const firstCheckpoint = checkpoints[0];
  const lastCheckpoint = checkpoints[checkpoints.length - 1];
  const earlySteps = steps.filter(s => s.roundIndex === firstCheckpoint - 1);
  const lateSteps = steps.filter(s => s.roundIndex === lastCheckpoint - 1);
  const earlyFlushAvgMs =
    earlySteps.reduce((sum, s) => sum + s.totalPipelineMs, 0) / Math.max(1, earlySteps.length);
  const lateFlushAvgMs =
    lateSteps.reduce((sum, s) => sum + s.totalPipelineMs, 0) / Math.max(1, lateSteps.length);

  const avgSettledVirtualItemReuseRatio =
    steps.reduce((sum, s) => sum + s.churn.settledVirtualItemReuseRatio, 0) / Math.max(1, steps.length);
  const avgSettledTimelineBlockReuseRatio =
    steps.reduce((sum, s) => sum + s.churn.settledTimelineBlockReuseRatio, 0) / Math.max(1, steps.length);

  return {
    roundCount: lastCheckpoint,
    totalFlushes: steps.length,
    totalPipelineMs,
    avgFlushMs: totalPipelineMs / Math.max(1, steps.length),
    p50FlushMs: percentile(durations, 0.5),
    p95FlushMs: percentile(durations, 0.95),
    maxFlushMs: durations[durations.length - 1] ?? 0,
    earlyFlushAvgMs,
    lateFlushAvgMs,
    lateToEarlyScalingRatio: earlyFlushAvgMs > 0 ? lateFlushAvgMs / earlyFlushAvgMs : 1,
    stageTotalsMs,
    avgSettledVirtualItemReuseRatio,
    avgSettledTimelineBlockReuseRatio,
    steps,
  };
}

/**
 * Formats a human-readable diagnostic table of the benchmark summary.
 */
export function formatBenchmarkReport(summary: LongRoundBenchmarkSummary): string {
  const lines: string[] = [
    `=== FlowChat Long-Round Harness Report (up to ${summary.roundCount} rounds, ${summary.totalFlushes} measured flushes) ===`,
    `Total Pipeline Time : ${summary.totalPipelineMs.toFixed(2)} ms`,
    `Flush Latency       : avg=${summary.avgFlushMs.toFixed(2)}ms | p50=${summary.p50FlushMs.toFixed(2)}ms | p95=${summary.p95FlushMs.toFixed(2)}ms | max=${summary.maxFlushMs.toFixed(2)}ms`,
    `Scaling (Late/Early): early=${summary.earlyFlushAvgMs.toFixed(2)}ms -> late=${summary.lateFlushAvgMs.toFixed(2)}ms (${summary.lateToEarlyScalingRatio.toFixed(2)}x)`,
    `Stage Breakdown     :`,
    `  1. Store Projection (sessionToVirtualItems + grouping): ${summary.stageTotalsMs.storeProjectionMs.toFixed(2)} ms`,
    `  2. Group Index & Feedback (useFlowGroupState)         : ${summary.stageTotalsMs.groupIndexAndFeedbackMs.toFixed(2)} ms`,
    `  3. Document Timeline (ConversationDocumentProjection) : ${summary.stageTotalsMs.documentProjectionMs.toFixed(2)} ms`,
    `  4. Rhythm Spacing Pass (getNextVisibleIndexes)        : ${summary.stageTotalsMs.rhythmPassMs.toFixed(2)} ms`,
    `  5. Retained Bytes Walk (estimateRetainedBytes)        : ${summary.stageTotalsMs.retainedBytesEstimateMs.toFixed(2)} ms`,
    `Reference Reuse     :`,
    `  - Settled VirtualItem Identity Reuse   : ${(summary.avgSettledVirtualItemReuseRatio * 100).toFixed(1)}%`,
    `  - Settled TimelineBlock Identity Reuse : ${(summary.avgSettledTimelineBlockReuseRatio * 100).toFixed(1)}%`,
  ];
  return lines.join('\n');
}

export { getVirtualItemStableKey, getVirtualItemFlowGroups };
