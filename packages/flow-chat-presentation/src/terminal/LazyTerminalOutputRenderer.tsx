import React, { forwardRef, Suspense, useMemo } from 'react';
import type {
  TerminalOutputRendererHandle,
  TerminalOutputRendererProps,
} from './TerminalOutputRenderer';
import {
  buildTerminalOutputFallbackModel,
  type TerminalOutputFallbackModel,
} from './terminalOutputPresentation';
import './TerminalOutputRenderer.css';

const DeferredTerminalOutputRenderer = React.lazy(() =>
  import('./TerminalOutputRenderer').then((module) => ({
    default: module.TerminalOutputRenderer,
  }))
);
export function TerminalOutputFallback({
  className,
  content,
  minHeight,
  maxHeight,
  maxRows,
}: Pick<TerminalOutputRendererProps, 'className' | 'content' | 'minHeight' | 'maxHeight' | 'maxRows'>) {
  const fallback = buildTerminalOutputFallbackModel(content, { minHeight, maxHeight, maxRows });

  return (
    <pre
      className={['terminal-output-pre', className].filter(Boolean).join(' ')}
      data-openbitfun-component="terminal-tool"
      data-openbitfun-part="output"
      style={{
        height: `${fallback.height}px`,
        maxHeight: `${fallback.height}px`,
        overflow: 'hidden',
      }}
    >
      {fallback.content}
    </pre>
  );
}

export const LazyTerminalOutputRenderer = forwardRef<
  TerminalOutputRendererHandle,
  TerminalOutputRendererProps
>((props, ref) => {
  const initialFallback = useMemo<TerminalOutputFallbackModel>(
    () => buildTerminalOutputFallbackModel(props.content, {
      minHeight: props.minHeight,
      maxHeight: props.maxHeight,
      maxRows: props.maxRows,
    }),
    [props.content, props.maxHeight, props.maxRows, props.minHeight],
  );

  return (
    <Suspense fallback={<TerminalOutputFallback {...props} />}>
      <DeferredTerminalOutputRenderer
        {...props}
        ref={ref}
        initialFallback={initialFallback}
      />
    </Suspense>
  );
});

LazyTerminalOutputRenderer.displayName = 'LazyTerminalOutputRenderer';

export type {
  TerminalOutputRendererHandle,
  TerminalOutputRendererProps,
};
