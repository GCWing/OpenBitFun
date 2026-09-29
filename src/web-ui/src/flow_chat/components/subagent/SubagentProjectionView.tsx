import { useFlowChatVirtualizer } from '../modern/useFlowChatVirtualizer';
import { useFlowChatViewportOwner } from '../modern/useFlowChatViewportOwner';
import { estimateFlowItemHeight } from '../modern/virtualItemHeightEstimators';
import { FlowChatReaderProvider, useFlowChatReaderScope, useFlowChatReaderValue } from '../../timeline/readerState';
import { useEmbeddedTimelineFollow } from '../../timeline/useEmbeddedTimelineFollow';
import { useTimelineInteraction } from '../../timeline/useTimelineInteraction';
import { TimelineMutationBoundary } from '../../timeline/TimelineMutationBoundary';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { AnyFlowItem } from '../../types/flow-chat';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import type { FlowChatState, FlowItem, FlowTextItem, FlowThinkingItem, FlowToolItem } from '../../types/flow-chat';
import { FlowTextBlock } from '../FlowTextBlock';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import { FlowToolCard } from '../FlowToolCard';
import { FlowChatStore } from '../../store/FlowChatStore';
import { getSubagentProjectionState } from '../../utils/subagentProjection';
import { isFlowItemVisible } from '../../utils/flowItemVisibility';
import { ensureBtwSessionAvailable } from '../../services/btwSessionPane';
import { RuntimeStatusSlot } from '../modern/RuntimeStatusSlot';
import { useRuntimeStatusStore } from '../../store/runtimeStatusStore';
import './SubagentProjectionView.scss';

interface SubagentProjectionViewProps {
  parentTaskToolId: string;
  parentToolIds?: Set<string>;
  parentSessionId?: string;
  directSubagentSessionId?: string;
  directSubagentDialogTurnId?: string;
  subagentSessionId?: string;
  items?: FlowItem[];
  turnId?: string;
  sessionId?: string;
  className?: string;
  compactText?: boolean;
  liveItemsMode?: 'full-turn' | 'last-round';
}

const SUBAGENT_TEXT_TRUNCATE_LINES = 50;

const SubagentProjectionTextBlock = React.memo<{ textItem: FlowTextItem; className?: string }>(({ textItem, className = '' }) => {
  const [isExpanded, setIsExpanded] = useFlowChatReaderValue<boolean>(`text:${textItem.id}:expanded`, false);
  const { t } = useTranslation('flow-chat');

  const content = typeof textItem.content === 'string'
    ? textItem.content
    : String(textItem.content || '');

  const isStreaming = textItem.isStreaming &&
    (textItem.status === 'streaming' || textItem.status === 'running');

  const lines = content.split('\n');
  const shouldTruncate = !isStreaming && !isExpanded && lines.length > SUBAGENT_TEXT_TRUNCATE_LINES;

  if (!shouldTruncate) {
    return (
      <FlowTextBlock
        textItem={textItem}
        className={className}
        replayStreamingOnMount={false}
      />
    );
  }

  const truncatedItem: FlowTextItem = {
    ...textItem,
    content: lines.slice(0, SUBAGENT_TEXT_TRUNCATE_LINES).join('\n'),
    isStreaming: false,
  };

  return (
    <div data-openbitfun-component="subagent-projection" data-openbitfun-part="truncated" className="subagent-projection-text--truncated" data-thinking-continuation="">
      <FlowTextBlock
        textItem={truncatedItem}
        className={className}
        replayStreamingOnMount={false}
      />
      <div data-openbitfun-component="subagent-projection" data-openbitfun-part="hint" className="subagent-projection-text__hint">
        <span data-openbitfun-component="subagent-projection" data-openbitfun-part="message" className="subagent-projection-text__message">
          {t('subagent.showingLines', { shown: SUBAGENT_TEXT_TRUNCATE_LINES, total: lines.length })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="subagent-projection-text__expand-btn"
          onClick={() => setIsExpanded(true)}
        >
          {t('subagent.showAll')}
        </Button>
      </div>
    </div>
  );
});

function renderProjectedItem(
  item: FlowItem,
  sessionId: string | undefined,
  turnId: string | undefined,
  compactText: boolean,
  isLastVisibleItem: boolean,
  thinkingSessionId?: string,
): React.ReactNode {
  switch (item.type) {
    case 'text':
      return (
        <SubagentProjectionTextBlock
          key={item.id}
          textItem={item as FlowTextItem}
          className={compactText ? 'flow-text-block--subagent-compact' : ''}
        />
      );
    case 'thinking':
      return (
        <ModelThinkingDisplay
          key={item.id}
          thinkingItem={item as FlowThinkingItem}
          isLastItem={isLastVisibleItem}
          displayContext="subagent-projection"
          sourceSessionId={thinkingSessionId}
        />
      );
    case 'tool':
      return (
        <div data-openbitfun-component="subagent-projection" data-openbitfun-part="item" key={item.id} className="flowchat-flow-item" data-thinking-continuation="" data-flow-item-id={item.id} data-flow-item-type="tool">
          <FlowToolCard
            toolItem={item as FlowToolItem}
            sessionId={sessionId}
            turnId={turnId}
            displayContext="subagent-projection"
            isLastItem={isLastVisibleItem}
          />
        </div>
      );
    default:
      return null;
  }
}

export const SubagentProjectionView: React.FC<SubagentProjectionViewProps> = ({
  parentTaskToolId,
  parentToolIds,
  parentSessionId,
  directSubagentSessionId,
  directSubagentDialogTurnId,
  subagentSessionId,
  items: itemsProp,
  turnId,
  sessionId,
  className = '',
  compactText = true,
  liveItemsMode = 'last-round',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const viewportOwner = useFlowChatViewportOwner(containerRef);
  const lastScrollTopRef = useRef(0);
  const [projectionState, setProjectionState] = useState(() => {
    if (!parentToolIds || parentToolIds.size === 0) {
      return null;
    }

    return getSubagentProjectionState(
      FlowChatStore.getInstance().getState(),
      {
        parentSessionId,
        parentToolIds,
        directSubagentSessionId,
        directSubagentDialogTurnId,
      },
      { itemsMode: liveItemsMode },
    );
  });

  useEffect(() => {
    if (!parentToolIds || parentToolIds.size === 0) {
      setProjectionState(null);
      return;
    }

    const flowChatStore = FlowChatStore.getInstance();

    const readProjectionState = (state: FlowChatState) => {
      return getSubagentProjectionState(
        state,
        {
          parentSessionId,
          parentToolIds,
          directSubagentSessionId,
          directSubagentDialogTurnId,
        },
        { itemsMode: liveItemsMode },
      );
    };

    let previous = readProjectionState(flowChatStore.getState());
    setProjectionState(previous);

    const unsubscribe = flowChatStore.subscribe((state) => {
      const next = readProjectionState(state);
      if (
        previous?.session === next.session &&
        previous?.turn === next.turn &&
        previous?.round === next.round &&
        previous?.items === next.items &&
        previous?.isRunning === next.isRunning
      ) {
        return;
      }
      previous = next;
      setProjectionState(next);
    });

    return unsubscribe;
  }, [directSubagentDialogTurnId, directSubagentSessionId, liveItemsMode, parentSessionId, parentToolIds]);

  const liveItems = useMemo(
    () => itemsProp ?? projectionState?.items ?? [],
    [itemsProp, projectionState]
  );
  const resolvedSubagentSessionId = subagentSessionId
    ?? projectionState?.session?.sessionId
    ?? directSubagentSessionId;
  const items = useMemo(() => liveItems.filter(isFlowItemVisible), [liveItems]);
  const runtimeStatus = useRuntimeStatusStore(state => (
    resolvedSubagentSessionId
      ? state.bySessionId.get(resolvedSubagentSessionId)
      : undefined
  ));

  useEffect(() => {
    if (!resolvedSubagentSessionId || itemsProp !== undefined) {
      return;
    }

    const flowChatStore = FlowChatStore.getInstance();
    const state = flowChatStore.getState();
    const session = state.sessions.get(resolvedSubagentSessionId);
    const ownerSessionId = parentSessionId ?? sessionId;

    const shouldEnsureSession =
      !session ||
      (
        session.isHistorical &&
        (session.historyState === 'metadata-only' || session.historyState === 'failed')
      );

    if (!shouldEnsureSession) {
      return;
    }

    if (!ownerSessionId) {
      return;
    }

    ensureBtwSessionAvailable({
      childSessionId: resolvedSubagentSessionId,
      parentSessionId: ownerSessionId,
      workspacePath: state.sessions.get(ownerSessionId)?.workspacePath,
      sessionKind: 'subagent',
      parentToolCallId: parentToolIds?.values().next().value,
      remoteConnectionId: state.sessions.get(ownerSessionId)?.remoteConnectionId,
      remoteSshHost: state.sessions.get(ownerSessionId)?.remoteSshHost,
      includeInternal: true,
    });
  }, [items.length, itemsProp, parentSessionId, parentToolIds, resolvedSubagentSessionId, sessionId]);

  const shouldRenderProjection =
    Boolean(resolvedSubagentSessionId) &&
    (items.length > 0 || projectionState?.isRunning === true || Boolean(runtimeStatus));

  // Tail position, not active status, controls live completion retention.
  // Otherwise a newer settled action can collapse while an older item still
  // carries a stale active status.
  const lastVisibleItemId = items[items.length - 1]?.id;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const currentScrollTop = container.scrollTop;
      const maxScrollTop = container.scrollHeight - container.clientHeight;

      if (currentScrollTop < lastScrollTopRef.current && maxScrollTop > 0) {
        if (lastScrollTopRef.current - currentScrollTop > 20) {
          followRef.current = false;
          viewportOwner.release('follow-output');
        }
      }

      if (maxScrollTop > 0 && maxScrollTop - currentScrollTop < 30) {
        followRef.current = true;
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [shouldRenderProjection, viewportOwner]);

  // Chunk the recorded sequence before hiding failed/empty items. Visibility
  // changes must not reparent surviving cards (or destroy their focus/selection).
  // Never cut a thought from the following item used by its side annotation.
  const runs = useMemo(() => {
    const result: FlowItem[][] = [];
    let run: FlowItem[] = [];
    for (const item of liveItems) {
      run.push(item);
      if (run.length >= 8 && item.type !== 'thinking') { result.push(run); run = []; }
    }
    if (run.length) result.push(run);
    return result;
  }, [liveItems]);
  const reader = useFlowChatReaderScope(`${getActiveSurfaceScope().epoch}:subagent:${resolvedSubagentSessionId}:${parentTaskToolId}`);
  const cancelAimRef = useRef<() => void>(() => {});
  const pinnedKeys = useTimelineInteraction(containerRef, reader, () => followRef.current, '.subagent-projection-run[data-virtual-item-key]', () => {
    followRef.current = false; viewportOwner.release('follow-output'); cancelAimRef.current();
  });
  const virtualizer = useFlowChatVirtualizer({
    pinnedKeys,
    items: runs, scrollerRef: containerRef, headerRef,
    getItemKey: run => run[0].id,
    estimateItemHeightPx: run => run.reduce((height, item) => height + (isFlowItemVisible(item) ? estimateFlowItemHeight(item as AnyFlowItem).heightPx : 0), 0),
    scrollPaddingStartPx: 0, startAtTailOnMount: true,
    writeViewport: viewportOwner.write, shiftViewport: viewportOwner.shift,
  });
  cancelAimRef.current = virtualizer.cancelAim;
  useEmbeddedTimelineFollow({ scrollerRef: containerRef, contentRef, followRef, viewportOwner,
    revision: shouldRenderProjection ? items : null, cancelAim: virtualizer.cancelAim });

  if (!shouldRenderProjection) {
    return null;
  }

  return (
    <FlowChatReaderProvider store={reader}>
    <div data-openbitfun-component="subagent-projection" data-openbitfun-part="root" data-openbitfun-state="expanded"
      className={`subagent-projection-wrapper ${className}`.trim()}
      data-subagent-session-id={resolvedSubagentSessionId}
    >
      <div
        ref={containerRef}
        data-openbitfun-component="subagent-projection"
        data-openbitfun-part="container"
        className="subagent-projection-container subagent-projection-container--expanded"
        data-parent-tool-id={parentTaskToolId}
      >
        <TimelineMutationBoundary itemKeys={runs.map(run => run[0].id)} scrollerRef={containerRef}
          canRepair={() => !followRef.current && viewportOwner.canShift()} shift={viewportOwner.shift}
          rowSelector=".subagent-projection-run">
        <div ref={contentRef} style={{ paddingTop: virtualizer.paddingTopPx, paddingBottom: virtualizer.paddingBottomPx }} data-openbitfun-component="subagent-projection" data-openbitfun-part="content" className="subagent-projection-content" data-flow-item-stack="">
          {virtualizer.rows.map((row, index) => <React.Fragment key={row.key}>
            {index > 0 && row.startPx > virtualizer.rows[index - 1].endPx && <div aria-hidden="true" style={{ height: row.startPx - virtualizer.rows[index - 1].endPx }} />}
            <div ref={virtualizer.measureRowElement} data-virtual-index={row.index} data-virtual-item-key={row.key}
            className="subagent-projection-run" data-flow-item-stack="">
            {runs[row.index].filter(isFlowItemVisible).map(item => renderProjectedItem(
            item,
            sessionId ?? resolvedSubagentSessionId,
            turnId,
            compactText,
            item.id === lastVisibleItemId,
            resolvedSubagentSessionId,
          ))}</div></React.Fragment>)}
          <RuntimeStatusSlot sessionId={resolvedSubagentSessionId} />
        </div>
        </TimelineMutationBoundary>
      </div>
    </div>
    </FlowChatReaderProvider>
  );
};

export default SubagentProjectionView;
