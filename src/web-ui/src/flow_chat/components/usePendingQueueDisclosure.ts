import { useLayoutEffect, useRef, useState } from 'react';

/** Keep focus on the queue when its row menu folds or unfolds the list. */
export function usePendingQueueDisclosure() {
  const [expanded, setExpanded] = useState(true);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocus = useRef(false);

  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (expanded) {
      const list = listRef.current;
      (list?.querySelector<HTMLElement>('[data-openbitfun-product-part="preview"][tabindex="0"]')
        ?? list?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]'))?.focus();
    } else {
      toggleRef.current?.focus();
    }
  }, [expanded]);

  const toggle = () => {
    restoreFocus.current = true;
    setExpanded(value => !value);
  };

  return { expanded, setExpanded, toggle, toggleRef, listRef };
}
