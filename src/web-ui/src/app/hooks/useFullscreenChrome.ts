import { useEffect, useLayoutEffect, useState } from 'react';
import {
  subscribeNativeFullscreenChrome,
  type NativeFullscreenChrome,
} from '@/infrastructure/runtime/fullscreenChrome';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('FullscreenChrome');

/** Native state and chrome timing differ during the macOS Space animation. */
export function useFullscreenChrome(isFullscreen: boolean) {
  const [chrome, setChrome] = useState<NativeFullscreenChrome | null>(null);
  useEffect(() => subscribeNativeFullscreenChrome(setChrome), []);

  useLayoutEffect(() => {
    if (!chrome?.acknowledgePaint) return;
    let disposed = false;
    let frame: number;
    const nextPaint = () => new Promise<void>(resolve => {
      frame = requestAnimationFrame(() => resolve());
    });
    void (async () => {
      // Read after React committed the reserved layout and WebKit created its
      // transitions. Wait for the actual animations, including reduced motion.
      await nextPaint();
      if (disposed) return;
      while (!disposed) {
        const controls = document.querySelectorAll<HTMLElement>(
          '.openbitfun-nav-bar--macos, .openbitfun-scene-top-bar',
        );
        const movement = [...controls].flatMap(control => control.getAnimations())
          .filter(animation => animation.playState !== 'finished' && animation.playState !== 'idle' &&
            'transitionProperty' in animation &&
            ['padding-left', 'transform'].includes(String(animation.transitionProperty)));
        if (movement.length === 0) break;
        await Promise.allSettled(movement.map(animation => animation.finished));
        if (disposed) return;
        // Rescan: collapsing the sidebar can replace a moving toolbar.
        await nextPaint();
      }
      if (disposed) return;
      // Animation.finished runs before paint. Cross two rendering frames before
      // allowing AppKit to reveal its controls over the WebView surface.
      await nextPaint();
      if (disposed) return;
      await nextPaint();
      if (!disposed) await chrome.acknowledgePaint!();
    })().catch(error => log.error('Failed to acknowledge window chrome paint', { error }));
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [chrome]);

  // Keep space during entry until AppKit has removed the native titlebar;
  // restore it at willExit, before the traffic lights reappear. Once native
  // phases arrive, late resize/command responses must not reverse the motion.
  return {
    isFullscreenChrome: chrome === null ? isFullscreen : chrome.phase === 'fullscreen',
  };
}
