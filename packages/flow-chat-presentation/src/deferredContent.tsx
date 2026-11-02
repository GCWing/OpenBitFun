import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';

export interface DeferredContentSegment {
  key: string;
  memberIds: readonly string[];
  estimatedHeightPx: number;
  eager: boolean;
  hidden?: boolean;
  render: () => ReactNode;
}

interface SegmentHandle {
  memberIds: readonly string[];
  request: (memberId?: string) => boolean;
}

const handles = new WeakMap<HTMLElement, SegmentHandle>();

/** Materialize only the requested source; callers retry DOM lookup after commit. */
export function requestDeferredContentItem(boundary: HTMLElement, itemId: string | undefined): boolean {
  if (!itemId) return false;
  for (const element of boundary.querySelectorAll<HTMLElement>('[data-deferred-content]')) {
    const handle = handles.get(element);
    if (handle?.memberIds.includes(itemId)) return handle.request(itemId);
  }
  return false;
}

interface DeferredContentProps {
  segments: readonly DeferredContentSegment[];
  /** Omit to use the document viewport, including clipping by ancestor scrollers. */
  viewportRef?: RefObject<HTMLElement | null>;
  segmentClassName: string;
  label: string;
  /** Return true when navigation changed a host filter; callers wait for commit. */
  onRevealItem?: (memberId: string) => boolean;
}

/**
 * Defer unvisited content, then retain it for this disclosure's lifetime.
 * Unlike recycling rows, scrolling cannot reset a card, focus or text selection.
 * Hosts own semantic boundaries, estimates, live work and initial head/tail choice.
 */
export function DeferredContent({ segments, viewportRef, segmentClassName, label, onRevealItem }: DeferredContentProps) {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pendingRef = useRef(new Set<HTMLElement>());
  const observe = useCallback((element: HTMLElement) => {
    pendingRef.current.add(element);
    observerRef.current?.observe(element);
    return () => {
      pendingRef.current.delete(element);
      observerRef.current?.unobserve(element);
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef?.current ?? null;
    if ((viewportRef && !viewport) || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) handles.get(entry.target as HTMLElement)?.request();
      }
    }, { root: viewport, rootMargin: '300px 0px' });
    observerRef.current = observer;
    pendingRef.current.forEach(element => observer.observe(element));
    return () => { observer.disconnect(); observerRef.current = null; };
  }, [viewportRef]);

  return <Fragment>{segments.map(segment => <DeferredSegment key={segment.key}
    segment={segment} observe={observe} className={segmentClassName} label={label} onRevealItem={onRevealItem} />)}</Fragment>;
}

function DeferredSegment({ segment, observe, className, label, onRevealItem }: {
  segment: DeferredContentSegment;
  observe: (element: HTMLElement) => () => void;
  className: string;
  label: string;
  onRevealItem?: (memberId: string) => boolean;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState(() => !segment.hidden && (segment.eager || typeof IntersectionObserver === 'undefined'));
  const rendered = visited || (!segment.hidden && (segment.eager || typeof IntersectionObserver === 'undefined'));
  // Live work becoming settled must not unmount its ongoing reveal or controls.
  useLayoutEffect(() => { if (rendered) setVisited(true); }, [rendered]);
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    handles.set(element, {
      memberIds: segment.memberIds,
      request: memberId => {
        // An intersection delivery can already be queued when a filter hides us.
        if (!memberId && segment.hidden) return false;
        const revealed = memberId ? onRevealItem?.(memberId) === true : false;
        if (!rendered) setVisited(true);
        return revealed || !rendered;
      },
    });
    const stop = rendered || segment.hidden ? undefined : observe(element);
    return () => { stop?.(); handles.delete(element); };
  }, [observe, rendered, segment.memberIds, segment.hidden, onRevealItem]);

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (rendered || event.target !== event.currentTarget) return;
    const element = event.currentTarget;
    const backward = event.relatedTarget instanceof Node
      && Boolean(element.compareDocumentPosition(event.relatedTarget) & Node.DOCUMENT_POSITION_FOLLOWING);
    // The placeholder participates in Tab order. Replace it before continuing
    // into the real controls, including Shift+Tab entering from below the group.
    flushSync(() => setVisited(true));
    const controls = Array.from(element.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    )).filter(control => control.tabIndex >= 0
      && !control.matches(':disabled')
      && !control.closest('[inert], [hidden], [aria-hidden="true"]'));
    (backward ? controls.at(-1) : controls[0])?.focus({ preventScroll: true });
  };

  return <div ref={elementRef} className={className} hidden={segment.hidden} data-deferred-content={rendered ? 'ready' : 'pending'}
    style={rendered ? undefined : { height: segment.estimatedHeightPx }}
    tabIndex={rendered ? -1 : 0} aria-label={rendered ? undefined : label} onFocus={onFocus}>
    {rendered ? segment.render() : null}
  </div>;
}
