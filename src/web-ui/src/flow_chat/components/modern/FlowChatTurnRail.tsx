import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@openbitfun/ui';
import type { TurnRailCapsulePreview } from '@/shared/types/session-history';
import { MessageReferenceCapsule } from './MessageReferenceCapsule';
import { observeElementResize } from '@/shared/utils/sharedResizeObserver';
import {
  FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX,
  FLOWCHAT_TURN_RAIL_VERTICAL_PADDING_PX,
  getFlowChatTurnRailScrollTopForOrdinal,
  getFlowChatTurnRailTotalHeight,
  getFlowChatTurnRailWindowRange,
} from './flowChatTurnRailWindow';
import './FlowChatTurnRail.scss';

export interface FlowChatTurnRailItem {
  itemKey: string;
  turnId: string | null;
  ordinal: number;
  turnIndex: number;
  content: string | null;
  capsulePreview?: TurnRailCapsulePreview;
}

interface FlowChatTurnRailProps {
  turns: readonly FlowChatTurnRailItem[];
  currentTurnId: string | null;
  visibleTurnIds: readonly string[];
  onNavigate: (turn: FlowChatTurnRailItem) => void;
}

interface FlowChatTurnRailViewportMetrics {
  scrollTop: number;
  clientHeight: number;
}

/**
 * Memoized: its parent re-renders on every streamed flush, while the rail's
 * inputs change only with Turn identity, the visible Turn, or navigation.
 */
export const FlowChatTurnRail = React.memo(function FlowChatTurnRail({
  turns,
  currentTurnId,
  visibleTurnIds,
  onNavigate,
}: FlowChatTurnRailProps) {
  const { t } = useTranslation('flow-chat');
  const railRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());
  const pendingFocusOrdinalRef = useRef<number | null>(null);
  const currentTurnOrdinal = useMemo(
    () => turns.find(turn => turn.turnId === currentTurnId)?.ordinal ?? null,
    [currentTurnId, turns],
  );
  const totalOrdinalCount = useMemo(() => turns.reduce(
    (count, turn) => Math.max(count, turn.ordinal + 1),
    turns.length,
  ), [turns]);
  const turnByOrdinal = useMemo(
    () => new Map(turns.map(turn => [turn.ordinal, turn])),
    [turns],
  );
  const turnArrayIndexByOrdinal = useMemo(
    () => new Map(turns.map((turn, index) => [turn.ordinal, index])),
    [turns],
  );
  const initialFocusOrdinal = currentTurnOrdinal ?? turns[0]?.ordinal ?? null;
  const [focusOrdinal, setFocusOrdinal] = useState<number | null>(initialFocusOrdinal);
  const [hoverOrdinal, setHoverOrdinal] = useState<number | null>(null);
  const [viewportMetrics, setViewportMetrics] = useState<FlowChatTurnRailViewportMetrics>(() => ({
    scrollTop: initialFocusOrdinal === null
      ? 0
      : initialFocusOrdinal * FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX,
    clientHeight: FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX,
  }));
  const visibleTurnIdSet = useMemo(() => new Set(visibleTurnIds), [visibleTurnIds]);
  const renderedRange = useMemo(() => getFlowChatTurnRailWindowRange({
    ...viewportMetrics,
    totalOrdinalCount,
  }), [totalOrdinalCount, viewportMetrics]);
  const renderedTurns = useMemo(() => {
    const windowTurns: FlowChatTurnRailItem[] = [];
    for (
      let ordinal = renderedRange.startOrdinal;
      ordinal < renderedRange.endOrdinalExclusive;
      ordinal += 1
    ) {
      const turn = turnByOrdinal.get(ordinal);
      if (turn) {
        windowTurns.push(turn);
      }
    }
    return windowTurns;
  }, [renderedRange.endOrdinalExclusive, renderedRange.startOrdinal, turnByOrdinal]);
  const hoveredTurnOrdinal = hoverOrdinal !== null
    && renderedTurns.some(turn => turn.ordinal === hoverOrdinal)
    ? hoverOrdinal
    : null;
  const tabStopOrdinal = focusOrdinal !== null
    && focusOrdinal >= renderedRange.startOrdinal
    && focusOrdinal < renderedRange.endOrdinalExclusive
    && turnByOrdinal.has(focusOrdinal)
    ? focusOrdinal
    : renderedTurns[0]?.ordinal ?? null;

  const updateViewportMetrics = useCallback((list: HTMLDivElement) => {
    if (list.clientHeight <= 0) {
      return;
    }
    const nextMetrics = {
      scrollTop: list.scrollTop,
      clientHeight: list.clientHeight,
    };
    setViewportMetrics(previous => (
      previous.scrollTop === nextMetrics.scrollTop
      && previous.clientHeight === nextMetrics.clientHeight
        ? previous
        : nextMetrics
    ));
  }, []);

  const scrollOrdinalIntoView = useCallback((ordinal: number) => {
    const list = listRef.current;
    if (!list || list.clientHeight <= 0) {
      return;
    }

    const nextScrollTop = getFlowChatTurnRailScrollTopForOrdinal({
      ordinal,
      currentScrollTop: list.scrollTop,
      clientHeight: list.clientHeight,
      totalOrdinalCount,
    });
    if (nextScrollTop !== list.scrollTop) {
      list.scrollTop = nextScrollTop;
    }
    updateViewportMetrics(list);
  }, [totalOrdinalCount, updateViewportMetrics]);

  useEffect(() => {
    const focusOrdinalStillExists = focusOrdinal !== null && turnByOrdinal.has(focusOrdinal);
    if (!focusOrdinalStillExists) {
      setFocusOrdinal(currentTurnOrdinal ?? turns[0]?.ordinal ?? null);
      return;
    }

    if (
      currentTurnOrdinal !== null
      && railRef.current
      && !railRef.current.contains(document.activeElement)
    ) {
      setFocusOrdinal(currentTurnOrdinal);
    }
  }, [currentTurnOrdinal, focusOrdinal, turnByOrdinal, turns]);

  const keepCurrentTurnVisible = useCallback(() => {
    if (currentTurnOrdinal === null) {
      return;
    }
    scrollOrdinalIntoView(currentTurnOrdinal);
  }, [currentTurnOrdinal, scrollOrdinalIntoView]);

  useLayoutEffect(() => {
    keepCurrentTurnVisible();
  }, [keepCurrentTurnVisible, turns.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    updateViewportMetrics(list);
    return observeElementResize(list, () => {
      keepCurrentTurnVisible();
      updateViewportMetrics(list);
    });
  }, [keepCurrentTurnVisible, updateViewportMetrics]);

  const focusTurnAt = useCallback((index: number) => {
    const turn = turns[index];
    if (!turn) return;

    pendingFocusOrdinalRef.current = turn.ordinal;
    setFocusOrdinal(turn.ordinal);
    scrollOrdinalIntoView(turn.ordinal);
    const renderedItem = itemRefs.current.get(turn.ordinal);
    if (renderedItem) {
      renderedItem.focus();
      pendingFocusOrdinalRef.current = null;
    }
  }, [scrollOrdinalIntoView, turns]);

  useLayoutEffect(() => {
    const pendingFocusOrdinal = pendingFocusOrdinalRef.current;
    if (pendingFocusOrdinal === null || pendingFocusOrdinal !== focusOrdinal) {
      return;
    }

    const item = itemRefs.current.get(pendingFocusOrdinal);
    if (!item) {
      return;
    }
    item.focus();
    pendingFocusOrdinalRef.current = null;
  }, [focusOrdinal, renderedRange.endOrdinalExclusive, renderedRange.startOrdinal]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent, index: number) => {
    let nextIndex: number | null = null;

    switch (event.key) {
      case 'ArrowUp':
        nextIndex = Math.max(0, index - 1);
        break;
      case 'ArrowDown':
        nextIndex = Math.min(turns.length - 1, index + 1);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = turns.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusTurnAt(nextIndex);
  }, [focusTurnAt, turns.length]);

  const handleScroll = useCallback(() => {
    // Scrolling can replace the marker underneath a stationary pointer.
    setHoverOrdinal(null);
    const list = listRef.current;
    if (list) {
      updateViewportMetrics(list);
    }
  }, [updateViewportMetrics]);

  const handlePointerHover = useCallback((event: React.PointerEvent, ordinal: number) => {
    if (event.pointerType !== 'touch') setHoverOrdinal(ordinal);
  }, []);

  if (turns.length === 0) return null;

  const navigationLabel = t('flowChatTurnRail.label');
  const untitledTurnLabel = t('flowChatTurnRail.untitledTurn');

  return (
    <nav
      ref={railRef}
      className="flowchat-turn-rail"
      data-openbitfun-component="flow-chat-turn-rail"
      data-openbitfun-part="root"
      aria-label={navigationLabel}
      data-testid="flowchat-turn-rail"
      data-rendered-start-ordinal={renderedRange.startOrdinal}
      data-rendered-end-ordinal={renderedRange.endOrdinalExclusive}
      data-total-turn-count={totalOrdinalCount}
      data-hovering={hoveredTurnOrdinal !== null ? 'true' : undefined}
    >
      <div
        ref={listRef}
        className="flowchat-turn-rail__list"
        data-openbitfun-component="flow-chat-turn-rail"
        data-openbitfun-part="list"
        onScroll={handleScroll}
      >
        <div
          className="flowchat-turn-rail__track"
          style={{ height: `${getFlowChatTurnRailTotalHeight(totalOrdinalCount)}px` }}
        >
          {renderedTurns.map(turn => {
            const turnArrayIndex = turnArrayIndexByOrdinal.get(turn.ordinal) ?? 0;
            const isCurrent = turn.turnId !== null && turn.turnId === currentTurnId;
            const isVisible = turn.turnId !== null && visibleTurnIdSet.has(turn.turnId);
            const hoverDistance = hoveredTurnOrdinal === null
              ? null
              : Math.abs(turn.ordinal - hoveredTurnOrdinal);
            const turnLabel = t('flowChatHeader.turnBadge', { current: turn.turnIndex });
            const content = turn.content === null
              ? null
              : turn.content.trim() || untitledTurnLabel;
            const capsulePreview = turn.capsulePreview;

            return (
              <Tooltip
                key={turn.itemKey}
                placement="right"
                delay={250}
                interactive
                trigger="hover-focus"
                className="flowchat-turn-rail__tooltip"
                content={(
                  <span className="flowchat-turn-rail__tooltip-content" data-openbitfun-component="flow-chat-turn-rail" data-openbitfun-part="tooltipContent">
                    <span className="flowchat-turn-rail__tooltip-turn" data-openbitfun-component="flow-chat-turn-rail" data-openbitfun-part="tooltipTurn">{turnLabel}</span>
                    {capsulePreview ? (
                      <span className="flowchat-turn-rail__tooltip-message" data-openbitfun-component="flow-chat-turn-rail" data-openbitfun-part="tooltipMessage">
                        {capsulePreview.segments.map((segment, index) => segment.kind === 'text' ? (
                          <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>
                        ) : segment.kind === 'inlineToken' ? (
                          <MessageReferenceCapsule
                            key={`token-${index}`}
                            type={segment.tokenType}
                            label={segment.label}
                          />
                        ) : (
                          <MessageReferenceCapsule
                            key={`context-${index}`}
                            type={segment.contextType}
                            label={segment.label}
                            title={segment.title}
                          />
                        ))}
                      </span>
                    ) : content !== null ? (
                      <span className="flowchat-turn-rail__tooltip-message" data-openbitfun-component="flow-chat-turn-rail" data-openbitfun-part="tooltipMessage">{content}</span>
                    ) : null}
                  </span>
                )}
              >
                <button
                  ref={(node) => {
                    if (node) {
                      itemRefs.current.set(turn.ordinal, node);
                    } else {
                      itemRefs.current.delete(turn.ordinal);
                    }
                  }}
                  type="button"
                  className={`flowchat-turn-rail__item${isVisible ? ' flowchat-turn-rail__item--visible' : ''}`}
                  data-openbitfun-component="flow-chat-turn-rail"
                  data-openbitfun-part="item"
                  data-openbitfun-state={[isCurrent && 'current', isVisible && 'visible'].filter(Boolean).join(' ')}
                  style={{
                    top: `${FLOWCHAT_TURN_RAIL_VERTICAL_PADDING_PX + turn.ordinal * FLOWCHAT_TURN_RAIL_ROW_HEIGHT_PX}px`,
                  }}
                  aria-label={turnLabel}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-posinset={turn.ordinal + 1}
                  aria-setsize={totalOrdinalCount}
                  tabIndex={turn.ordinal === tabStopOrdinal ? 0 : -1}
                  data-turn-id={turn.turnId ?? undefined}
                  data-turn-key={turn.itemKey}
                  data-turn-index={turn.turnIndex}
                  data-turn-ordinal={turn.ordinal}
                  data-hover-distance={hoverDistance !== null && hoverDistance <= 3 ? hoverDistance : undefined}
                  onClick={() => {
                    onNavigate(turn);
                  }}
                  onFocus={() => setFocusOrdinal(turn.ordinal)}
                  onPointerEnter={event => handlePointerHover(event, turn.ordinal)}
                  onPointerMove={event => handlePointerHover(event, turn.ordinal)}
                  onPointerLeave={() => setHoverOrdinal(null)}
                  onPointerCancel={() => setHoverOrdinal(null)}
                  onKeyDown={(event) => handleKeyDown(event, turnArrayIndex)}
                >
                  <span className="flowchat-turn-rail__bar" data-openbitfun-component="flow-chat-turn-rail" data-openbitfun-part="bar" aria-hidden="true" />
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </nav>
  );
});

FlowChatTurnRail.displayName = 'FlowChatTurnRail';
