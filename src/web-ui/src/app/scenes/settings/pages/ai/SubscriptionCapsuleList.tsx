import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '@openbitfun/ui';
import { observeElementResize } from '@/shared/utils/sharedResizeObserver';
import styles from './SubscriptionCapsuleList.module.scss';

/** Reserve the last capsule for the account browser within at most three rows. */
export function SubscriptionCapsuleList({ children, label, moreLabel, onMore }: {
  children: ReactNode;
  label: string;
  moreLabel: string;
  onMore: () => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLLIElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const more = moreRef.current;
    if (!list || !more) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const items = Array.from(list.children).filter((item): item is HTMLLIElement => item instanceof HTMLLIElement && item !== more);
      const focusedItem = items.find(item => item.contains(document.activeElement));
      for (const item of items) item.hidden = false;
      const available = list.getBoundingClientRect().width;
      if (available <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const moreWidth = Math.min(more.getBoundingClientRect().width, available);
      const widths = items.map(item => Math.min(item.getBoundingClientRect().width, available));
      let row = 1;
      let used = 0;
      let visible = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const width = widths[index];
        if (used > 0 && used + gap + width > available + 0.5) {
          row += 1;
          used = 0;
        }
        if (row > 3) break;
        used += (used > 0 ? gap : 0) + width;
        if (row < 3 || used + gap + moreWidth <= available + 0.5) visible = index + 1;
      }
      items.forEach((item, index) => { item.hidden = index >= visible; });
      if (focusedItem?.hidden) more.querySelector('button')?.focus();
    };
    measure();
    const stopObserving = observeElementResize(list, measure);
    document.fonts?.addEventListener('loadingdone', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      stopObserving();
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [children, moreLabel]);

  return <ul ref={listRef} className={`openbitfun-model-settings__import-summary ${styles.list}`} aria-label={label}
    data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionCapsules">
    {children}
    <li ref={moreRef} className="openbitfun-model-settings__import-item" data-testid="settings-subscription-more"
      data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionMore">
      <Button size="sm" variant="outline" aria-haspopup="dialog" onClick={onMore}>{moreLabel}</Button>
    </li>
  </ul>;
}
