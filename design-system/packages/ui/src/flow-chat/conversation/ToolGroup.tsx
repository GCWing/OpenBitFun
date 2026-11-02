import { forwardRef } from 'react';
import { Icon } from '../../components/Icon/Icon';
import { FlowGroup, type FlowGroupProps } from './FlowGroup';

/** Compatibility props for the existing semantic presets. */
export interface ToolGroupProps extends Omit<FlowGroupProps, 'leading' | 'onExpandedChange'> {
  variant: 'explore' | 'context';
  kind?: 'read' | 'search' | 'command' | 'mixed' | 'other';
  counts?: { read: number; search: number; command: number };
  onToggle?: () => void;
  /** @deprecated ScrollArea now owns edge measurement. */
  scrollState?: { hasScroll: boolean; atTop: boolean; atBottom: boolean };
}

export const ToolGroup = forwardRef<HTMLDivElement, ToolGroupProps>(function ToolGroup({
  variant, kind = 'mixed', counts = { read: 0, search: 0, command: 0 }, itemCount,
  onToggle, scrollState: _scrollState, ...props
}, ref) {
  const component = variant === 'context' ? 'context-load-group' : 'explore-group';
  return <FlowGroup {...props} ref={ref} onExpandedChange={onToggle}
    leading={<Icon name={variant === 'context' ? 'layers-plus' : 'route'} size="sm" />}
    data-openbitfun-component={component} data-testid={`chat-${component}`}
    data-group-kind={variant === 'context' ? 'context' : kind}
    itemCount={itemCount ?? counts.read + counts.search + counts.command}
    data-read-count={variant === 'explore' ? String(counts.read) : undefined}
    data-search-count={variant === 'explore' ? String(counts.search) : undefined}
    data-command-count={variant === 'explore' ? String(counts.command) : undefined} />;
});
