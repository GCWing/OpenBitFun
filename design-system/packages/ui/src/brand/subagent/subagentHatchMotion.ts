import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export type SubagentHatchPhase = 'incubating' | 'ready' | 'stopped';
const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const ease = 'cubic-bezier(0.4, 0, 0.2, 1)';

/** Coordinates are SVG user units, so the same artwork works at every avatar size. */
function play(host: HTMLElement, reveal: boolean): Animation[] {
  const animations: Animation[] = [];
  const animate = (part: string, frames: Keyframe[]) => {
    const element = host.querySelector(`[data-hatch-part="${part}"]`);
    if (element) animations.push(element.animate(frames, {
      duration: reveal ? 720 : 2200,
      iterations: reveal ? 1 : Infinity,
      easing: ease,
      fill: 'both',
    }));
  };

  if (reveal) {
    animate('shell', [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }]);
    animate('peek', [{ opacity: 1 }, { opacity: 0, offset: 0.16 }, { opacity: 0 }]);
    animate('lid', [
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: 'translate(0, 5px) rotate(0deg)', opacity: 1, offset: 0.12 },
      { transform: 'translate(-18px, -56px) rotate(-18deg)', opacity: 1, offset: 0.45 },
      { transform: 'translate(-36px, -76px) rotate(-30deg)', opacity: 0, offset: 0.75 },
      { transform: 'translate(-36px, -76px) rotate(-30deg)', opacity: 0 },
    ]);
    for (const [part, direction] of [['shell-left', -1], ['shell-right', 1]] as const) {
      animate(part, [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1, offset: 0.16 },
        { transform: `translate(${direction * 24}px, 10px) rotate(${direction * 16}deg)`, opacity: 1, offset: 0.48 },
        { transform: `translate(${direction * 38}px, 18px) rotate(${direction * 24}deg)`, opacity: 0, offset: 0.85 },
        { transform: `translate(${direction * 38}px, 18px) rotate(${direction * 24}deg)`, opacity: 0 },
      ]);
    }
    animate('avatar', [
      { transform: 'translateY(12%) scale(0.72)', opacity: 0 },
      { transform: 'translateY(12%) scale(0.72)', opacity: 0, offset: 0.12 },
      { transform: 'translateY(-6%) scale(1.06)', opacity: 1, offset: 0.5 },
      { transform: 'translateY(1%) scale(1.02, 0.97)', opacity: 1, offset: 0.72 },
      { transform: 'translateY(0) scale(1)', opacity: 1 },
    ]);
  } else {
    animate('egg', [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(-6deg)', offset: 0.16 },
      { transform: 'rotate(5deg)', offset: 0.3 },
      { transform: 'rotate(-3deg)', offset: 0.43 },
      { transform: 'rotate(0deg)', offset: 0.58 },
      { transform: 'rotate(0deg)' },
    ]);
    animate('lid', [
      { transform: 'translateY(0) rotate(0deg)' },
      { transform: 'translateY(-10px) rotate(-4deg)', offset: 0.23 },
      { transform: 'translateY(0) rotate(0deg)', offset: 0.42 },
      { transform: 'translateY(-5px) rotate(2deg)', offset: 0.52 },
      { transform: 'translateY(0) rotate(0deg)', offset: 0.66 },
      { transform: 'translateY(0) rotate(0deg)' },
    ]);
    animate('eyes', [
      { transform: 'scaleY(1)' }, { transform: 'scaleY(1)', offset: 0.58 },
      { transform: 'scaleY(0.12)', offset: 0.62 }, { transform: 'scaleY(1)', offset: 0.67 },
      { transform: 'scaleY(1)' },
    ]);
  }
  return animations;
}

/** Reveal only a creation observed on screen; restored/late-hydrated avatars stay settled. */
export function useSubagentHatchMotion(ref: RefObject<HTMLElement>, phase: SubagentHatchPhase, active: boolean) {
  const previous = useRef(phase);
  const visible = useRef(typeof IntersectionObserver === 'undefined');

  useClientLayoutEffect(() => {
    const reveal = previous.current === 'incubating' && phase === 'ready';
    previous.current = phase;
    const host = ref.current;
    if (!host || !active || phase === 'stopped' || (phase === 'ready' && !reveal)
      || typeof host.animate !== 'function') return;
    const document = host.ownerDocument;
    const view = document.defaultView;
    const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const forced = view?.matchMedia?.('(forced-colors: active)');
    let animations: Animation[] = [];
    let consumed = false;
    let disposed = false;
    const cancel = () => {
      animations.forEach(animation => animation.cancel());
      animations = [];
    };
    const sync = () => {
      if (document.hidden || !visible.current || reduced?.matches || forced?.matches) {
        cancel();
        // Never defer a creation celebration until a later scroll, tab switch or preference change.
        if (reveal) consumed = true;
        return;
      }
      if (animations.length || (reveal && consumed)) return;
      consumed = true;
      animations = play(host, reveal);
      if (reveal) void Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (!disposed) cancel();
      }).catch(() => { /* A lifecycle change or unmount cancels the reveal. */ });
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      visible.current = entries.some(entry => entry.isIntersecting);
      sync();
    });
    observer?.observe(host);
    document.addEventListener('visibilitychange', sync);
    reduced?.addEventListener('change', sync);
    forced?.addEventListener('change', sync);
    sync();
    return () => {
      disposed = true;
      cancel();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced?.removeEventListener('change', sync);
      forced?.removeEventListener('change', sync);
    };
  }, [active, phase, ref]);
}
