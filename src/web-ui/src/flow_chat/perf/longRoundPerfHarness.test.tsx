// @vitest-environment jsdom
import React, { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { VirtualMessageList } from '../components/modern/VirtualMessageList';
import { getVirtualItemStableKey } from '../components/modern/virtualItemIdentity';
import { sessionToVirtualItems, type VirtualItem } from '../store/modernFlowChatStore';
import { useFlowGroupState } from '../components/modern/useFlowGroupState';
import { FlowChatContext, FlowChatVolatileContext } from '../components/modern/FlowChatContext';
import {
  benchBackgroundBudgetAndPersistence,
  benchGroupStateAndSearch,
  benchStoreProjection,
  benchTimelineDocument,
  buildLongRoundSessionFixture,
  formatBenchmarkReport,
  runLongRoundPipelineBenchmark,
} from './longRoundPerfHarness';
import type { DialogTurn, FlowTextItem, ModelRound, Session } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const harnessStoreState = vi.hoisted(() => ({
  items: [] as VirtualItem[],
  session: null as Session | null,
  isProcessing: true,
}));

const renderTelemetry = vi.hoisted(() => ({
  virtualListCommits: 0,
  virtualListActualDurationMs: 0,
  rowRendersByKey: new Map<string, number>(),
  reset() {
    this.virtualListCommits = 0;
    this.virtualListActualDurationMs = 0;
    this.rowRendersByKey.clear();
  },
}));

vi.mock('../store/modernFlowChatStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/modernFlowChatStore')>();
  const store = Object.assign(
    (select: (state: unknown) => unknown) =>
      select({
        visibleTurnInfo: null,
        activeSession: harnessStoreState.session,
        virtualItems: harnessStoreState.items,
      }),
    {
      getState: () => ({
        setVisibleTurnInfo() {},
        activeSession: harnessStoreState.session,
        virtualItems: harnessStoreState.items,
      }),
    }
  );
  return {
    ...actual,
    useVirtualItems: () => harnessStoreState.items,
    useActiveSession: () => harnessStoreState.session,
    useModernFlowChatStore: store,
    useModernFlowChatStoreApi: () => store,
  };
});

vi.mock('../hooks/useActiveSessionState', () => ({
  useActiveSessionState: () => ({
    sessionId: harnessStoreState.session?.sessionId ?? null,
    isProcessing: harnessStoreState.isProcessing,
    processingPhase: null,
    error: null,
    status: harnessStoreState.isProcessing ? 'active' : 'idle',
  }),
}));

vi.mock('../store/chatInputStateStore', () => ({
  useChatInputState: (select: (state: unknown) => unknown) => select({ inputHeight: 100 }),
}));

vi.mock('../hooks/useScrollToTurnHeader', () => ({
  useScrollToTurnHeader: () => ({ shouldShowButton: false, handleClick() {} }),
}));

vi.mock('../components/modern/RuntimeStatusSlot', () => ({
  RuntimeStatusSlot: () => null,
}));

vi.mock('../components/ScrollToLatestBar', () => ({
  ScrollToLatestBar: () => null,
}));

vi.mock('../components/ScrollToTurnHeaderButton', () => ({
  ScrollToTurnHeaderButton: () => null,
}));

// Keep React.memo semantics identical to production VirtualItemRenderer while
// recording per-row render counts and subscribing to FlowChatVolatileContext.
vi.mock('../components/modern/VirtualItemRenderer', async () => {
  const ReactModule = await import('react');
  const { useFlowChatVolatileContext } = await import('../components/modern/FlowChatContext');
  const { getVirtualItemStableKey: stableKey } = await import('../components/modern/virtualItemIdentity');

  const InstrumentedRow = ReactModule.memo(
    ({
      item,
      index,
      measureRef,
    }: {
      item: VirtualItem;
      index: number;
      isLatestTurn?: boolean;
      endsBeforeUserTurn?: boolean;
      continuesAmbientToolRunAfter?: boolean;
      measureRef?: (element: HTMLElement | null) => void;
    }) => {
      useFlowChatVolatileContext();
      const key = stableKey(item);
      renderTelemetry.rowRendersByKey.set(key, (renderTelemetry.rowRendersByKey.get(key) ?? 0) + 1);
      return (
        <div
          ref={measureRef}
          className="virtual-item-wrapper"
          data-item-type={item.type}
          data-turn-id={item.turnId}
          data-virtual-index={index}
          data-virtual-item-key={key}
        />
      );
    },
    (prev, next) =>
      prev.item === next.item &&
      prev.index === next.index &&
      prev.isLatestTurn === next.isLatestTurn &&
      prev.endsBeforeUserTurn === next.endsBeforeUserTurn &&
      prev.continuesAmbientToolRunAfter === next.continuesAmbientToolRunAfter &&
      prev.measureRef === next.measureRef
  );

  return { VirtualItemRenderer: InstrumentedRow };
});

function LiveContainerHarness({ latestTurnId }: { latestTurnId: string }) {
  const session = harnessStoreState.session;
  const virtualItems = harnessStoreState.items;
  const {
    groupStates,
    groupReceiveFeedback,
    expandedToolCapsules,
    onToolCapsuleExpandedChange,
    onGroupToggle,
    onExpandGroup,
    onExpandAllInTurn,
    onCollapseGroup,
  } = useFlowGroupState(
    virtualItems,
    undefined,
    session?.sessionId,
    undefined,
    `perf:${session?.sessionId ?? ''}`
  );

  const contextValue = React.useMemo(
    () => ({
      sessionId: session?.sessionId,
      workspaceId: session?.config?.workspaceId,
      workspacePath: session?.config?.workspacePath,
      onGroupToggle,
      onExploreGroupToggle: onGroupToggle,
      onExpandGroup,
      onExpandAllInTurn,
      onCollapseGroup,
      onToolCapsuleExpandedChange,
    }),
    [
      session?.sessionId,
      session?.config?.workspaceId,
      session?.config?.workspacePath,
      onGroupToggle,
      onExpandGroup,
      onExpandAllInTurn,
      onCollapseGroup,
      onToolCapsuleExpandedChange,
    ]
  );

  const volatileValue = React.useMemo(
    () => ({
      pendingPermissionToolCallIds: new Set<string>(),
      groupStates,
      groupReceiveFeedback,
      exploreGroupStates: groupStates,
      expandedToolCapsules,
      searchQuery: '',
      searchMatchesByVirtualIndex: new Map(),
      searchCurrentMatch: undefined,
    }),
    [groupStates, groupReceiveFeedback, expandedToolCapsules]
  );

  return (
    <FlowChatContext.Provider value={contextValue}>
      <FlowChatVolatileContext.Provider value={volatileValue}>
        <Profiler
          id="VirtualMessageList"
          onRender={(_id, _phase, actualDuration) => {
            renderTelemetry.virtualListCommits += 1;
            renderTelemetry.virtualListActualDurationMs += actualDuration;
          }}
        >
          <VirtualMessageList latestTurnId={latestTurnId} contentWidth={900} />
        </Profiler>
      </FlowChatVolatileContext.Provider>
    </FlowChatContext.Provider>
  );
}

describe('FlowChat Long-Round Categorized Benchmark Suites', () => {
  describe('Category 1: Store & Adjacent Group Projection [bench:store-projection]', () => {
    it('benchmarks sessionToVirtualItems & projectAdjacentFlowGroups scaling and reference reuse', () => {
      const result = benchStoreProjection({
        checkpoints: [10, 50, 100, 200, 300],
        chunksPerCheckpoint: 5,
      });

      console.info(
        [
          `=== [Category 1: Store Projection] ===`,
          `Total Time (20 flushes)          : ${result.totalMs.toFixed(2)} ms (avg ${result.avgFlushMs.toFixed(2)} ms/flush)`,
          `Scaling (10 -> 300 rounds)       : ${result.earlyFlushAvgMs.toFixed(2)} ms -> ${result.lateFlushAvgMs.toFixed(2)} ms (${result.scalingRatio.toFixed(2)}x)`,
          `Settled VirtualItem Ref Reuse    : ${(result.settledVirtualItemReuseRatio * 100).toFixed(1)}%`,
        ].join('\n')
      );

      expect(result.totalFlushes).toBe(20);
      // Identity reuse is deterministic for this fixture; wall-clock timings
      // remain diagnostics, not a portable machine-speed assertion.
      expect(result.settledVirtualItemReuseRatio).toBeGreaterThan(0.9);
    });
  });

  describe('Category 2: Timeline Document & Rhythm Pass [bench:timeline-document]', () => {
    it('benchmarks ConversationDocumentProjection.project & getNextVisibleVirtualItemIndexes', () => {
      const result = benchTimelineDocument({
        checkpoints: [10, 50, 100, 200, 300],
        chunksPerCheckpoint: 5,
      });

      console.info(
        [
          `=== [Category 2: Timeline Document & Rhythm] ===`,
          `Document Projection Total        : ${result.documentProjectionTotalMs.toFixed(2)} ms`,
          `Rhythm Visible-Index Total       : ${result.rhythmPassTotalMs.toFixed(2)} ms`,
          `Scaling (10 -> 300 rounds)       : ${result.earlyFlushAvgMs.toFixed(2)} ms -> ${result.lateFlushAvgMs.toFixed(2)} ms (${result.scalingRatio.toFixed(2)}x)`,
          `Current TimelineBlock Ref Reuse  : ${(result.settledTimelineBlockReuseRatio * 100).toFixed(1)}%`,
          `Isolated Reuse (if Store stable) : ${(result.isolatedSettledTimelineBlockReuseRatio * 100).toFixed(1)}% (${result.isolatedAvgFlushMs.toFixed(2)} ms/flush at 300 rounds)`,
        ].join('\n')
      );

      expect(result.totalFlushes).toBe(20);
      expect(result.settledTimelineBlockReuseRatio).toBeGreaterThan(0.9);
    });
  });

  describe('Category 3: Container Group State, Feedback & Search [bench:group-state-search]', () => {
    it('benchmarks indexFlowGroups, receiveFeedback, and buildFlowChatSearchMatches', () => {
      const result = benchGroupStateAndSearch({
        checkpoints: [10, 50, 100, 200, 300],
        chunksPerCheckpoint: 5,
      });

      console.info(
        [
          `=== [Category 3: Container Group Index, Feedback & Search] ===`,
          `indexFlowGroups Total            : ${result.indexFlowGroupsTotalMs.toFixed(2)} ms`,
          `receiveFeedback Total            : ${result.receiveFeedbackTotalMs.toFixed(2)} ms`,
          `buildFlowChatSearchMatches Total : ${result.searchPassTotalMs.toFixed(2)} ms`,
          `Scaling (10 -> 300 rounds)       : ${result.earlyCombinedAvgMs.toFixed(2)} ms -> ${result.lateCombinedAvgMs.toFixed(2)} ms (${result.scalingRatio.toFixed(2)}x)`,
        ].join('\n')
      );

      expect(result.totalFlushes).toBe(20);
    });
  });

  describe('Category 4: Background Memory Budget & Persistence Hash [bench:budget-persistence]', () => {
    it('benchmarks estimateRetainedBytes and calculateTurnHash across growing turns', () => {
      const result = benchBackgroundBudgetAndPersistence({
        checkpoints: [10, 50, 100, 200, 300],
        iterationsPerCheckpoint: 5,
      });

      console.info(
        [
          `=== [Category 4: Background Budget & Persistence] ===`,
          `estimateRetainedBytes Total      : ${result.retainedBytesTotalMs.toFixed(2)} ms (${result.retainedBytesEarlyAvgMs.toFixed(2)} ms -> ${result.retainedBytesLateAvgMs.toFixed(2)} ms, ${result.retainedBytesScalingRatio.toFixed(2)}x)`,
          `calculateTurnHash Total          : ${result.turnHashTotalMs.toFixed(2)} ms (${result.turnHashEarlyAvgMs.toFixed(2)} ms -> ${result.turnHashLateAvgMs.toFixed(2)} ms)`,
          `Estimated Turn Size @ 300 rounds : ${(result.estimatedActiveTurnBytesAtMaxRound / 1024).toFixed(1)} KB`,
        ].join('\n')
      );

      expect(result.estimatedActiveTurnBytesAtMaxRound).toBeGreaterThan(0);
    });
  });

  describe('Category 5: React Framework & Virtualizer DOM Interaction [bench:react-virtualizer]', () => {
    let root: Root;
    let host: HTMLDivElement;
    let frames: Map<number, FrameRequestCallback>;
    let frameId: number;
    let now: number;
    let observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
      sizes: WeakMap<Element, string>;
    }>;
    const heights = new Map<string, number>();
    const offsets = new WeakMap<HTMLElement, number>();
    const px = (value: string) => Number.parseFloat(value || '0') || 0;
    const realHrTimeMs = () => Number(process.hrtime.bigint()) / 1_000_000;

    function measureElementHeight(element: HTMLElement, measured = new WeakMap<HTMLElement, number>()): number {
      const cached = measured.get(element);
      if (cached !== undefined) return cached;
      let result = 80;
      if (element.hasAttribute('data-flowchat-scroller')) {
        result = 720;
      } else if (element.dataset.virtualItemKey) {
        result = heights.get(element.dataset.virtualItemKey) ?? 84;
      } else if (element.style.height) {
        result = px(element.style.height);
      } else {
        result = Math.max(
          px(element.style.minHeight),
          px(element.style.paddingTop) +
            px(element.style.paddingBottom) +
            [...element.children].reduce(
              (sum, child) => sum + measureElementHeight(child as HTMLElement, measured),
              0
            )
        );
      }
      measured.set(element, result);
      return result;
    }

    function contentTop(element: HTMLElement, measured: WeakMap<HTMLElement, number>): number {
      let top = 0;
      let current = element;
      while (current.parentElement && !current.hasAttribute('data-flowchat-scroller')) {
        let sibling = current.previousElementSibling;
        while (sibling) {
          top += measureElementHeight(sibling as HTMLElement, measured);
          sibling = sibling.previousElementSibling;
        }
        current = current.parentElement;
        top += px(current.style.paddingTop);
      }
      return top;
    }

    const flushAnimationFrames = () => {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach(cb => cb(now)));
    };

    const flushResizeObservers = () =>
      act(() => {
        for (const observer of observers) {
          const measured = new WeakMap<HTMLElement, number>();
          const entries = [...observer.targets]
            .filter(target => target.isConnected)
            .flatMap(target => {
              const blockSize = measureElementHeight(target as HTMLElement, measured);
              const inlineSize = 900;
              const size = `${inlineSize}:${blockSize}`;
              if (observer.sizes.get(target) === size) return [];
              observer.sizes.set(target, size);
              return [
                {
                  target,
                  borderBoxSize: [{ inlineSize, blockSize }],
                  contentRect: target.getBoundingClientRect(),
                } as ResizeObserverEntry,
              ];
            });
          if (entries.length) observer.callback(entries, {} as ResizeObserver);
        }
      });

    beforeEach(() => {
      activateSurface('local');
      renderTelemetry.reset();
      frames = new Map();
      frameId = 0;
      now = 1_000;
      observers = [];
      heights.clear();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      vi.spyOn(performance, 'now').mockImplementation(() => now + (realHrTimeMs() % 1));
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        frames.set(++frameId, cb);
        return frameId;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
      );
      vi.stubGlobal(
        'ResizeObserver',
        class {
          targets = new Set<Element>();
          sizes = new WeakMap<Element, string>();
          constructor(public callback: ResizeObserverCallback) {
            observers.push(this);
          }
          observe(target: Element) {
            this.targets.add(target);
          }
          unobserve(target: Element) {
            this.targets.delete(target);
            this.sizes.delete(target);
          }
          disconnect() {
            this.targets.clear();
            this.sizes = new WeakMap();
          }
        }
      );

      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
        return Math.round(measureElementHeight(this));
      });
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
        return Math.round(measureElementHeight(this));
      });
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
        return Math.round(
          this.hasAttribute('data-flowchat-scroller')
            ? measureElementHeight(this.firstElementChild as HTMLElement)
            : measureElementHeight(this)
        );
      });
      vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function () {
        const range = Math.max(0, this.scrollHeight - this.clientHeight);
        return Math.min(offsets.get(this) ?? 0, range);
      });
      vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (value: number) {
        const range = Math.max(0, this.scrollHeight - this.clientHeight);
        offsets.set(this, Math.max(0, Math.min(value, range)));
      });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        const measured = new WeakMap<HTMLElement, number>();
        const scroller = this.closest<HTMLElement>('[data-flowchat-scroller]');
        const top =
          !scroller || this === scroller
            ? 0
            : contentTop(this, measured) - (offsets.get(scroller) ?? 0);
        const h = measureElementHeight(this, measured);
        const w = 900;
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: w,
          bottom: top + h,
          width: w,
          height: h,
          toJSON: () => ({}),
        } as DOMRect;
      });

      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    });

    afterEach(() => {
      act(() => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('[bench:react-streaming] measures React commits & wasted settled-row renders during 10 tail stream chunks (120 rounds)', () => {
      const roundCount = 120;
      const baseSession = buildLongRoundSessionFixture({ roundCount });
      const activeTurnIndex = baseSession.dialogTurns.length - 1;
      const baseTurn = baseSession.dialogTurns[activeTurnIndex];
      const settledRounds = baseTurn.modelRounds.slice(0, -1);
      const tailRoundIndex = roundCount - 1;

      harnessStoreState.session = baseSession;
      harnessStoreState.items = sessionToVirtualItems(baseSession);
      harnessStoreState.isProcessing = true;

      act(() => {
        root.render(<LiveContainerHarness latestTurnId={baseTurn.id} />);
      });
      flushResizeObservers();
      flushAnimationFrames();

      const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      act(() => {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.dispatchEvent(new Event('scroll'));
      });
      flushResizeObservers();
      flushAnimationFrames();

      renderTelemetry.reset();

      const streamChunks = 10;
      const tStreamStart = realHrTimeMs();
      for (let chunk = 1; chunk <= streamChunks; chunk += 1) {
        now += 32;
        const streamingText: FlowTextItem = {
          id: `stream-tail-text-${tailRoundIndex}`,
          type: 'text',
          content: `Live streaming output chunk ${chunk}: ` + 'token '.repeat(chunk * 3),
          isStreaming: chunk < streamChunks,
          isMarkdown: true,
          timestamp: now,
          status: chunk < streamChunks ? 'streaming' : 'completed',
        };
        const tailRound: ModelRound = {
          ...baseTurn.modelRounds[tailRoundIndex],
          items: [...baseTurn.modelRounds[tailRoundIndex].items, streamingText],
          isStreaming: chunk < streamChunks,
          isComplete: chunk === streamChunks,
          status: chunk < streamChunks ? 'streaming' : 'completed',
        };
        const nextTurn: DialogTurn = {
          ...baseTurn,
          modelRounds: [...settledRounds, tailRound],
        };
        const nextSession: Session = {
          ...baseSession,
          dialogTurns: [...baseSession.dialogTurns.slice(0, activeTurnIndex), nextTurn],
          lastActiveAt: now,
        };

        harnessStoreState.session = nextSession;
        harnessStoreState.items = sessionToVirtualItems(nextSession);

        act(() => {
          root.render(<LiveContainerHarness latestTurnId={baseTurn.id} />);
        });
        flushResizeObservers();
        flushAnimationFrames();
      }
      const streamWallMs = realHrTimeMs() - tStreamStart;

      let settledRowRenderSum = 0;
      let settledRowKeysCount = 0;
      let activeRowRenderSum = 0;
      for (const [key, count] of renderTelemetry.rowRendersByKey.entries()) {
        if (
          key.includes(`round-${tailRoundIndex}`) ||
          key.includes(`stream-tail-text-${tailRoundIndex}`) ||
          key.includes(`tool-${tailRoundIndex}-`) ||
          key.includes(`thinking-${tailRoundIndex}`) ||
          key.includes(`text-${tailRoundIndex}`)
        ) {
          activeRowRenderSum += count;
        } else {
          settledRowKeysCount += 1;
          settledRowRenderSum += count;
        }
      }

      console.info(
        [
          `=== [Category 5A: React Streaming Tail Interaction (120 rounds, 10 chunks)] ===`,
          `Wall time                      : ${streamWallMs.toFixed(2)} ms (${(streamWallMs / streamChunks).toFixed(2)} ms/chunk)`,
          `VirtualMessageList commits     : ${renderTelemetry.virtualListCommits}`,
          `Active tail row renders        : ${activeRowRenderSum}`,
          `Settled row keys re-rendered   : ${settledRowKeysCount} keys (${settledRowRenderSum} total wasted renders)`,
        ].join('\n')
      );

      expect(renderTelemetry.virtualListCommits).toBeGreaterThan(0);
    });

    it('[bench:react-scroll] measures Virtualizer windowing commits & latency across 9 viewport scroll steps (120 rounds)', () => {
      const roundCount = 120;
      const baseSession = buildLongRoundSessionFixture({ roundCount });
      const activeTurnIndex = baseSession.dialogTurns.length - 1;
      const baseTurn = baseSession.dialogTurns[activeTurnIndex];

      harnessStoreState.session = baseSession;
      harnessStoreState.items = sessionToVirtualItems(baseSession);
      harnessStoreState.isProcessing = true;

      act(() => {
        root.render(<LiveContainerHarness latestTurnId={baseTurn.id} />);
      });
      flushResizeObservers();
      flushAnimationFrames();

      const scroller = host.querySelector<HTMLElement>('[data-flowchat-scroller]')!;
      const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      renderTelemetry.reset();

      const scrollSteps = 8;
      const tScrollStart = realHrTimeMs();
      for (let step = 0; step <= scrollSteps; step += 1) {
        now += 16;
        const targetTop = Math.round((maxScroll * (scrollSteps - step)) / scrollSteps);
        act(() => {
          scroller.scrollTop = targetTop;
          scroller.dispatchEvent(new Event('scroll'));
        });
        flushResizeObservers();
        flushAnimationFrames();
      }
      const scrollWallMs = realHrTimeMs() - tScrollStart;

      console.info(
        [
          `=== [Category 5B: Virtualizer Scroll Windowing (120 rounds, ${scrollSteps + 1} steps)] ===`,
          `Scroll distance                : ${maxScroll} px`,
          `Wall time                      : ${scrollWallMs.toFixed(2)} ms (${(scrollWallMs / (scrollSteps + 1)).toFixed(2)} ms/step)`,
          `VirtualMessageList commits     : ${renderTelemetry.virtualListCommits} (${(renderTelemetry.virtualListCommits / (scrollSteps + 1)).toFixed(1)} commits/step)`,
          `Total row mounts/renders       : ${[...renderTelemetry.rowRendersByKey.values()].reduce((a, b) => a + b, 0)}`,
        ].join('\n')
      );

      expect(renderTelemetry.virtualListCommits).toBeGreaterThan(0);
    });
  });

  describe('Category 6: End-to-End Combined Pipeline Summary [bench:e2e-pipeline]', () => {
    it('outputs combined 5-stage pipeline report across 10 -> 300 rounds', () => {
      const summary = runLongRoundPipelineBenchmark({
        checkpoints: [10, 50, 100, 200, 300],
        chunksPerCheckpoint: 5,
        measureRetainedBytesEveryFlush: true,
      });
      console.info('\n' + formatBenchmarkReport(summary));
      expect(summary.totalFlushes).toBe(20);
    });
  });
});
