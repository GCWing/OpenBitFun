import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { nextEasedScrollTopPx, shouldEaseTailFollow } from './tailEase';

const REVEAL_RANGE_EVENT = 'openbitfun-contained-range-reveal';

/** Reveal nested text without ever moving the transcript viewport or the page. */
export function revealContainedRange(range: Range, boundary: HTMLElement): void {
  let element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  while (element && element !== boundary && boundary.contains(element)) {
    if (element instanceof HTMLElement && element.clientHeight > 0 && element.scrollHeight > element.clientHeight
      && /auto|scroll/.test(getComputedStyle(element).overflowY)) {
      element.dispatchEvent(new Event(REVEAL_RANGE_EVENT));
      const rect = Array.from(range.getClientRects()).find(line => line.height > 0 && line.width > 0);
      const box = element.getBoundingClientRect();
      if (rect && (rect.top < box.top || rect.bottom > box.top + element.clientHeight)) {
        element.scrollTop += (rect.top + rect.bottom) / 2 - box.top - element.clientHeight / 2;
      }
    }
    element = element.parentElement;
  }
}

export interface ContainedTailFollowStep {
  stepPx: number;
  lagPx: number;
  innerScroll: boolean;
  snapped: boolean;
}

/** Only the bounded inner viewport moves. Hosts own execution and disclosure. */
export function useContainedTailFollow({ enabled: isExpanded, active: isActive, contentVersion: displayContent, followOnOpen = true, onUserPause, onStep }: {
  enabled: boolean;
  active: boolean;
  contentVersion: unknown;
  followOnOpen?: boolean;
  onUserPause?: () => void;
  onStep?: (step: ContainedTailFollowStep) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const onUserPauseRef = useRef(onUserPause);
  const onStepRef = useRef(onStep);
  const followOnOpenRef = useRef(followOnOpen);
  onUserPauseRef.current = onUserPause;
  onStepRef.current = onStep;
  followOnOpenRef.current = followOnOpen;
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

  const getScrollGap = useCallback((el: HTMLElement) => (
    el.scrollHeight - el.scrollTop - el.clientHeight
  ), []);

  const stopTailFollow = useCallback(() => {
    if (tailFollowFrameRef.current === null) return;
    cancelAnimationFrame(tailFollowFrameRef.current);
    tailFollowFrameRef.current = null;
  }, []);

  const pauseTailFollowForUserScroll = useCallback(() => {
    if (!isExpanded) return;
    onUserPauseRef.current?.();
    shouldFollowTailRef.current = false;
    tailFollowPauseVersionRef.current += 1;
    tailFollowUserPauseUntilMsRef.current = performance.now() + 700;
    stopTailFollow();
  }, [isExpanded, stopTailFollow]);

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
    shouldFollowTailRef.current = followOnOpenRef.current;
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

      onStepRef.current?.({
        stepPx: movedPx, lagPx: targetPx - beforePx,
        innerScroll: el.scrollHeight > el.clientHeight,
        snapped: step.outcome === 'snapped',
      });
    };

    tailFollowFrameRef.current = requestAnimationFrame(runFrame);
  }, [detectUpwardScroll, recordScrollPosition]);

  /** An explicit return to the live preview releases a reader's earlier pause. */
  const resume = useCallback(() => {
    stopTailFollow();
    shouldFollowTailRef.current = true;
    tailFollowPauseVersionRef.current += 1;
    tailFollowUserPauseUntilMsRef.current = 0;
    lastScrollPositionRef.current = null;
    if (isExpanded && contentRef.current) scheduleTailFollow(tailFollowPauseVersionRef.current);
  }, [isExpanded, scheduleTailFollow, stopTailFollow]);

  /** A follow in flight outlives neither the card nor its collapse. */
  useEffect(() => stopTailFollow, [isExpanded, stopTailFollow]);

  // Auto-scroll to bottom while content grows.
  useEffect(() => {
    if (isExpanded && contentRef.current) {
      const el = contentRef.current;
      const gap = getScrollGap(el);
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
    getScrollGap,
    isExpanded,
    scheduleTailFollow,
  ]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || !isExpanded) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      if (isActive && shouldFollowTailRef.current) scheduleTailFollow(tailFollowPauseVersionRef.current);
    });
    const observe = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(el);
      Array.from(el.children).forEach(child => resizeObserver.observe(child));
      if (isActive && shouldFollowTailRef.current) scheduleTailFollow(tailFollowPauseVersionRef.current);
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(el, { childList: true });
    observe();
    return () => { resizeObserver.disconnect(); mutations.disconnect(); };
  }, [isActive, isExpanded, scheduleTailFollow]);

  // Scroll-state detection for fade gradients.
  const [scrollState, setScrollState] = useState({ hasScroll: false, atTop: true, atBottom: true });

  const checkScrollState = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    detectUpwardScroll(el);
    const gap = getScrollGap(el);
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
  }, [detectUpwardScroll, getScrollGap]);

  useEffect(() => {
    if (isExpanded) {
      const timer = setTimeout(checkScrollState, 50);
      return () => clearTimeout(timer);
    }
  }, [isExpanded, checkScrollState]);

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

  useEffect(() => {
    if (!isExpanded) return;
    const document = contentRef.current?.ownerDocument;
    const onSelection = () => {
      const selection = document?.getSelection();
      if (selection && !selection.isCollapsed && contentRef.current?.contains(selection.anchorNode)) {
        pauseTailFollowForUserScroll();
      }
    };
    document?.addEventListener('selectionchange', onSelection);
    return () => document?.removeEventListener('selectionchange', onSelection);
  }, [isExpanded, pauseTailFollowForUserScroll]);

  useEffect(() => {
    const element = contentRef.current;
    element?.addEventListener(REVEAL_RANGE_EVENT, pauseTailFollowForUserScroll);
    return () => element?.removeEventListener(REVEAL_RANGE_EVENT, pauseTailFollowForUserScroll);
  }, [isExpanded, pauseTailFollowForUserScroll]);

  return {
    contentRef, scrollState, pause: pauseTailFollowForUserScroll, resume,
    contentProps: {
      onScroll: checkScrollState, onWheelCapture: handleContentWheelCapture,
      onTouchStart: handleContentTouchStart, onTouchMove: handleContentTouchMove,
      onTouchEnd: handleContentTouchEnd, onKeyDown: handleContentKeyDown,
    },
  };
}

export * from './tailEase';
