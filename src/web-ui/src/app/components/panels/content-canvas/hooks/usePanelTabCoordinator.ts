import { useEffect, useRef } from 'react';

interface UsePanelTabCoordinatorOptions {
  visibleTabCount: number;
  scopeKey?: string;
  expandEventName: string;
  onExpand: () => void;
  onCollapse: () => void;
}

/**
 * A collapsible host owns its layout. Standalone canvases do not install this
 * coordinator. Existing tabs, content updates and scene activation never imply
 * an open request; only the host's explicit reveal action expands its panel.
 */
export function usePanelTabCoordinator({
  visibleTabCount,
  scopeKey,
  expandEventName,
  onExpand,
  onCollapse,
}: UsePanelTabCoordinatorOptions) {
  const previousRef = useRef({ visibleTabCount, scopeKey });

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { visibleTabCount, scopeKey };
    // A scope change restores the content of the scope being entered. That
    // scope's open state is owned by the host, which restores it together with
    // the content, so a restore is not a content transition here.
    if (previous.scopeKey !== scopeKey) {
      return;
    }
    if (
      previous.visibleTabCount > 0
      && visibleTabCount === 0
    ) {
      onCollapse();
    } else if (
      previous.visibleTabCount === 0
      && visibleTabCount > 0
      && previous.scopeKey !== undefined
    ) {
      onExpand();
    }
  }, [visibleTabCount, scopeKey, onExpand, onCollapse]);

  // Compatibility for callers that explicitly request this panel, including
  // actions that reveal an existing tab without creating another one.
  useEffect(() => {
    window.addEventListener(expandEventName, onExpand);
    return () => window.removeEventListener(expandEventName, onExpand);
  }, [expandEventName, onExpand]);

  return { expandPanel: onExpand, collapsePanel: onCollapse };
}
