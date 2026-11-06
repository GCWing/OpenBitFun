import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

type Drag = {
  id: string;
  startY: number;
  pointerY: number;
  pointerId: number;
  handle: HTMLButtonElement;
  order: string[];
  revision: string | number;
  before: string | null;
  scroller: HTMLElement;
  scrollTop: number;
  moved: boolean;
};

/** Pointer/keyboard presentation only. The caller owns authoritative ordering. */
export function useQueueReorder(ids: string[], enabled: boolean, revision: string | number,
  onMove: (id: string, beforeId: string | null) => void) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const focusAfterMove = useRef<string | null>(null);
  const [visual, setVisual] = useState<{ id: string; y: number; before: string | null } | null>(null);
  const identity = ids.join('\0');
  const latest = useRef({ enabled, revision, identity, onMove });
  latest.current = { enabled, revision, identity, onMove };

  const requestMove = (id: string, before: string | null) => {
    focusAfterMove.current = id;
    latest.current.onMove(id, before);
  };
  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const finish = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    stopFrame();
    setVisual(null);
    if (!current) return;
    if (current.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    const originalBefore = current.order[current.order.indexOf(current.id) + 1] ?? null;
    if (commit && current.moved && current.before !== originalBefore && latest.current.enabled
      && latest.current.revision === current.revision && latest.current.identity === current.order.join('\0')) {
      requestMove(current.id, current.before);
    }
  };
  useEffect(() => {
    finish(false);
    if (enabled && focusAfterMove.current) {
      const handle = rows.current.get(focusAfterMove.current)?.querySelector<HTMLButtonElement>('[data-queue-handle]');
      // Disabling controls during a host mutation can move focus to the body.
      // Restore the moved row, but do not interrupt a user who moved elsewhere.
      if (handle && !handle.disabled && (document.activeElement === document.body || document.activeElement === handle)) handle.focus();
      focusAfterMove.current = null;
    }
  }, [identity, enabled, revision]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); finish(false); }
    };
    const blur = () => finish(false);
    window.addEventListener('keydown', cancel);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', cancel);
      window.removeEventListener('blur', blur);
      const current = drag.current;
      drag.current = null;
      stopFrame();
      if (current?.handle.hasPointerCapture?.(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    };
  }, []);

  const paint = (current: Drag) => {
    current.before = current.order.find(id => {
      if (id === current.id) return false;
      const row = rows.current.get(id);
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      return current.pointerY < rect.top + rect.height / 2;
    }) ?? null;
    setVisual({ id: current.id, y: current.pointerY - current.startY + current.scroller.scrollTop - current.scrollTop, before: current.before });
  };
  const scrollFrame = () => {
    frame.current = null;
    const current = drag.current;
    if (!current?.moved) return;
    const bounds = current.scroller.getBoundingClientRect();
    const speed = current.pointerY < bounds.top + 24 ? -6 : current.pointerY > bounds.bottom - 24 ? 6 : 0;
    const previous = current.scroller.scrollTop;
    if (speed) current.scroller.scrollTop += speed;
    if (previous !== current.scroller.scrollTop) paint(current);
    if (speed) frame.current = requestAnimationFrame(scrollFrame);
  };
  const update = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.pointerY = event.clientY;
    current.moved ||= Math.abs(event.clientY - current.startY) > 4;
    if (!current.moved) return;
    paint(current);
    if (frame.current === null) frame.current = requestAnimationFrame(scrollFrame);
  };
  return {
    rowProps(id: string) {
      return {
        ref: (node: HTMLLIElement | null) => { if (node) rows.current.set(id, node); else rows.current.delete(id); },
        'data-queue-dragging': visual?.id === id || undefined,
        'data-queue-drop': visual && visual.id !== id && (visual.before === id ? 'before'
          : visual.before === null && id === ids.filter(value => value !== visual.id).slice(-1)[0] ? 'after' : undefined),
        style: visual?.id === id ? { transform: `translateY(${visual.y}px)` } as CSSProperties : undefined,
      };
    },
    handleProps(id: string) {
      return {
        'data-queue-handle': true,
        disabled: !enabled || ids.length < 2 || !ids.includes(id),
        onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
          if (!enabled || ids.length < 2 || !ids.includes(id) || event.button !== 0 || drag.current) return;
          const row = rows.current.get(id);
          if (!row?.parentElement) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id, startY: event.clientY, pointerY: event.clientY, pointerId: event.pointerId,
            handle: event.currentTarget, order: [...ids], revision, before: ids[ids.indexOf(id) + 1] ?? null,
            scroller: row.parentElement, scrollTop: row.parentElement.scrollTop, moved: false };
        },
        onPointerMove: update,
        onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => { if (drag.current?.pointerId === event.pointerId) finish(true); },
        onPointerCancel: () => finish(false),
        onLostPointerCapture: () => finish(false),
        onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
          if (!enabled || drag.current || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const index = ids.indexOf(id);
          if (event.key === 'ArrowUp' && index > 0) requestMove(id, ids[index - 1]!);
          if (event.key === 'ArrowDown' && index >= 0 && index < ids.length - 1) requestMove(id, ids[index + 2] ?? null);
        },
      };
    },
  };
}
