import { forwardRef } from 'react';
import { ToolGroup, type ToolGroupProps } from './ToolGroup';

export type ContextLoadGroupProps = Omit<ToolGroupProps, 'variant' | 'kind' | 'counts' | 'summaryItems'>;

/** The host owns membership, localized summaries and persistent disclosure state. */
export const ContextLoadGroup = forwardRef<HTMLDivElement, ContextLoadGroupProps>(function ContextLoadGroup(props, ref) {
  return <ToolGroup {...props} ref={ref} variant="context" />;
});
