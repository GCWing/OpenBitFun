import { useCallback, useRef } from 'react';
import { useReaderScrollMemory } from '../timeline/useReaderScrollMemory';
interface UseToolCardHeightContractOptions {
  toolId: string | null | undefined;
  toolName: string;
  getAnchorElement?: () => HTMLElement | null;
}

interface ApplyHeightContractOptions {
  onExpand?: () => void;
}

export function useToolCardHeightContract({
  toolId: _toolId,
  toolName: _toolName,
  getAnchorElement: _getAnchorElement,
}: UseToolCardHeightContractOptions) {
  const cardRootRef = useRef<HTMLDivElement>(null);
  useReaderScrollMemory(cardRootRef, _toolId);

  const dispatchToolCardToggle = useCallback(() => {
    window.dispatchEvent(new CustomEvent('tool-card-toggle'));
  }, []);

  const applyExpandedState = useCallback((
    currentExpanded: boolean,
    nextExpanded: boolean,
    setExpanded: (nextExpanded: boolean) => void,
    options?: ApplyHeightContractOptions,
  ) => {
    if (nextExpanded !== currentExpanded) {
      setExpanded(nextExpanded);
      dispatchToolCardToggle();
    }

    if (nextExpanded) {
      options?.onExpand?.();
    }
  }, [dispatchToolCardToggle]);

  return {
    cardRootRef,
    dispatchToolCardToggle,
    applyExpandedState,
  };
}
