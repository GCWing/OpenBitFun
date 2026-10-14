import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isReducedMotionPreferred } from '@/shared/utils/motionPreference';

interface DevicePreviewMotionOptions {
  scope: string;
  surfaceRef: RefObject<HTMLElement | null>;
  artworkRef: RefObject<HTMLElement | null>;
  headingRef: RefObject<HTMLElement | null>;
  actionsRef: RefObject<HTMLElement | null>;
  paginationRef: RefObject<HTMLElement | null>;
  onSelect: (deviceId: string) => void;
}

interface PreviewTarget {
  deviceId: string;
  direction: -1 | 1;
}

function readDuration(style: CSSStyleDeclaration, token: string): number {
  const value = style.getPropertyValue(token).trim();
  const duration = Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** Manual browsing owns motion; hydration and surface changes always settle directly. */
export function useDevicePreviewMotion({
  scope, surfaceRef, artworkRef, headingRef, actionsRef, paginationRef, onSelect,
}: DevicePreviewMotionOptions) {
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [entrance, setEntrance] = useState<{ target: PreviewTarget; generation: number } | null>(null);
  const animationsRef = useRef<Animation[]>([]);
  const generationRef = useRef(0);
  const phaseRef = useRef<'idle' | 'exit' | 'enter'>('idle');
  const pendingTargetRef = useRef<PreviewTarget | null>(null);
  const previousScopeRef = useRef(scope);

  const cancelAnimations = useCallback(() => {
    generationRef.current += 1;
    animationsRef.current.forEach(animation => animation.cancel());
    animationsRef.current = [];
  }, []);

  const settle = useCallback((selectPending: boolean) => {
    const target = pendingTargetRef.current;
    cancelAnimations();
    pendingTargetRef.current = null;
    phaseRef.current = 'idle';
    setEntrance(null);
    setIsTransitioning(false);
    if (selectPending && target) onSelect(target.deviceId);
  }, [cancelAnimations, onSelect]);

  const readMotion = useCallback(() => {
    const surface = surfaceRef.current;
    const elements = [artworkRef.current, headingRef.current, actionsRef.current, paginationRef.current]
      .filter((element): element is HTMLElement => element !== null);
    if (!surface || isReducedMotionPreferred() || elements.length !== 4
      || elements.some(element => typeof element.animate !== 'function')) return null;
    const style = getComputedStyle(surface);
    const exitDuration = readDuration(style, '--openbitfun-motion-duration-instant');
    const enterDuration = readDuration(style, '--openbitfun-motion-duration-fast');
    const easing = style.getPropertyValue('--openbitfun-motion-easing-standard').trim();
    const distance = style.getPropertyValue('--openbitfun-motion-distance-sm').trim();
    if (!exitDuration || !enterDuration || !easing || !distance) return null;
    return { elements, exitDuration, enterDuration, easing, distance };
  }, [actionsRef, artworkRef, headingRef, paginationRef, surfaceRef]);

  const navigateTo = useCallback((deviceId: string, direction: -1 | 1) => {
    pendingTargetRef.current = { deviceId, direction };
    const motion = readMotion();
    if (!motion) { settle(true); return; }
    // Repeated clicks during the short exit only change its destination.
    if (phaseRef.current === 'exit') return;

    // Interrupted entrances leave from their actual frame, without snapping back.
    const starts = motion.elements.map(element => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity || '1', transform: style.transform || 'none' };
    });
    cancelAnimations();
    const generation = generationRef.current;
    phaseRef.current = 'exit';
    setEntrance(null);
    setIsTransitioning(true);
    try {
      motion.elements.forEach((element, index) => animationsRef.current.push(element.animate([
        starts[index],
        { opacity: 0, transform: element === artworkRef.current
          ? `translateX(calc(${motion.distance} * ${-direction}))` : 'none' },
      ], { duration: motion.exitDuration, easing: motion.easing, fill: 'forwards' })));
      void Promise.all(animationsRef.current.map(animation => animation.finished)).then(() => {
        const target = pendingTargetRef.current;
        if (generation !== generationRef.current || !target) return;
        phaseRef.current = 'enter';
        onSelect(target.deviceId);
        setEntrance({ target, generation });
      }).catch(() => {
        if (generation === generationRef.current) settle(true);
      });
    } catch {
      settle(true);
    }
  }, [artworkRef, cancelAnimations, onSelect, readMotion, settle]);

  useLayoutEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    settle(false);
  }, [scope, settle]);

  useLayoutEffect(() => {
    if (!entrance || entrance.generation !== generationRef.current) return;
    const motion = readMotion();
    if (!motion) { settle(true); return; }
    cancelAnimations();
    const generation = generationRef.current;
    try {
      motion.elements.forEach(element => animationsRef.current.push(element.animate([
        { opacity: 0, transform: element === artworkRef.current
          ? `translateX(calc(${motion.distance} * ${entrance.target.direction * 2}))` : 'none' },
        { opacity: 1, transform: 'none' },
      ], { duration: motion.enterDuration, easing: motion.easing, fill: 'both' })));
      void Promise.all(animationsRef.current.map(animation => animation.finished)).then(() => {
        if (generation === generationRef.current) settle(false);
      }).catch(() => {
        if (generation === generationRef.current) settle(true);
      });
    } catch {
      settle(true);
    }
  }, [artworkRef, cancelAnimations, entrance, readMotion, settle]);

  useEffect(() => {
    const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!preference) return;
    const finish = () => { if (preference.matches) settle(true); };
    preference.addEventListener('change', finish);
    return () => preference.removeEventListener('change', finish);
  }, [settle]);

  useEffect(() => () => { cancelAnimations(); }, [cancelAnimations]);

  return {
    navigateTo,
    isTransitioning,
    pendingDeviceId: () => pendingTargetRef.current?.deviceId ?? null,
  };
}
