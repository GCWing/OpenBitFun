import { useLayoutEffect } from 'react';
import { useSettingsStore } from '../../settingsStore';
import type { SettingsSectionId } from '../../settingsTypes';

/** Search and legacy links point into the existing page, without opening another view. */
export function useSettingsSectionAnchor(sectionId: SettingsSectionId, ready = true): string {
  const target = useSettingsStore(state => state.activeSectionId);
  const requestId = useSettingsStore(state => state.navigationRequestId);
  const id = `settings-section-${sectionId}`;

  useLayoutEffect(() => {
    if (!ready || target !== sectionId) return;
    const anchor = document.getElementById(id);
    if (!anchor) return;
    const content = anchor.closest('.openbitfun-config-page-content__inner');
    let following = true;
    const align = () => {
      if (following) anchor.scrollIntoView?.({ block: 'start', inline: 'nearest' });
    };
    // Preceding sections can finish loading later. Keep the requested section
    // aligned until the user starts interacting with the page.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(align);
    const stop = () => { following = false; observer?.disconnect(); };
    if (content) observer?.observe(content);
    align();
    const page = anchor.closest('.openbitfun-config-page-layout');
    const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    events.forEach(event => page?.addEventListener(event, stop, { passive: true }));
    return () => {
      observer?.disconnect();
      events.forEach(event => page?.removeEventListener(event, stop));
    };
  }, [id, ready, requestId, sectionId, target]);

  return id;
}
