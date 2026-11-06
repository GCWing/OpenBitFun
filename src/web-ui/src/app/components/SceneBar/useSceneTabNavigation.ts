import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import type { InteractionMotion } from '@/shared/utils/motionPreference';
import type { SceneTabId } from './types';

const SCROLL_EDGE_EPSILON = 1;
const MIN_SCROLL_STEP = 160;

interface TabScrollState {
  hasOverflow: boolean;
  canScrollBackward: boolean;
  canScrollForward: boolean;
}

interface UseSceneTabNavigationOptions {
  activeTabId: SceneTabId | null;
  navigationMotion: InteractionMotion;
  openTabIds: readonly SceneTabId[];
}

const INITIAL_TAB_SCROLL_STATE: TabScrollState = {
  hasOverflow: false,
  canScrollBackward: false,
  canScrollForward: false,
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Owns tab-strip overflow and keyboard behavior without leaking those layout
 * details into the scene lifecycle store.
 */
export function useSceneTabNavigation({
  activeTabId,
  navigationMotion,
  openTabIds,
}: UseSceneTabNavigationOptions) {
  const tabOrderKey = openTabIds.join('\u0000');
  const tabRegionRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pendingRevealRef = useRef<{ id: SceneTabId; behavior: ScrollBehavior; target?: number } | null>(null);
  const [scrollState, setScrollState] = useState<TabScrollState>(INITIAL_TAB_SCROLL_STATE);

  const getTabElements = useCallback((): HTMLElement[] => {
    const tabs = tabsRef.current;
    if (!tabs) return [];
    return Array.from(tabs.querySelectorAll<HTMLElement>('[role="tab"]'));
  }, []);

  const updateScrollState = useCallback(() => {
    const tabs = tabsRef.current;
    const region = tabRegionRef.current;
    if (!tabs || !region) return;

    const maxScrollLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const hasOverflow = region.clientWidth > 0
      && tabs.scrollWidth > region.clientWidth + SCROLL_EDGE_EPSILON;
    const nextState: TabScrollState = {
      hasOverflow,
      canScrollBackward: hasOverflow && tabs.scrollLeft > SCROLL_EDGE_EPSILON,
      canScrollForward: hasOverflow
        && tabs.scrollLeft < maxScrollLeft - SCROLL_EDGE_EPSILON,
    };

    setScrollState((current) => (
      current.hasOverflow === nextState.hasOverflow
        && current.canScrollBackward === nextState.canScrollBackward
        && current.canScrollForward === nextState.canScrollForward
        ? current
        : nextState
    ));
  }, []);

  const scrollTo = useCallback((left: number, behavior: ScrollBehavior) => {
    const tabs = tabsRef.current;
    if (!tabs) return;

    const maxScrollLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const nextLeft = Math.max(0, Math.min(left, maxScrollLeft));
    if (Math.abs(nextLeft - tabs.scrollLeft) <= SCROLL_EDGE_EPSILON) return nextLeft;

    if (typeof tabs.scrollTo === 'function') {
      tabs.scrollTo({ left: nextLeft, behavior });
    } else {
      tabs.scrollLeft = nextLeft;
      updateScrollState();
    }
    return nextLeft;
  }, [updateScrollState]);

  const revealPendingTab = useCallback(() => {
    const pending = pendingRevealRef.current;
    if (!pending) return;
    const tabs = tabsRef.current;
    const activeTab = getTabElements().find(tab => tab.dataset.openbitfunValue === pending.id);
    const activeItem = activeTab?.closest<HTMLElement>('[data-openbitfun-part="item"]') ?? activeTab;
    if (!tabs || !activeItem) { pendingRevealRef.current = null; return; }

    const visibleStart = tabs.scrollLeft;
    const visibleEnd = visibleStart + tabs.clientWidth;
    // TabGroup's item is nested in a positioned, draggable SceneBar wrapper.
    // Its offsetLeft belongs to that wrapper, not this scroll viewport.
    const itemRect = activeItem.getBoundingClientRect();
    const tabStart = visibleStart + itemRect.left - tabs.getBoundingClientRect().left - tabs.clientLeft;
    const tabEnd = tabStart + itemRect.width;
    let nextLeft = visibleStart;

    if (tabStart < visibleStart) {
      nextLeft = tabStart;
    } else if (tabEnd > visibleEnd) {
      nextLeft = tabEnd - tabs.clientWidth;
    }

    const target = Math.max(0, Math.min(nextLeft, tabs.scrollWidth - tabs.clientWidth));
    if (Math.abs(target - visibleStart) <= SCROLL_EDGE_EPSILON) {
      pendingRevealRef.current = null;
      return;
    }
    // Showing an edge control changes the available width. Retarget only for
    // changed geometry, not for each intermediate smooth-scroll position.
    if (pending.target === undefined || Math.abs(target - pending.target) > SCROLL_EDGE_EPSILON) {
      pending.target = scrollTo(target, pending.behavior);
    }
    // A tab wider than the viewport cannot show both edges; keep the original
    // one-shot alignment instead of alternating between its edges.
    if (itemRect.width > tabs.clientWidth) pendingRevealRef.current = null;
  }, [getTabElements, scrollTo]);

  const observePendingReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    const observer = resizeObserverRef.current;
    if (!pending || !observer) return false;
    const tab = getTabElements().find(tab => tab.dataset.openbitfunValue === pending.id);
    const item = tab?.closest<HTMLElement>('[data-openbitfun-part="item"]') ?? tab;
    if (!item) return false;
    // Re-observing delivers after layout even when the selected size is unchanged.
    observer.unobserve(item);
    observer.observe(item);
    return true;
  }, [getTabElements]);

  useLayoutEffect(() => {
    updateScrollState();

    if (typeof ResizeObserver === 'undefined') return;
    const region = tabRegionRef.current;
    const tabs = tabsRef.current;
    if (!region || !tabs) return;

    const observer = new ResizeObserver(() => {
      revealPendingTab();
      updateScrollState();
    });
    resizeObserverRef.current = observer;
    observer.observe(region);
    observer.observe(tabs);
    getTabElements().forEach((tab) => {
      observer.observe(tab.closest<HTMLElement>('[data-openbitfun-part="item"]') ?? tab);
    });
    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
      pendingRevealRef.current = null;
    };
  }, [getTabElements, revealPendingTab, tabOrderKey, updateScrollState]);

  useLayoutEffect(() => {
    pendingRevealRef.current = activeTabId ? {
      id: activeTabId,
      behavior: navigationMotion === 'pointer' && !prefersReducedMotion() ? 'smooth' : 'auto',
    } : null;
    // Preserve the immediate activation measurement. Resize delivery only
    // finishes an in-flight reveal when edge controls change the viewport.
    revealPendingTab();
    if (!resizeObserverRef.current) pendingRevealRef.current = null;
    updateScrollState();
  }, [activeTabId, navigationMotion, revealPendingTab, tabOrderKey, updateScrollState]);

  const handleScroll = useCallback(() => {
    updateScrollState();
    // Finish a reveal after any edge-control layout update. Wheel/page commands
    // release this request, so subsequent resizes cannot reclaim manual scroll.
    observePendingReveal();
  }, [observePendingReveal, updateScrollState]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const tabs = tabsRef.current;
    if (!tabs || !scrollState.hasOverflow) return;
    if (event.deltaX || event.deltaY) pendingRevealRef.current = null;

    // Preserve native horizontal trackpad movement. A vertical mouse wheel is
    // translated only while the pointer is over the tab strip.
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const maxScrollLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const nextLeft = Math.max(0, Math.min(tabs.scrollLeft + event.deltaY, maxScrollLeft));
    if (Math.abs(nextLeft - tabs.scrollLeft) <= SCROLL_EDGE_EPSILON) return;

    event.preventDefault();
    tabs.scrollLeft = nextLeft;
    updateScrollState();
  }, [scrollState.hasOverflow, updateScrollState]);

  const scrollByPage = useCallback((direction: -1 | 1) => {
    pendingRevealRef.current = null;
    const tabs = tabsRef.current;
    if (!tabs) return;
    const step = Math.max(MIN_SCROLL_STEP, tabs.clientWidth * 0.72);
    scrollTo(
      tabs.scrollLeft + direction * step,
      prefersReducedMotion() ? 'auto' : 'smooth',
    );
  }, [scrollTo]);

  return {
    tabRegionRef,
    tabsRef,
    scrollState,
    handleScroll,
    handleWheel,
    scrollByPage,
  };
}
