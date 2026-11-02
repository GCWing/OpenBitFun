import { forwardRef } from 'react';
import { ToolGroup, type ToolGroupProps } from './ToolGroup';

export type ExploreGroupProps = Omit<ToolGroupProps, 'variant'>;

/** Controlled exploration using the shared tool-group disclosure anatomy. */
export const ExploreGroup = forwardRef<HTMLDivElement, ExploreGroupProps>(function ExploreGroup(props, ref) {
  return <ToolGroup {...props} ref={ref} variant="explore" />;
});
