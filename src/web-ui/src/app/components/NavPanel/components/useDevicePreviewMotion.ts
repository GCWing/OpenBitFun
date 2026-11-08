import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isReducedMotionPreferred } from '@/shared/utils/motionPreference';

interface DevicePreviewMotionOptions {
  scope: string;
  surfaceRef: RefObject<HTMLElement | null>;
  artworkRef: RefObject<HTMLElement | null>;
  onSelect: (deviceId: string) => void;
}

interface PreviewEntrance {
  scope: string;
  transform: string;
  duration: number;
  easing: string;
}

/**
 * Commit the device in one render, then move only its artwork. Fading the old
 * scene to zero before committing left a blank frame and mutated masked artwork,
 * text and button paint underneath retained opacity animations in WebKit.
 */
export function useDevicePreviewMotion({
  scope, surfaceRef, artworkRef, onSelect,
}: DevicePreviewMotionOptions) {
  const [entrance, setEntrance] = useState<PreviewEntrance | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const pendingDeviceRef = useRef<string | null>(null);

  const cancelAnimation = useCallback(() => {
    const animation = animationRef.current;
    animationRef.current = null;
    animation?.cancel();
  }, []);

  const settle = useCallback(() => {
    cancelAnimation();
    pendingDeviceRef.current = null;
    setEntrance(null);
  }, [cancelAnimation]);

  const navigateTo = useCallback((deviceId: string, direction: -1 | 1, animate = true) => {
    let nextEntrance: PreviewEntrance | null = null;
    const surface = surfaceRef.current;
    const artwork = artworkRef.current;
    if (animate && !isReducedMotionPreferred() && surface && artwork
      && typeof artwork.animate === 'function') {
      const style = getComputedStyle(surface);
      const value = style.getPropertyValue('--openbitfun-motion-duration-fast').trim();
      const duration = Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
      const easing = style.getPropertyValue('--openbitfun-motion-easing-standard').trim();
      const distance = style.getPropertyValue('--openbitfun-motion-distance-sm').trim();
      if (Number.isFinite(duration) && duration > 0 && easing && distance) {
        // Retarget rapid browsing from the visible position, before cancellation.
        const transform = animationRef.current
          ? getComputedStyle(artwork).transform
          : `translateX(calc(${distance} * ${direction * 2}))`;
        nextEntrance = { scope, transform, duration, easing };
      }
    }
    cancelAnimation();
    pendingDeviceRef.current = deviceId;
    // Content and controls change together, without waiting on animation.finished.
    onSelect(deviceId);
    setEntrance(nextEntrance);
  }, [artworkRef, cancelAnimation, onSelect, scope, surfaceRef]);

  useLayoutEffect(() => { settle(); }, [scope, settle]);

  useLayoutEffect(() => { pendingDeviceRef.current = null; });

  useLayoutEffect(() => {
    if (!entrance || entrance.scope !== scope) return;
    const artwork = artworkRef.current;
    if (!artwork || isReducedMotionPreferred()) { settle(); return; }
    try {
      const animation = artwork.animate([
        { transform: entrance.transform },
        { transform: 'none' },
      ], { duration: entrance.duration, easing: entrance.easing, fill: 'backwards' });
      animationRef.current = animation;
      const finish = () => {
        if (animationRef.current === animation) settle();
      };
      void animation.finished.then(finish, finish);
    } catch {
      settle();
    }
  }, [artworkRef, entrance, scope, settle]);

  useEffect(() => {
    const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!preference) return;
    const finish = () => { if (preference.matches) settle(); };
    preference.addEventListener('change', finish);
    return () => preference.removeEventListener('change', finish);
  }, [settle]);

  useEffect(() => () => { cancelAnimation(); }, [cancelAnimation]);

  return {
    navigateTo,
    isTransitioning: entrance !== null && entrance.scope === scope,
    pendingDeviceId: () => pendingDeviceRef.current,
  };
}
