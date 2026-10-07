import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import styles from './CapsuleMotion.module.css';

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
export const TOOL_CAPSULE_COLLAPSE_DURATION_MS = 520;
const TOOL_MOTION_DURATION_MS = 300;

type MotionKind = 'receive' | 'recall' | 'release' | 'failure' | 'settle' | 'cancel';
type MotionRecipe = (motion: MotionScope) => void;
interface MotionScope {
  root: HTMLElement;
  skin: HTMLElement;
  fromTransform: string;
  fromBody: { transform: string; opacity: string } | null;
  animate: (target: Element, frames: Keyframe[], duration: number, delay?: number) => void;
  layer: () => HTMLElement;
}

/** Decorations share one clock and lifetime; no real card is cloned or reparented. */
export function useCapsuleMotion(rootRef: RefObject<HTMLElement>) {
  const running = useRef<{ kind: MotionKind; cancel: () => void } | null>(null);
  const cancel = useCallback(() => running.current?.cancel(), []);

  const play = useCallback((kind: MotionKind, recipe: MotionRecipe) => {
    const root = rootRef.current;
    const view = root?.ownerDocument.defaultView;
    if (!root || !view) return;
    // Background receipts coalesce with any feedback already in progress.
    if (kind === 'receive' && running.current) return;
    const skin = root.querySelector<HTMLElement>('[data-capsule-skin]');
    const fromTransform = skin ? view.getComputedStyle(skin).transform : 'none';
    const body = root.dataset.toolCapsule === 'true'
      ? root.querySelector<HTMLElement>('[data-openbitfun-part="collapseInner"]') : null;
    const bodyStyle = body && running.current ? view.getComputedStyle(body) : null;
    const fromBody = bodyStyle ? { transform: bodyStyle.transform, opacity: bodyStyle.opacity } : null;
    cancel();
    const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
    const forcedColors = view.matchMedia?.('(forced-colors: active)');
    const bounds = root.getBoundingClientRect();
    if (!skin || !root.isConnected || typeof skin.animate !== 'function'
      || reduced?.matches || forcedColors?.matches || root.ownerDocument.hidden
      || bounds.width <= 0 || bounds.height <= 0
      || bounds.bottom <= 0 || bounds.top >= view.innerHeight) return;

    const animations: Animation[] = [];
    let decoration: HTMLElement | undefined;
    let disposed = false;
    const startTime = root.ownerDocument.timeline?.currentTime;
    // Keep detail retraction visible throughout its interval.
    const easing = kind === 'recall' ? 'linear'
      : view.getComputedStyle(root).getPropertyValue('--openbitfun-motion-easing-standard').trim() || 'ease-out';
    const current = { kind, cancel: () => {
      if (disposed) return;
      disposed = true;
      animations.forEach(animation => animation.cancel());
      decoration?.remove();
      if (running.current === current) {
        running.current = null;
        root.removeAttribute('data-capsule-motion');
      }
      reduced?.removeEventListener('change', current.cancel);
      forcedColors?.removeEventListener('change', current.cancel);
      root.ownerDocument.removeEventListener('visibilitychange', onVisibilityChange);
      root.removeEventListener('wheel', current.cancel, true);
      view.removeEventListener('resize', current.cancel);
    } };
    const onVisibilityChange = () => { if (root.ownerDocument.hidden) current.cancel(); };
    running.current = current;
    root.setAttribute('data-capsule-motion', kind);
    reduced?.addEventListener('change', current.cancel);
    forcedColors?.addEventListener('change', current.cancel);
    root.ownerDocument.addEventListener('visibilitychange', onVisibilityChange);
    root.addEventListener('wheel', current.cancel, { capture: true, passive: true });
    view.addEventListener('resize', current.cancel);

    const scope: MotionScope = {
      root, skin, fromTransform, fromBody,
      animate(target, frames, duration, delay = 0) {
        const animation = target.animate(frames, { duration, delay, easing, fill: 'both' });
        if (typeof startTime === 'number') animation.startTime = startTime;
        animations.push(animation);
      },
      layer() {
        if (!decoration) {
          decoration = root.ownerDocument.createElement('span');
          decoration.className = styles.layer!;
          decoration.setAttribute('aria-hidden', 'true');
          decoration.setAttribute('inert', '');
          decoration.setAttribute('data-capsule-decoration', '');
          root.append(decoration);
        }
        return decoration;
      },
    };
    try {
      recipe(scope);
    } catch {
      // An unavailable animation implementation must not block disclosure.
      current.cancel();
    }
    void Promise.all(animations.map(animation => animation.finished)).then(current.cancel, current.cancel);
  }, [cancel, rootRef]);

  useEffect(() => cancel, [cancel]);
  return { play, cancel };
}

function addShape(motion: MotionScope, className: string, x: number, y: number, width: number, height: number) {
  const shape = motion.root.ownerDocument.createElement('span');
  shape.className = className;
  Object.assign(shape.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  motion.layer().append(shape);
  return shape;
}

function soften(motion: MotionScope, duration: number, strength = 1) {
  motion.animate(motion.skin, [
    { transform: motion.fromTransform, offset: 0 },
    { transform: `scale(1.008, ${1 - 0.05 * strength})`, offset: 0.28 },
    { transform: `scale(0.992, ${1 + 0.07 * strength})`, offset: 0.56 },
    { transform: 'scale(1.003, 0.985)', offset: 0.8 },
    { transform: 'none', offset: 1 },
  ], duration);
}

export const receiveCapsule: MotionRecipe = motion => soften(motion, 180, 0.55);

const recallCapsule: MotionRecipe = motion => {
  const body = motion.root.querySelector<HTMLElement>('[data-openbitfun-part="collapseInner"]');
  if (body) motion.animate(body, [
    { transform: motion.fromBody?.transform ?? 'none', opacity: motion.fromBody?.opacity ?? 1, transformOrigin: 'center top' },
    { transform: 'translateY(-8px) scaleY(0.94)', opacity: 0, transformOrigin: 'center top' },
  ], TOOL_CAPSULE_COLLAPSE_DURATION_MS);
  soften(motion, TOOL_CAPSULE_COLLAPSE_DURATION_MS);
};

const releaseCapsule: MotionRecipe = motion => {
  const body = motion.root.querySelector<HTMLElement>('[data-openbitfun-part="collapseInner"]');
  if (body && motion.fromBody) motion.animate(body, [motion.fromBody, { transform: 'none', opacity: 1 }], 180);
  receiveCapsule(motion);
};

const ruptureCapsule: MotionRecipe = motion => {
  const rootBounds = motion.root.getBoundingClientRect();
  const bounds = motion.skin.getBoundingClientRect();
  const left = bounds.left - rootBounds.left;
  const top = bounds.top - rootBounds.top;
  const segments = [styles.fragmentStart, styles.fragmentEnd];
  segments.forEach((segment, index) => {
    const fragment = addShape(motion, `${styles.fragment} ${segment}`, left, top, bounds.width, bounds.height);
    const direction = index === 0 ? -1 : 1;
    motion.animate(fragment, [
      { transform: 'translate(0, 0) scale(1)', opacity: 0, offset: 0 },
      { transform: 'translate(0, 0) scale(1, 0.9)', opacity: 0.85, offset: 0.18 },
      { transform: `translate(${direction * 6}px, -2px) scale(0.98, 0.85)`, opacity: 0.65, offset: 0.45 },
      { transform: `translate(${direction * 12}px, 4px) scale(0.94, 0.65)`, opacity: 0, offset: 1 },
    ], TOOL_MOTION_DURATION_MS);
  });
  motion.animate(motion.skin, [
    { transform: motion.fromTransform, opacity: 1, offset: 0 },
    { transform: 'scale(1.015, 0.86)', opacity: 0.15, offset: 0.3 },
    { transform: 'scale(0.995, 1.02)', opacity: 0.8, offset: 0.75 },
    { transform: 'none', opacity: 1, offset: 1 },
  ], TOOL_MOTION_DURATION_MS);
};

export function useToolCapsuleMotion(rootRef: RefObject<HTMLElement>, enabled: boolean, expanded: boolean, status: string) {
  const motion = useCapsuleMotion(rootRef);
  const previous = useRef({ enabled, expanded, status });
  useClientLayoutEffect(() => {
    const before = previous.current;
    previous.current = { enabled, expanded, status };
    if (!enabled || !before.enabled) { motion.cancel(); return; }
    if (before.expanded !== expanded) {
      if (expanded) motion.play('release', releaseCapsule);
      else if (!rootRef.current?.closest('[data-flow-group][data-expanded="false"]')) motion.play('recall', recallCapsule);
      else motion.cancel();
    } else if (before.status !== status) {
      if (status === 'error') motion.play('failure', ruptureCapsule);
      else if (status === 'completed' || status === 'confirmed') motion.play('settle', receiveCapsule);
      else if (status === 'cancelled' || status === 'rejected') motion.play('cancel', motion => {
        motion.animate(motion.skin, [
          { transform: motion.fromTransform, opacity: 1 },
          { transform: 'scale(0.98, 0.88)', opacity: 0.35, offset: 0.5 },
          { transform: 'none', opacity: 1 },
        ], TOOL_MOTION_DURATION_MS);
      });
    }
  }, [enabled, expanded, status, rootRef, motion.play, motion.cancel]);
}
