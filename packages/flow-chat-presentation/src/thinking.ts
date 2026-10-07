import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface ThinkingDisclosureInput {
  isSummary: boolean;
  isActive: boolean;
  isRevealing?: boolean;
  isLastItem: boolean;
  forceExpanded?: boolean;
  displayContext?: 'default' | 'subagent-projection';
  /** Embedded subagent transcripts stay compact until the reader opens them. */
  compactByDefault?: boolean;
}

export function defaultThinkingExpanded({
  isSummary,
  isActive,
  isRevealing = false,
  isLastItem,
  forceExpanded = false,
  compactByDefault = false,
}: ThinkingDisclosureInput): boolean {
  // A successor can arrive before the reasoning stream/typewriter has drained.
  return forceExpanded || (!compactByDefault && !isSummary && (isActive || isRevealing || isLastItem));
}

/** Stream/reveal and the inner/outer scroll owners stay outside this hook. */
export function useThinkingDisclosure(input: ThinkingDisclosureInput, onExpandedChange?: (expanded: boolean) => void) {
  const defaultExpanded = defaultThinkingExpanded(input);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const userToggled = useRef(false);
  const apply = useCallback((next: boolean) => {
    if (next === expanded) return;
    setExpanded(next);
    onExpandedChange?.(next);
  }, [expanded, onExpandedChange]);
  useLayoutEffect(() => {
    if (!userToggled.current) apply(defaultExpanded);
  }, [apply, defaultExpanded]);
  const toggle = useCallback(() => {
    userToggled.current = true;
    apply(!expanded);
  }, [apply, expanded]);
  return { expanded, toggle };
}
