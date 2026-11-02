import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import type { SessionExpandLevel } from './sessionNavExpand';

/** Data discovery never expands the list. Each workspace/source view starts
 * compact, even when another view already has hundreds of metadata rows. */
export function useSessionNavExpansion(scope: string, pageSize: number) {
  const [state, setState] = useState({ scope, level: 0 as SessionExpandLevel, displayCount: pageSize });
  useEffect(() => {
    setState(previous => previous.scope === scope ? previous : { scope, level: 0, displayCount: pageSize });
  }, [pageSize, scope]);

  const setExpandLevel = useCallback((level: SessionExpandLevel) => {
    setState(previous => ({
      scope,
      level,
      displayCount: level === 2 && previous.scope === scope ? previous.displayCount : pageSize,
    }));
  }, [pageSize, scope]);

  const setLevel2DisplayCount = useCallback((next: SetStateAction<number>) => {
    setState(previous => {
      const current = previous.scope === scope ? previous.displayCount : pageSize;
      return {
        scope,
        level: previous.scope === scope ? previous.level : 0,
        displayCount: typeof next === 'function' ? next(current) : next,
      };
    });
  }, [pageSize, scope]);

  return {
    // Limit the very first render after a filter/device switch, before effects
    // run, so the previous view cannot briefly mount its entire expanded list.
    expandLevel: state.scope === scope ? state.level : 0 as SessionExpandLevel,
    level2DisplayCount: state.scope === scope ? state.displayCount : pageSize,
    setExpandLevel,
    setLevel2DisplayCount,
  };
}
