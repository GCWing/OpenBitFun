import { useLayoutEffect, type RefObject } from 'react';
import { useFlowChatReaderStore } from './readerState';

/** Small inner-reader offsets survive card recycling. Never observes the transcript. */
export function useReaderScrollMemory(rootRef: RefObject<HTMLElement | null>, itemId: string | null | undefined) {
  const reader = useFlowChatReaderStore();
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !reader || !itemId) return;
    const restored = new WeakSet<HTMLElement>();
    const targets = () => [...root.querySelectorAll<HTMLElement>('[data-openbitfun-scrollbar-visibility], [data-testid="chat-thinking-content"]')];
    const keyFor = (element: HTMLElement, index: number) => `scroll:${itemId}:${element.dataset.openbitfunComponent}:${element.dataset.openbitfunPart}:${index}`;
    const restore = () => targets().forEach((element, index) => {
      if (restored.has(element)) return;
      restored.add(element);
      const key = keyFor(element, index);
      if (reader.has(`${key}:y`)) element.scrollTop = reader.get(`${key}:y`, 0);
      if (reader.has(`${key}:x`)) element.scrollLeft = reader.get(`${key}:x`, 0);
    });
    const record = (event: Event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      const index = targets().indexOf(element);
      if (index < 0) return;
      const key = keyFor(element, index);
      reader.set(`${key}:y`, element.scrollTop);
      reader.set(`${key}:x`, element.scrollLeft);
    };
    restore();
    root.addEventListener('scroll', record, true);
    const observer = new MutationObserver(restore);
    observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); root.removeEventListener('scroll', record, true); };
  }, [reader, rootRef, itemId]);
}
