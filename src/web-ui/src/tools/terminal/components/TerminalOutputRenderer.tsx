import { forwardRef } from 'react';
import { TerminalOutputRenderer as SharedRenderer, type TerminalOutputRendererHandle, type TerminalOutputRendererProps as SharedProps } from '@openbitfun/flow-chat-presentation/terminal/renderer';
import { terminalOutputHost } from './terminalOutputHost';

export type TerminalOutputRendererProps = Omit<SharedProps, 'host'>;
export type { TerminalOutputRendererHandle };
export const TerminalOutputRenderer = forwardRef<TerminalOutputRendererHandle, TerminalOutputRendererProps>((props, ref) => (
  <SharedRenderer {...props} ref={ref} host={terminalOutputHost} />
));
TerminalOutputRenderer.displayName = 'TerminalOutputRenderer';
export default TerminalOutputRenderer;
