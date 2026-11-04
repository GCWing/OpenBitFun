import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSIONS_INITIAL_COUNT } from './sessionNavExpand';

/**
 * A device switch remounts a workspace's rows (background projection to live
 * list and back). The count a list showed when it unmounted is handed to the
 * next list mounting with the same scope shortly after, so "show more" stays
 * expanded through the switch. A scope change inside one list still starts
 * compact.
 */
const HANDOFF_MS = 30_000;
const handoffs = new Map<string, { displayCount: number; at: number }>();

function takeHandoff(scope: string) {
  const entry = handoffs.get(scope);
  handoffs.delete(scope);
  return entry && Date.now() - entry.at <= HANDOFF_MS ? entry : undefined;
}

/** Data discovery never expands the list. Each workspace/source view starts
 * compact, even when another view already has hundreds of metadata rows. */
export function useSessionNavExpansion(
  scope: string,
  options: {
    /** A collapsed list starts over at the first rows when reopened. */
    visible?: boolean;
    /** Checked on unmount: only a remount (device switch) keeps the count. */
    shouldHandOff?: () => boolean;
  } = {},
) {
  const { visible = true } = options;
  const shouldHandOff = useRef(options.shouldHandOff);
  shouldHandOff.current = options.shouldHandOff;
  const [state, setState] = useState(() => ({
    scope, displayCount: takeHandoff(scope)?.displayCount ?? SESSIONS_INITIAL_COUNT,
  }));
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => () => {
    const { scope: last, displayCount } = latest.current;
    if (displayCount > SESSIONS_INITIAL_COUNT && (shouldHandOff.current?.() ?? true)) {
      const now = Date.now();
      // Unclaimed hand-offs (a list that never remounted) lapse here.
      for (const [key, entry] of handoffs) if (now - entry.at > HANDOFF_MS) handoffs.delete(key);
      handoffs.set(last, { displayCount, at: now });
    }
  }, []);
  useEffect(() => {
    if (!visible) setState(previous => previous.displayCount === SESSIONS_INITIAL_COUNT ? previous : { scope, displayCount: SESSIONS_INITIAL_COUNT });
  }, [scope, visible]);
  useEffect(() => {
    setState(previous => previous.scope === scope ? previous : { scope, displayCount: SESSIONS_INITIAL_COUNT });
  }, [scope]);

  const setDisplayCount = useCallback((displayCount: number) => {
    setState({ scope, displayCount: Math.max(SESSIONS_INITIAL_COUNT, displayCount) });
  }, [scope]);

  return {
    // Limit the very first render after a filter/device switch, before effects
    // run, so the previous view cannot briefly mount its entire expanded list.
    displayCount: state.scope === scope ? state.displayCount : SESSIONS_INITIAL_COUNT,
    setDisplayCount,
  };
}
