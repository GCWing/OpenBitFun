import { forwardRef } from 'react';
import { LazyTerminalOutputRenderer as SharedRenderer, type TerminalOutputRendererHandle, type TerminalOutputRendererProps as SharedProps } from '@openbitfun/flow-chat-presentation/terminal';
import { terminalOutputHost } from './terminalOutputHost';

export type TerminalOutputRendererProps = Omit<SharedProps, 'host'>;
export type { TerminalOutputRendererHandle };
export const LazyTerminalOutputRenderer = forwardRef<TerminalOutputRendererHandle, TerminalOutputRendererProps>((props, ref) => (
  <SharedRenderer {...props} ref={ref} host={terminalOutputHost} />
));
LazyTerminalOutputRenderer.displayName = 'LazyTerminalOutputRenderer';
export default LazyTerminalOutputRenderer;
export { TerminalOutputFallback } from '@openbitfun/flow-chat-presentation/terminal';
