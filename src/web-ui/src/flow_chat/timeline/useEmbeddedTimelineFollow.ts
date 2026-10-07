import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type { FlowChatViewportOwnerApi } from '../components/modern/useFlowChatViewportOwner';

/** Compact desktop panes use the same registered, gesture-cancellable tail writer. */
export function useEmbeddedTimelineFollow({ scrollerRef, contentRef, followRef, viewportOwner, revision, cancelAim }: {
  scrollerRef: RefObject<HTMLElement | null>; contentRef: RefObject<HTMLElement | null>;
  followRef: MutableRefObject<boolean>; viewportOwner: FlowChatViewportOwnerApi;
  revision: unknown; cancelAim: () => void;
}) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let frame = 0;
    const hasSelection = () => {
      const selection = window.getSelection();
      return Boolean(selection && !selection.isCollapsed && (
        scroller.contains(selection.anchorNode) || scroller.contains(selection.focusNode)
      ));
    };
    const pause = () => {
      cancelAim(); followRef.current = false; viewportOwner.release('follow-output');
    };
    const selectionChanged = () => { if (hasSelection()) pause(); };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followRef.current && !hasSelection() && scroller.clientHeight > 0 && !document.hidden) {
          viewportOwner.write({ owner: 'follow-output', topPx: scroller.scrollHeight, holdForMs: 0 });
        }
      });
    };
    const wheel = (event: WheelEvent) => {
      cancelAim();
      if (event.deltaY < 0) pause();
    };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) {
        pause();
      }
    };
    const observer = new ResizeObserver(follow);
    observer.observe(content); observer.observe(scroller);
    scroller.addEventListener('wheel', wheel, { passive: true });
    scroller.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', follow);
    document.addEventListener('selectionchange', selectionChanged);
    follow();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      scroller.removeEventListener('wheel', wheel); scroller.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', follow);
      document.removeEventListener('selectionchange', selectionChanged);
    };
  }, [scrollerRef, contentRef, followRef, viewportOwner, revision, cancelAim]);
}
