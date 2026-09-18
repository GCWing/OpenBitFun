import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  computeFixedPopoverPositionInViewport,
  DEFAULT_POPOVER_VIEWPORT_PADDING,
  type FixedPopoverPlacement,
} from './fixedPopoverViewport';

export type AnchoredPopoverAlignment = 'start' | 'end';

export interface AnchoredPopoverLayout {
  top: number;
  left: number;
  /** Prefer this edge for top placement so content can grow away from the anchor. */
  bottom?: number;
  width?: number;
  placement: FixedPopoverPlacement;
}

interface UseAnchoredPopoverPositionOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  preferredPlacement?: FixedPopoverPlacement;
  alignment?: AnchoredPopoverAlignment;
  gap?: number;
  padding?: number;
  matchAnchorWidth?: boolean;
  /** Re-measure after content that can change the popover dimensions updates. */
  layoutRevision?: unknown;
}

const sameLayout = (
  current: AnchoredPopoverLayout | null,
  next: AnchoredPopoverLayout,
): boolean => current !== null
  && current.top === next.top
  && current.left === next.left
  && current.bottom === next.bottom
  && current.width === next.width
  && current.placement === next.placement;

const resolvePlacement = (
  top: number,
  height: number,
  anchorRect: DOMRect,
  preferredPlacement: FixedPopoverPlacement,
): FixedPopoverPlacement => {
  if (top + height <= anchorRect.top) return 'top';
  if (top >= anchorRect.bottom) return 'bottom';
  return preferredPlacement;
};

/**
 * Keeps a portalled popover attached to its trigger while escaping ancestor
 * clipping. Position is refreshed for nested scrolling, viewport resize and
 * content/anchor resize, and is clamped to the visible viewport.
 */
export function useAnchoredPopoverPosition({
  open,
  anchorRef,
  popoverRef,
  preferredPlacement = 'bottom',
  alignment = 'start',
  gap = 6,
  padding = DEFAULT_POPOVER_VIEWPORT_PADDING,
  matchAnchorWidth = false,
  layoutRevision,
}: UseAnchoredPopoverPositionOptions): AnchoredPopoverLayout | null {
  const [layout, setLayout] = useState<AnchoredPopoverLayout | null>(null);
  const frameRef = useRef<number | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover || typeof window === 'undefined') return;

    const anchorRect = anchor.getBoundingClientRect();
    const availableWidth = Math.max(0, window.innerWidth - padding * 2);
    const matchedWidth = matchAnchorWidth
      ? Math.min(anchorRect.width, availableWidth)
      : undefined;

    if (matchedWidth !== undefined) {
      popover.style.width = `${matchedWidth}px`;
    }

    const popoverRect = popover.getBoundingClientRect();
    const popoverWidth = popoverRect.width
      || popover.offsetWidth
      || matchedWidth
      || popover.scrollWidth;
    const popoverHeight = popoverRect.height
      || popover.offsetHeight
      || popover.scrollHeight;
    const preferredLeft = alignment === 'end'
      ? anchorRect.right - popoverWidth
      : anchorRect.left;
    const position = computeFixedPopoverPositionInViewport(
      {
        left: preferredLeft,
        top: anchorRect.top,
        bottom: anchorRect.bottom,
      },
      popoverWidth,
      popoverHeight,
      { width: window.innerWidth, height: window.innerHeight },
      { gap, padding, preferredPlacement },
    );
    const placement = resolvePlacement(
      position.top,
      popoverHeight,
      anchorRect,
      preferredPlacement,
    );
    const nextLayout: AnchoredPopoverLayout = {
      ...position,
      bottom: placement === 'top' ? window.innerHeight - position.top - popoverHeight : undefined,
      width: matchedWidth,
      placement,
    };

    setLayout(current => sameLayout(current, nextLayout) ? current : nextLayout);
  }, [
    alignment,
    anchorRef,
    gap,
    matchAnchorWidth,
    padding,
    popoverRef,
    preferredPlacement,
  ]);

  const schedulePositionUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(current => current === null ? current : null);
      return;
    }

    updatePosition();
    window.addEventListener('resize', schedulePositionUpdate, { passive: true });
    window.addEventListener('scroll', schedulePositionUpdate, {
      capture: true,
      passive: true,
    });

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedulePositionUpdate);
    if (anchorRef.current) resizeObserver?.observe(anchorRef.current);
    if (popoverRef.current) resizeObserver?.observe(popoverRef.current);

    return () => {
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', schedulePositionUpdate, { capture: true });
      resizeObserver?.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [anchorRef, open, popoverRef, schedulePositionUpdate, updatePosition]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [layoutRevision, open, updatePosition]);

  return layout;
}
