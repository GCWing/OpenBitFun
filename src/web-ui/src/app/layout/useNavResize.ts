import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { isReducedMotionPreferred } from '@/shared/utils/motionPreference';

interface NavResizeOptions {
  areaRef: RefObject<HTMLDivElement | null>;
  dividerRef: RefObject<HTMLDivElement | null>;
  gripRef: RefObject<SVGPathElement | null>;
  width: number;
  minWidth: number;
  maxWidth: number;
  collapseThreshold: number;
  collapsed: boolean;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
}

const REST_LENGTH = 32;
const MAX_BEND = 14;
const MAX_STRETCH = 42;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
// Resistance approaches a limit smoothly, so pulling harder never makes the
// decorative grip escape its hit target or distort the navigation contents.
const rubberBand = (distance: number) => MAX_BEND * distance / (36 + Math.abs(distance));

interface Spring { position: number; velocity: number }
function advance(spring: Spring, target: number, dt: number, active: boolean) {
  // Track the pull firmly, then allow one small recoil before settling.
  const stiffness = active ? 690 : 430;
  const damping = active ? 47 : 29;
  spring.velocity += ((target - spring.position) * stiffness - spring.velocity * damping) * dt;
  spring.position += spring.velocity * dt;
  if (Math.abs(spring.position - target) < 0.02 && Math.abs(spring.velocity) < 0.1) {
    spring.position = target;
    spring.velocity = 0;
  }
}

/** The pane tracks directly; the grip stretches and bows in the pull direction. */
export function useNavResize({
  areaRef, dividerRef, gripRef, width, minWidth, maxWidth, collapseThreshold,
  collapsed, onWidthChange, onCollapse,
}: NavResizeOptions) {
  const dragRef = useRef<((commit: boolean) => void) | null>(null);
  const animationRef = useRef<number | null>(null);
  const bend = useRef<Spring>({ position: 0, velocity: 0 });
  const length = useRef<Spring>({ position: REST_LENGTH, velocity: 0 });
  const pressure = useRef(0);
  const pullVelocity = useRef(0);
  const lastTime = useRef<number | null>(null);

  const paintGrip = useCallback(() => {
    const size = clamp(length.current.position, REST_LENGTH - 2, REST_LENGTH + MAX_STRETCH);
    const half = size / 2;
    // Separation grows with the signed pull, starting at zero on the edge.
    // Sharing the bow's spring also brings the entire grip home on release.
    const lift = bend.current.position * 0.45;
    const endX = 24 + lift + bend.current.position * 0.3;
    const controlX = 24 + lift + bend.current.position * 1.2333;
    gripRef.current?.setAttribute('d', [
      `M ${endX} ${60 - half}`,
      `C ${controlX} ${60 - half * 0.44} ${controlX} ${60 + half * 0.44} ${endX} ${60 + half}`,
    ].join(' '));
  }, [gripRef]);

  const resetFeedback = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    lastTime.current = null;
    pressure.current = 0;
    pullVelocity.current = 0;
    bend.current = { position: 0, velocity: 0 };
    length.current = { position: REST_LENGTH, velocity: 0 };
    dividerRef.current?.removeAttribute('data-resize-feedback');
    paintGrip();
  }, [dividerRef, paintGrip]);

  const animateFeedback = useCallback(function schedule() {
    if (isReducedMotionPreferred()) { resetFeedback(); return; }
    if (animationRef.current !== null) return;
    animationRef.current = requestAnimationFrame(time => {
      animationRef.current = null;
      // Substeps keep the spring stable across low frame rates and wakeups.
      let remaining = Math.min((time - (lastTime.current ?? time - 16)) / 1000, 0.04);
      lastTime.current = time;
      const active = dragRef.current !== null;
      while (remaining > 0) {
        const dt = Math.min(remaining, 1 / 120);
        // Velocity comes from elapsed pointer time, not a kick per event.
        // When the hand pauses, the stretched grip relaxes back into a pill.
        pullVelocity.current *= Math.exp(-dt / 0.075);
        if (Math.abs(pullVelocity.current) < 0.5) pullVelocity.current = 0;
        const pull = active ? pullVelocity.current * 0.052 + pressure.current : 0;
        const targetBend = rubberBand(pull);
        const tension = active ? 1 - Math.exp(-(Math.abs(pullVelocity.current) / 280 + Math.abs(pressure.current) / 50)) : 0;
        const targetLength = REST_LENGTH + tension * MAX_STRETCH;
        advance(bend.current, targetBend, dt, active);
        advance(length.current, targetLength, dt, active);
        remaining -= dt;
      }
      // A rapid reversal must stay inside the SVG even before it settles.
      bend.current.position = clamp(bend.current.position, -MAX_BEND, MAX_BEND);
      paintGrip();
      const targetBend = active ? rubberBand(pressure.current) : 0;
      const targetLength = REST_LENGTH + (active ? (1 - Math.exp(-Math.abs(pressure.current) / 50)) * MAX_STRETCH : 0);
      if (Math.abs(pullVelocity.current) > 0.5 || bend.current.position !== targetBend || bend.current.velocity !== 0
        || length.current.position !== targetLength || length.current.velocity !== 0) {
        schedule();
      } else {
        lastTime.current = null;
        if (!active) dividerRef.current?.removeAttribute('data-resize-feedback');
      }
    });
  }, [dividerRef, paintGrip, resetFeedback]);

  useLayoutEffect(() => {
    if (collapsed) { dragRef.current?.(false); resetFeedback(); }
  }, [collapsed, resetFeedback]);

  useLayoutEffect(() => () => {
    dragRef.current?.(false);
    resetFeedback();
  }, [resetFeedback]);

  useLayoutEffect(() => {
    const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const changed = () => { if (preference?.matches) resetFeedback(); };
    preference?.addEventListener('change', changed);
    return () => preference?.removeEventListener('change', changed);
  }, [resetFeedback]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || collapsed || dragRef.current) return;
    event.preventDefault();
    const divider = event.currentTarget;
    const startX = event.clientX;
    let previousX = startX;
    let previousTime = performance.now();
    const pointerId = event.pointerId;
    let latestWidth = width;
    let widthFrame: number | null = null;
    const previousUserSelect = document.body.style.userSelect;

    const applyWidth = () => {
      widthFrame = null;
      const value = `${latestWidth}px`;
      areaRef.current?.style.setProperty('--nav-width', value);
      divider.style.setProperty('--nav-width', value);
      divider.setAttribute('aria-valuenow', String(Math.round(latestWidth)));
    };
    const finish = (commit: boolean) => {
      if (dragRef.current !== finish) return;
      dragRef.current = null;
      if (widthFrame !== null) cancelAnimationFrame(widthFrame);
      if (!commit) latestWidth = width;
      // Flush even when the final pointer event arrives between paint frames,
      // including a drag that returns to the previously committed width.
      applyWidth();
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      divider.removeEventListener('lostpointercapture', lostCapture);
      if (divider.hasPointerCapture?.(pointerId)) divider.releasePointerCapture(pointerId);
      document.body.style.userSelect = previousUserSelect;
      document.body.classList.remove('openbitfun-is-dragging-nav-collapse', 'openbitfun-is-resizing-nav');
      if (commit) {
        onWidthChange(latestWidth);
        pullVelocity.current = 0;
        divider.setAttribute('data-resize-feedback', 'settling');
        animateFeedback();
      } else resetFeedback();
    };
    const update = (clientX: number) => {
      const rawWidth = width + clientX - startX;
      const nextWidth = clamp(rawWidth, minWidth, maxWidth);
      const time = performance.now();
      const delta = clientX - previousX;
      if (delta !== 0) {
        // Bow toward the hand, including at a width limit. Reversals replace
        // the old pull immediately instead of accumulating opposite inertia.
        pullVelocity.current = clamp(delta / clamp((time - previousTime) / 1000, 0.001, 0.05), -2400, 2400);
      }
      previousX = clientX;
      previousTime = time;
      pressure.current = rawWidth - nextWidth;
      latestWidth = nextWidth;
      if (rawWidth <= minWidth - collapseThreshold) {
        finish(true);
        resetFeedback();
        onCollapse();
        return false;
      }
      animateFeedback();
      return true;
    };
    function move(event: globalThis.PointerEvent) {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      if (update(event.clientX) && widthFrame === null) widthFrame = requestAnimationFrame(applyWidth);
    }
    function up(event: globalThis.PointerEvent) {
      if (event.pointerId === pointerId && update(event.clientX)) finish(true);
    }
    function cancel(event?: Event) {
      if (event?.type === 'pointercancel' && (event as globalThis.PointerEvent).pointerId !== pointerId) return;
      finish(false);
    }
    function lostCapture(event: globalThis.PointerEvent) { if (event.pointerId === pointerId) cancel(); }
    function key(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    }
    dragRef.current = finish;
    divider.setPointerCapture?.(pointerId);
    divider.setAttribute('data-resize-feedback', 'dragging');
    document.body.style.userSelect = 'none';
    document.body.classList.add('openbitfun-is-dragging-nav-collapse', 'openbitfun-is-resizing-nav');
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    divider.addEventListener('lostpointercapture', lostCapture);
    animateFeedback();
  }, [animateFeedback, areaRef, collapsed, collapseThreshold, maxWidth, minWidth, onCollapse, onWidthChange, resetFeedback, width]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (dragRef.current || collapsed) return;
    const step = event.shiftKey ? 40 : 10;
    let nextWidth: number;
    switch (event.key) {
      case 'ArrowLeft': nextWidth = width - step; break;
      case 'ArrowRight': nextWidth = width + step; break;
      case 'Home': nextWidth = minWidth; break;
      case 'End': nextWidth = maxWidth; break;
      default: return;
    }
    event.preventDefault();
    resetFeedback();
    onWidthChange(clamp(nextWidth, minWidth, maxWidth));
  }, [collapsed, maxWidth, minWidth, onWidthChange, resetFeedback, width]);

  return { onPointerDown, onKeyDown };
}
