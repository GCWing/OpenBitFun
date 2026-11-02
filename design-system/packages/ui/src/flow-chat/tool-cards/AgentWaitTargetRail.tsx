import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton/IconButton';
import { ToolCardParticipantLabel } from './ToolCardInteraction';
import styles from './AgentWaitTargetRail.module.css';

export interface AgentWaitTargets {
  items: readonly {
    id: string;
    name: string;
    avatar: ReactNode;
    openLabel: string;
    onOpen?: (event: MouseEvent<HTMLButtonElement>) => void;
  }[];
  previousLabel: string;
  nextLabel: string;
}

/** Shared overflow and keyboard anatomy; hosts own identity, artwork and navigation. */
export function AgentWaitTargetRail({ items, previousLabel, nextLabel }: AgentWaitTargets) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, previous: false, next: false });
  const updateScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const end = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const overflow = viewport.clientWidth > 0 && end > 1;
    const value = { overflow, previous: overflow && viewport.scrollLeft > 1, next: overflow && viewport.scrollLeft < end - 1 };
    setScroll(current => current.overflow === value.overflow && current.previous === value.previous && current.next === value.next ? current : value);
  }, []);

  useLayoutEffect(() => {
    updateScroll();
    if (typeof ResizeObserver === 'undefined' || !viewportRef.current || !trackRef.current) return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(viewportRef.current);
    observer.observe(trackRef.current);
    return () => observer.disconnect();
  }, [items.length, updateScroll]);

  const scrollPage = (direction: -1 | 1, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const step = Math.max(32, viewport.clientWidth * 0.72);
    const left = Math.max(0, Math.min(viewport.scrollLeft + direction * step, viewport.scrollWidth - viewport.clientWidth));
    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ left, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else {
      viewport.scrollLeft = left;
      updateScroll();
    }
  };

  return <span className={styles.root} role="group" aria-label={items.map(item => item.name).join(', ')} data-openbitfun-part="agentWaitAvatars">
    {scroll.overflow && <IconButton variant="quiet" size="sm" className={styles.scrollButton}
      data-agent-wait-scroll="previous" icon={<Icon name="chevron-left" size="sm" />}
      aria-label={previousLabel} title={previousLabel} disabled={!scroll.previous} onClick={event => scrollPage(-1, event)} />}
    <span className={styles.viewport} ref={viewportRef} onScroll={updateScroll} data-openbitfun-part="agentWaitAvatarViewport">
      <span className={styles.track} ref={trackRef}>
        {items.map(item => <button key={item.id} type="button" className={styles.target} disabled={!item.onOpen}
          data-agent-capsule-trigger={item.onOpen ? 'true' : undefined} data-openbitfun-part="agentWaitAvatarTrigger"
          data-openbitfun-affordance={item.onOpen ? 'open-panel-right' : undefined}
          data-overflow-trigger aria-label={item.onOpen ? `${item.name} · ${item.openLabel}` : item.name}
          onClick={event => { event.stopPropagation(); item.onOpen?.(event); }}>
          <ToolCardParticipantLabel label={item.name} icon={item.avatar} />
        </button>)}
      </span>
    </span>
    {scroll.overflow && <IconButton variant="quiet" size="sm" className={styles.scrollButton}
      data-agent-wait-scroll="next" icon={<Icon name="chevron-right" size="sm" />}
      aria-label={nextLabel} title={nextLabel} disabled={!scroll.next} onClick={event => scrollPage(1, event)} />}
  </span>;
}
