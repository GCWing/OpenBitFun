import { useEffect, useRef } from 'react';
import { VirtualCursor } from './VirtualCursor';

/** Feedback has no transport or input callback. Its hot spot is independent of native coordinates. */
export function PreviewCursor({ x, y, immediate = false }: { x: number; y: number; immediate?: boolean }) {
  const element = useRef<HTMLSpanElement>(null);
  const state = useRef<{ cursor: VirtualCursor; sequence: number; frame: number; last: number; reduced: boolean; width: number; height: number }>();
  const point = useRef({ x, y, immediate }); point.current = { x, y, immediate };
  const update = useRef<() => void>();
  useEffect(() => {
    const span = element.current, parent = span?.parentElement;
    if (!span || !parent) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const s = { cursor: new VirtualCursor(Math.max(parent.clientWidth, 1), Math.max(parent.clientHeight, 1)), sequence: 0,
      frame: 0, last: 0, reduced: query.matches, width: parent.clientWidth, height: parent.clientHeight };
    state.current = s;
    const render = () => {
      const position = s.cursor.position(), visual = s.cursor.visual();
      span.style.opacity = String(visual.opacity);
      span.style.filter = `blur(${visual.blur}px)`;
      span.style.transform = `translate3d(${position.x - 4.8}px,${position.y - 4.8}px,0) rotate(${visual.axisRotation}deg) scale(1,${visual.axisScale}) rotate(${-visual.axisRotation}deg) rotate(${visual.rotation + 44}deg) scale(${visual.scaleX},${visual.scaleY})`;
    };
    const tick = (now: number) => {
      s.frame = 0;
      // RAF callbacks share a frame timestamp. A React retarget earlier in
      // this frame can already have advanced past that timestamp.
      s.cursor.advance(Math.max(0, now - s.last) / 1000); s.last = Math.max(s.last, now);
      s.cursor.takeArrival(); render();
      if (!s.reduced && s.cursor.needsAnimation()) s.frame = requestAnimationFrame(tick);
    };
    const move = () => {
      // Retarget from the currently displayed time, even between RAF callbacks.
      const now = performance.now();
      if (s.frame) s.cursor.advance(Math.max(0, now - s.last) / 1000);
      s.last = now;
      s.cursor.moveTo({ x: point.current.x * s.width, y: point.current.y * s.height }, ++s.sequence, !s.reduced && !point.current.immediate);
      s.cursor.takeArrival(); render();
      if (s.reduced || point.current.immediate || !s.cursor.needsAnimation()) {
        cancelAnimationFrame(s.frame); s.frame = 0;
      } else if (!s.frame) s.frame = requestAnimationFrame(tick);
    };
    update.current = move;
    const resize = new ResizeObserver(() => {
      const width = parent.clientWidth, height = parent.clientHeight;
      if (width <= 0 || height <= 0 || (width === s.width && height === s.height)) return;
      s.width = width; s.height = height;
      s.cursor.resize(width, height); move();
    });
    const motionChanged = () => { s.reduced = query.matches; if (s.reduced) { cancelAnimationFrame(s.frame); s.frame = 0; } move(); };
    query.addEventListener('change', motionChanged); resize.observe(parent); move();
    return () => { resize.disconnect(); query.removeEventListener('change', motionChanged); cancelAnimationFrame(s.frame); state.current = undefined; update.current = undefined; };
  }, []);
  useEffect(() => { update.current?.(); }, [x, y, immediate]);
  return <span ref={element} className="computer-control-card__pointer computer-control-card__pointer--physical"
    data-openbitfun-component="computer-control" data-openbitfun-part="pointer" aria-hidden="true">
    <svg viewBox="0 0 40 40" focusable="false"><path transform="translate(8 8) scale(0.7) translate(-8 -8)" vectorEffect="non-scaling-stroke" d="M8 8 C6 10 7 12 8 15 L14 31 C15.5 35 19 35 20.5 31.5 L23 26 C23.6 24.5 24.5 23.6 26 23 L31.5 20.5 C35 19 35 15.5 31 14 L15 8 C12 7 10 6 8 8 Z" /></svg>
  </span>;
}
