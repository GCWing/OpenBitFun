/**
 * Model thinking display component.
 * Ordinary reasoning defaults expanded while this is still the active last
 * step; reasoning summaries use their compact collapsed presentation by
 * default.
 * If the component mounts after later content already appeared
 * (for example after a parent remount), start collapsed directly
 * to avoid a visible expand-then-collapse flash.
 * Applies typewriter effect during streaming.
 */

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { OverflowText, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import type { FlowThinkingItem } from '../types/flow-chat';
import { useTypewriter } from '../hooks/useTypewriter';
import { useReportTypewriterReveal } from '../hooks/typewriterRevealGateContext';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import {
  nextEasedScrollTopPx,
  shouldEaseTailFollow,
} from '../utils/flowChatTailEase';
import {
  isTailFollowDiagnosticsEnabled,
  noteTailFollowStep,
} from '@/infrastructure/diagnostics/flowChatTailFollowDiagnostics';
import { latestReasoningSummaryPreview } from '../utils/reasoningSummaryPresentation';
import { MarkdownRenderer } from '@/infrastructure/markdown';
import './ModelThinkingDisplay.scss';

interface ModelThinkingDisplayProps {
  thinkingItem: FlowThinkingItem;
  /** Whether this is the last item in the current round. */
  isLastItem?: boolean;
  forceExpanded?: boolean;
  displayContext?: 'default' | 'subagent-projection';
}

export const ModelThinkingDisplay: React.FC<ModelThinkingDisplayProps> = ({
  thinkingItem,
  isLastItem = true,
  forceExpanded = false,
  displayContext = 'default',
}) => {
  const { t } = useTranslation('flow-chat');
  const { content, isStreaming, status } = thinkingItem;
  const isSummary = thinkingItem.reasoningKind === 'summary';
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowTailRef = useRef(true);
  const tailFollowPauseVersionRef = useRef(0);
  const tailFollowUserPauseUntilMsRef = useRef(0);
  /** Frame the follow has booked, and the sign that it is still travelling. */
  const tailFollowFrameRef = useRef<number | null>(null);
  const touchScrollStartYRef = useRef<number | null>(null);
  const lastScrollPositionRef = useRef<{
    top: number;
    height: number;
    viewport: number;
  } | null>(null);

  const isActive = isStreaming || status === 'streaming';
  const { displayText: displayContent, isRevealing } = useTypewriter(
    isSummary ? '' : content,
    isActive && !isSummary,
  );
  useReportTypewriterReveal(thinkingItem.id, isRevealing);
  const shouldDefaultExpanded = forceExpanded || (!isSummary && (
    displayContext === 'subagent-projection'
      ? isActive || isLastItem
      : isLastItem
  ));

  const [isExpanded, setIsExpanded] = useState(shouldDefaultExpanded);
  const [retainClosingContent, setRetainClosingContent] = useState(shouldDefaultExpanded);
  const expandContainerRef = useRef<HTMLDivElement>(null);
  const shouldMountContent = isExpanded || retainClosingContent;

  // Keep the existing collapse transition, but never build a hidden Markdown
  // tree on an initially collapsed virtual-row mount. Observe actual CSS
  // transitions so reduced motion and cancelled transitions also release it.
  useLayoutEffect(() => {
    if (isExpanded) {
      setRetainClosingContent(true);
      return;
    }
    if (!retainClosingContent) return;
    const transitions = expandContainerRef.current?.getAnimations?.().filter(animation => (
      'transitionProperty' in animation && animation.transitionProperty === 'grid-template-rows'
    )) ?? [];
    if (transitions.length === 0) {
      setRetainClosingContent(false);
      return;
    }
    let cancelled = false;
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (!cancelled) setRetainClosingContent(false);
    });
    return () => { cancelled = true; };
  }, [isExpanded, retainClosingContent]);
  const userToggledRef = useRef(false);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId: thinkingItem.id,
    toolName: 'thinking',
  });

  useLayoutEffect(() => {
    if (userToggledRef.current) return;
    if (isExpanded !== shouldDefaultExpanded) {
      applyExpandedState(isExpanded, shouldDefaultExpanded, setIsExpanded);
    }
  }, [applyExpandedState, isExpanded, shouldDefaultExpanded]);

  // Keep rendering the typewriter output while it drains after the stream
  // ends. Snapping to full `content` here would make the drain invisible
  // while `isRevealing` still holds the reveal gate, delaying the round
  // footer for no visible reason.
  const renderedContent = !isSummary && isRevealing ? displayContent : content;
  // Cover the whole reveal with Markdown streaming mode so the Prism upgrade
  // does not land mid-drain.
  const isVisuallyStreaming = isActive || isRevealing;

  const getThinkingScrollGap = useCallback((el: HTMLElement) => (
    el.scrollHeight - el.scrollTop - el.clientHeight
  ), []);

  const stopTailFollow = useCallback(() => {
    if (tailFollowFrameRef.current === null) return;
    cancelAnimationFrame(tailFollowFrameRef.current);
    tailFollowFrameRef.current = null;
  }, []);

  const pauseTailFollowForUserScroll = useCallback(() => {
    shouldFollowTailRef.current = false;
    tailFollowPauseVersionRef.current += 1;
    tailFollowUserPauseUntilMsRef.current = performance.now() + 700;
    stopTailFollow();
  }, [stopTailFollow]);

  const recordScrollPosition = useCallback((el: HTMLElement) => {
    lastScrollPositionRef.current = {
      top: el.scrollTop,
      height: el.scrollHeight,
      viewport: el.clientHeight,
    };
  }, []);

  const detectUpwardScroll = useCallback((el: HTMLElement) => {
    const previous = lastScrollPositionRef.current;
    // Scrollbar drags have no wheel/key event. Compare with our last actual
    // offset, allowing rounding noise and excluding layout-driven movement.
    const movedUp = isExpanded && previous !== null &&
      el.scrollHeight >= previous.height &&
      el.clientHeight === previous.viewport &&
      el.scrollTop < previous.top - 1;
    recordScrollPosition(el);
    if (movedUp) pauseTailFollowForUserScroll();
    return movedUp;
  }, [isExpanded, pauseTailFollowForUserScroll, recordScrollPosition]);

  useLayoutEffect(() => {
    lastScrollPositionRef.current = null;
  }, [isExpanded]);

  /**
   * Follow the tail across the frames it is given, rather than in one write.
   *
   * The card's box stops growing at its `max-height` and everything after that
   * happens inside it, so this moves a scroll offset and no layout outside the
   * card — which is why it can afford to run every frame where the message list
   * cannot. Below that height it snaps, because easing there would mean easing
   * a height and charging the virtualizer for each step.
   *
   * The pause version is captured for the whole run: a reader who scrolls up
   * mid-follow bumps it, and the next frame stands down rather than dragging
   * them back. A call arriving while a run is in flight is ignored — the run
   * re-reads its target every frame and has already seen what prompted it.
   */
  const scheduleTailFollow = useCallback((expectedPauseVersion: number) => {
    if (tailFollowFrameRef.current !== null) return;

    const runFrame = () => {
      tailFollowFrameRef.current = null;
      const el = contentRef.current;
      if (!el) return;
      // The browser may update the offset before delivering its scroll event.
      if (detectUpwardScroll(el)) return;
      if (expectedPauseVersion !== tailFollowPauseVersionRef.current) return;
      if (!shouldFollowTailRef.current) return;

      const beforePx = el.scrollTop;
      const targetPx = el.scrollHeight - el.clientHeight;
      const step = shouldEaseTailFollow({
        scrollHeightPx: el.scrollHeight,
        clientHeightPx: el.clientHeight,
      })
        ? nextEasedScrollTopPx(beforePx, targetPx)
        : { offsetPx: targetPx, outcome: 'snapped' as const };

      el.scrollTop = step.offsetPx;
      recordScrollPosition(el);
      // Read back rather than taken from the step: the browser clamps to the
      // scrollable range, and a platform without fractional scroll offsets
      // rounds the last part of an ease away entirely. Believing the step there
      // would book frames forever over a fraction of a pixel nobody can see.
      const movedPx = el.scrollTop - beforePx;
      shouldFollowTailRef.current = true;
      if (step.outcome === 'eased' && movedPx !== 0) {
        tailFollowFrameRef.current = requestAnimationFrame(runFrame);
      }

      if (isTailFollowDiagnosticsEnabled()) {
        noteTailFollowStep('thinking', {
          stepPx: movedPx,
          lagPx: targetPx - beforePx,
          // Below the card's `max-height` the box is still growing, so each of
          // these steps also costs the list a re-measure. Above it, none do.
          innerScroll: el.scrollHeight > el.clientHeight,
          snapped: step.outcome === 'snapped',
        });
      }
    };

    tailFollowFrameRef.current = requestAnimationFrame(runFrame);
  }, [detectUpwardScroll, recordScrollPosition]);

  /** A follow in flight outlives neither the card nor its collapse. */
  useEffect(() => stopTailFollow, [isExpanded, stopTailFollow]);

  // Auto-scroll to bottom while content grows.
  useEffect(() => {
    if (isExpanded && contentRef.current) {
      const el = contentRef.current;
      const gap = getThinkingScrollGap(el);
      const wasNearBottom = gap < 20;
      const userPauseActive = performance.now() <= tailFollowUserPauseUntilMsRef.current;
      if (wasNearBottom && !userPauseActive) {
        shouldFollowTailRef.current = true;
      }
      const shouldScroll = shouldFollowTailRef.current || (wasNearBottom && !userPauseActive);
      if (shouldScroll) {
        scheduleTailFollow(tailFollowPauseVersionRef.current);
      }
    }
  }, [
    displayContent,
    getThinkingScrollGap,
    isExpanded,
    scheduleTailFollow,
  ]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || !isExpanded) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (isActive && shouldFollowTailRef.current) {
        scheduleTailFollow(tailFollowPauseVersionRef.current);
      }
    });

    observer.observe(el);
    const markdownEl = el.querySelector('.thinking-markdown');
    if (markdownEl instanceof HTMLElement) {
      observer.observe(markdownEl);
    }

    return () => observer.disconnect();
  }, [isActive, isExpanded, scheduleTailFollow]);

  // Scroll-state detection for fade gradients.
  const [scrollState, setScrollState] = useState({ hasScroll: false, atTop: true, atBottom: true });

  const checkScrollState = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    detectUpwardScroll(el);
    const gap = getThinkingScrollGap(el);
    const nextScrollState = {
      hasScroll: el.scrollHeight > el.clientHeight,
      atTop: el.scrollTop <= 5,
      /**
       * A follow still travelling counts as being at the bottom.
       *
       * The bottom fade means "there is more below that you have not seen". An
       * eased follow rides a little behind the tail by design, and what it is
       * behind is arriving on its own — fading that would put a gradient under
       * every streaming thinking card, which is the opposite of what the fade
       * is for.
       */
      atBottom: gap <= 5 || tailFollowFrameRef.current !== null,
    };
    if (
      nextScrollState.atBottom &&
      performance.now() > tailFollowUserPauseUntilMsRef.current
    ) {
      shouldFollowTailRef.current = true;
    }
    // Scroll events arrive every frame once the follow is eased, and each one
    // that changes nothing would still re-render the card.
    setScrollState((current) => (
      current.hasScroll === nextScrollState.hasScroll &&
      current.atTop === nextScrollState.atTop &&
      current.atBottom === nextScrollState.atBottom
        ? current
        : {
          hasScroll: nextScrollState.hasScroll,
          atTop: nextScrollState.atTop,
          atBottom: nextScrollState.atBottom,
        }
    ));
  }, [detectUpwardScroll, getThinkingScrollGap]);

  useEffect(() => {
    if (isExpanded) {
      const timer = setTimeout(checkScrollState, 50);
      return () => clearTimeout(timer);
    }
  }, [isExpanded, checkScrollState]);

  const contentLengthText = useMemo(() => {
    if (!content || content.length === 0) return t('toolCards.think.thinkingComplete');
    return t('toolCards.think.thinkingCharacters', { count: content.length });
  }, [content, t]);

  const summaryPreview = useMemo(
    () => latestReasoningSummaryPreview(content),
    [content],
  );

  const handleToggleClick = () => {
    const nextExpanded = !isExpanded;
    userToggledRef.current = true;
    applyExpandedState(isExpanded, nextExpanded, setIsExpanded);
  };

  const handleContentWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      pauseTailFollowForUserScroll();
    }
  }, [pauseTailFollowForUserScroll]);

  const handleContentTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchScrollStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleContentTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchScrollStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) {
      return;
    }

    if (currentY - startY > 6) {
      touchScrollStartYRef.current = currentY;
      pauseTailFollowForUserScroll();
    }
  }, [pauseTailFollowForUserScroll]);

  const handleContentTouchEnd = useCallback(() => {
    touchScrollStartYRef.current = null;
  }, []);

  const handleContentKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === 'ArrowUp' ||
      event.key === 'PageUp' ||
      event.key === 'Home' ||
      (event.key === ' ' && event.shiftKey)
    ) {
      pauseTailFollowForUserScroll();
    }
  }, [pauseTailFollowForUserScroll]);

  const headerLabel = isSummary
    ? (isExpanded
      ? t('toolCards.think.thinkingSummary')
      : summaryPreview || t('toolCards.think.thinkingSummary'))
    : (isExpanded
      ? (isActive ? t('toolCards.think.thinking') : t('toolCards.think.thinkingProcess'))
      : contentLengthText).replace(/ /g, '\u00A0');

  const wrapperClassName = [
    'flow-thinking-item',
    isSummary ? 'summary' : 'reasoning',
    isExpanded ? 'expanded' : 'collapsed',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={cardRootRef}
      data-testid="chat-thinking-panel"
      data-tool-card-id={thinkingItem.id}
      data-status={status}
      data-streaming={isActive ? 'true' : 'false'}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-reasoning-kind={thinkingItem.reasoningKind ?? 'reasoning'}
      className={wrapperClassName}
     data-openbitfun-component="model-thinking-display" data-openbitfun-part="root" data-openbitfun-context={displayContext} data-openbitfun-state={[isExpanded && 'expanded', isVisuallyStreaming && 'streaming'].filter(Boolean).join(' ')}>
      <div data-overflow-trigger
        data-openbitfun-component="model-thinking-display"
        data-openbitfun-part="header"
        data-testid="chat-thinking-toggle"
        className="thinking-collapsed-header"
        onClick={handleToggleClick}
      >
        <span
          aria-hidden="true"
          className="thinking-leading-icon"
          data-openbitfun-component="model-thinking-display"
          data-openbitfun-part="leadingIcon"
        >
          <Icon name="thinking" size="sm" className="thinking-leading-icon__default" />
          <Icon name="chevron-right" size="sm" className="thinking-leading-icon__collapsed-hover" />
          <Icon name="chevron-down" size="sm" className="thinking-leading-icon__expanded" />
        </span>
        <OverflowText
          data-openbitfun-component="model-thinking-display"
          data-openbitfun-part="label"
          className="thinking-label"
          title={isSummary && !isExpanded ? headerLabel : undefined}
        >
          {headerLabel}
        </OverflowText>
      </div>

      <div
        ref={expandContainerRef}
        className={[
          'thinking-expand-container',
          isExpanded ? 'thinking-expand-container--open' : '',
        ].filter(Boolean).join(' ')}
        data-openbitfun-component="model-thinking-display"
        data-openbitfun-part="expandContainer"
      >
        {shouldMountContent && <div className={`thinking-content-wrapper ${scrollState.hasScroll ? 'has-scroll' : ''} ${scrollState.atTop ? 'at-top' : ''} ${scrollState.atBottom ? 'at-bottom' : ''}`} data-openbitfun-component="model-thinking-display" data-openbitfun-part="contentWrapper">
          <div
            ref={contentRef}
            data-openbitfun-component="model-thinking-display"
            data-openbitfun-part="content"
            data-testid="chat-thinking-content"
            data-status={status}
            data-streaming={isActive ? 'true' : 'false'}
            className={`thinking-content expanded`}
            onScroll={checkScrollState}
            onWheelCapture={handleContentWheelCapture}
            onTouchStart={handleContentTouchStart}
            onTouchMove={handleContentTouchMove}
            onTouchEnd={handleContentTouchEnd}
            onKeyDown={handleContentKeyDown}
          >
            <MarkdownRenderer
              content={renderedContent}
              isStreaming={isVisuallyStreaming}
              className="thinking-markdown"
            />
          </div>
        </div>}
      </div>
    </div>
  );
};
