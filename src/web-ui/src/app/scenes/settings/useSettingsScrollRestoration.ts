import { useLayoutEffect, type RefObject } from 'react';
import type { SettingsPageId, SettingsSectionId } from './settingsTypes';

// Presentation only, bounded by the settings destinations in the current activation.
let scrollEpoch: number | undefined;
const scrollPositions = new Map<SettingsPageId, number>();

export function useSettingsScrollRestoration(
  root: RefObject<HTMLDivElement>,
  pageId: SettingsPageId,
  epoch: number,
  ready: boolean,
  sectionId: SettingsSectionId | null,
  requestId: number,
) {
  useLayoutEffect(() => {
    if (scrollEpoch !== epoch) {
      scrollEpoch = epoch;
      scrollPositions.clear();
    }
    if (!ready || !root.current) return;
    const container = root.current;
    let viewport: HTMLElement | null = null;
    let following = sectionId === null;
    const saved = scrollPositions.get(pageId) ?? 0;
    const restore = () => {
      if (following && viewport) viewport.scrollTop = saved;
    };
    const stop = () => { following = false; };
    const save = () => {
      if (viewport && scrollEpoch === epoch && !following) {
        scrollPositions.set(pageId, viewport.scrollTop);
      }
    };
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore);
    const attach = () => {
      const next = container.querySelector<HTMLElement>('.openbitfun-config-page-layout');
      if (!next || next.closest('[data-openbitfun-part="loading"]') || viewport === next) return;
      viewport?.removeEventListener('scroll', save);
      resize?.disconnect();
      viewport = next;
      viewport.addEventListener('scroll', save, { passive: true });
      resize?.observe(viewport);
      for (const child of viewport.children) resize?.observe(child);
      restore();
    };
    const mutation = new MutationObserver(attach);
    mutation.observe(container, { childList: true, subtree: true });
    events.forEach(event => container.addEventListener(event, stop, { passive: true }));
    attach();
    return () => {
      // Do not replace a saved offset with the clamped height of a still-loading page.
      save();
      viewport?.removeEventListener('scroll', save);
      mutation.disconnect();
      resize?.disconnect();
      events.forEach(event => container.removeEventListener(event, stop));
    };
  }, [root, pageId, epoch, ready, sectionId, requestId]);
}
