import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, IconButton } from '@openbitfun/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getMotionAwareScrollBehavior } from '@/shared/utils/motionPreference';
import './ProjectResourceCards.scss';

/** Home-style project directory strip. */
export function ProjectResourceCards({ label, previousLabel, nextLabel, resetKey, children }: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  resetKey: string;
  children: ReactNode;
}) {
  const trackId = useId();
  const trackRef = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, previous: false, next: false });
  const updateScroll = useCallback(() => {
    const track = trackRef.current;
    const max = track ? Math.max(0, track.scrollWidth - track.clientWidth) : 0;
    const left = track?.scrollLeft ?? 0;
    const overflow = !!track && track.clientWidth > 0 && max > 1;
    const next = { overflow, previous: overflow && left > 1, next: overflow && left < max - 1 };
    setScroll(current => current.overflow === next.overflow && current.previous === next.previous && current.next === next.next ? current : next);
  }, []);
  useLayoutEffect(() => {
    updateScroll();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(track);
    Array.from(track.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [resetKey, updateScroll]);
  useLayoutEffect(() => {
    if (trackRef.current) trackRef.current.scrollLeft = 0;
    updateScroll();
  }, [resetKey, updateScroll]);
  const scrollByCard = (direction: -1 | 1, animate: boolean) => {
    const track = trackRef.current;
    const first = track?.children[0] as HTMLElement | undefined;
    const second = track?.children[1] as HTMLElement | undefined;
    if (!track || !first) return;
    const step = second ? second.offsetLeft - first.offsetLeft : first.getBoundingClientRect().width;
    track.scrollTo({ left: Math.max(0, Math.min(track.scrollLeft + direction * step, track.scrollWidth - track.clientWidth)),
      behavior: getMotionAwareScrollBehavior(animate ? 'smooth' : 'auto') });
  };
  return <div className="project-resource-cards" role="region" aria-label={label}
    data-openbitfun-scene="project-resources" data-openbitfun-part="resourceCards">
    <ul className="project-resource-cards__track" id={trackId} ref={trackRef} onScroll={updateScroll}>
      {children}
    </ul>
    {scroll.overflow && <>
      <IconButton className="project-resource-cards__scroll-control project-resource-cards__scroll-control--previous" variant="fill" shape="circle" size="lg"
        aria-label={previousLabel} aria-controls={trackId} disabled={!scroll.previous}
        icon={<Icon glyph={ChevronLeft} />} onClick={event => scrollByCard(-1, event.detail > 0)} />
      <IconButton className="project-resource-cards__scroll-control project-resource-cards__scroll-control--next" variant="fill" shape="circle" size="lg"
        aria-label={nextLabel} aria-controls={trackId} disabled={!scroll.next}
        icon={<Icon glyph={ChevronRight} />} onClick={event => scrollByCard(1, event.detail > 0)} />
    </>}
  </div>;
}
