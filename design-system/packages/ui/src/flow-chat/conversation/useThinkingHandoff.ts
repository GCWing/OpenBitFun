import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
type Position = 'block' | 'side';
interface Handoff {
  target: boolean;
  phase: Position | 'leaving';
  origin: Position;
  label: string;
  top?: string;
}

/** Move the retained control only after it has faded out. CSS owns the fold and
 * its reversal; this hook waits for those actual transitions, never a timer. */
export function useThinkingHandoff(rootRef: RefObject<HTMLDivElement>, side: boolean, label: string, wantsDock: boolean, virtualized = false) {
  const previousLabel = useRef(label);
  const [motionReady, setMotionReady] = useState(false);
  const [handoff, setHandoff] = useState<Handoff>(() => ({
    target: side, phase: side ? 'side' : 'block', origin: side ? 'side' : 'block', label,
  }));

  useIsomorphicLayoutEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView;
    if (!view?.requestAnimationFrame) {
      setMotionReady(true);
      return;
    }
    // Initial annotation measurement can flush styles before the first paint.
    // Keep those initial commits instant; only later state changes may move.
    const frame = view.requestAnimationFrame(() => setMotionReady(true));
    return () => view.cancelAnimationFrame(frame);
  }, [rootRef]);

  useIsomorphicLayoutEffect(() => {
    if (handoff.target === side) return;
    const root = rootRef.current;
    const header = root?.querySelector<HTMLElement>('.thinking-collapsed-header');
    const view = root?.ownerDocument.defaultView;
    const position = side ? 'side' : 'block';
    // History/remounts have no running transitions. Hidden groups and reduced
    // motion also settle directly rather than queueing an invisible handoff.
    if ((virtualized && !motionReady) || !header?.getAnimations || !view || root?.closest('[hidden], [inert]')
      || view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setHandoff({ target: side, phase: position, origin: position, label: previousLabel.current });
      return;
    }
    setHandoff({
      target: side,
      phase: 'leaving',
      origin: handoff.phase === 'leaving' ? handoff.origin : handoff.phase,
      label: handoff.phase === 'leaving' ? handoff.label : previousLabel.current,
      top: view.getComputedStyle(header).insetBlockStart,
    });
  }, [handoff, rootRef, side, motionReady, virtualized]);

  useIsomorphicLayoutEffect(() => {
    if (handoff.phase !== 'leaving' || handoff.target !== side) return;
    const root = rootRef.current;
    if (!root) return;
    const parts: [Element | null, string][] = [
      [root.querySelector('.thinking-collapsed-header'), 'opacity'],
    ];
    if (side) parts.push(
      [root, 'margin-bottom'],
      [root, 'min-block-size'],
      [root.querySelector('.thinking-header-slot'), 'block-size'],
      [root.querySelector('.thinking-expand-container'), 'grid-template-rows'],
    );
    const transitions = parts.flatMap(([element, property]) => (
      element?.getAnimations?.().filter(animation => 'transitionProperty' in animation
        && (animation.transitionProperty === property
          // Engines may expose the physical property for logical block-size.
          || (property === 'block-size' && animation.transitionProperty === 'height')
          || (property === 'min-block-size' && animation.transitionProperty === 'min-height'))) ?? []
    ));
    let cancelled = false;
    const settle = () => {
      if (cancelled) return;
      setHandoff(current => current === handoff
        ? { ...current, phase: side ? 'side' : 'block', origin: side ? 'side' : 'block', top: undefined }
        : current);
    };
    if (transitions.length) void Promise.allSettled(transitions.map(animation => animation.finished)).then(settle);
    else settle();
    return () => { cancelled = true; };
  }, [handoff, rootRef, side]);

  // Annotation discovery may take another layout commit. Keep the last inline
  // label across that commit instead of flashing the completed character count.
  useIsomorphicLayoutEffect(() => {
    if (!wantsDock) previousLabel.current = label;
  }, [label, wantsDock]);

  return {
    phase: handoff.phase,
    motionReady,
    origin: handoff.origin,
    top: handoff.top,
    label: handoff.phase === 'leaving' ? handoff.label : label,
  };
}
