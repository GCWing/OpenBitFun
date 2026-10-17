import React, { useEffect, useLayoutEffect, useState } from 'react';
import { getLoadedPrismSyntaxHighlighter, loadPrismSyntaxHighlighter } from '@/shared/utils/syntaxHighlighterLoader';
import { scheduleAfterStartupPaint } from '@/shared/utils/startupTaskScheduling';
import { ensureCangjiePrismLanguage } from './cangjiePrismLanguage';
import {
  isStartupRenderTraceEnabled,
  recordReactRenderProfile,
  startupTrace,
} from '@/shared/utils/startupTrace';
import type { FlowCodeBlockFallbackProps, MarkdownTraceContext } from './MarkdownRenderer';

interface AsyncPrismSyntaxHighlighterProps {
  language: string;
  style: Record<string, React.CSSProperties>;
  showLineNumbers?: boolean;
  customStyle?: React.CSSProperties;
  codeTagProps?: { style?: React.CSSProperties; [key: string]: unknown };
  lineNumberStyle?: React.CSSProperties;
  fallback?: React.ComponentType<FlowCodeBlockFallbackProps>;
  fallbackProps?: FlowCodeBlockFallbackProps;
  /**
   * Keep the lightweight fallback mounted even when Prism is already loaded.
   * Used while chat text is still streaming so we do not remount the code-block
   * tree (Fallback ↔ Prism) on every streaming flag flip.
   */
  preferFallback?: boolean;
  traceContext?: MarkdownTraceContext;
  children: string;
}

interface PrismRenderTraceProps {
  startedAtMs: number;
  renderPhase: 'fallback_commit' | 'highlighted_commit';
  contentLength: number;
  traceContext?: MarkdownTraceContext;
}

const AppearanceCodePre = React.forwardRef<HTMLPreElement, React.HTMLAttributes<HTMLPreElement>>(
  (props, ref) => (
    <pre
      {...props}
      ref={ref}
      data-openbitfun-component="markdown"
      data-openbitfun-part="codePre"
    />
  ),
);
AppearanceCodePre.displayName = 'AppearanceCodePre';

const PrismRenderTrace: React.FC<PrismRenderTraceProps> = ({
  startedAtMs,
  renderPhase,
  contentLength,
  traceContext,
}) => {
  useLayoutEffect(() => {
    recordReactRenderProfile(startupTrace, {
      component: 'AsyncPrismSyntaxHighlighter',
      phase: renderPhase,
      actualDurationMs: performance.now() - startedAtMs,
      contentLength,
      turnId: traceContext?.turnId,
      roundId: traceContext?.roundId,
      itemId: traceContext?.itemId,
      hasCodeBlock: true,
    });
  });

  return null;
};

export const AsyncPrismSyntaxHighlighter: React.FC<AsyncPrismSyntaxHighlighterProps> = ({
  language,
  style,
  showLineNumbers,
  customStyle,
  codeTagProps,
  lineNumberStyle,
  fallback: Fallback,
  fallbackProps,
  preferFallback = false,
  traceContext,
  children,
}) => {
  const [Highlighter, setHighlighter] = useState<React.ComponentType<any> | null>(() => getLoadedPrismSyntaxHighlighter());
  const renderTraceEnabled = isStartupRenderTraceEnabled();
  const renderTraceStartedAtMs = renderTraceEnabled ? performance.now() : null;

  useEffect(() => {
    if (Highlighter) {
      return;
    }

    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;

    const clearScheduledLoad = () => {
      if (idleHandle !== null) {
        const cancelIdle = (globalThis as {
          cancelIdleCallback?: (handle: number) => void;
        }).cancelIdleCallback;
        if (typeof cancelIdle === 'function') {
          cancelIdle(idleHandle);
        } else {
          globalThis.clearTimeout(idleHandle);
        }
        idleHandle = null;
      }

      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const startLoad = () => {
      clearScheduledLoad();
      void loadPrismSyntaxHighlighter()
        .then((component) => {
          if (!cancelled) {
            ensureCangjiePrismLanguage(component);
            setHighlighter(() => component);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHighlighter(null);
          }
        });
    };

    const scheduleIdleLoad = () => {
      const requestIdle = (globalThis as {
        requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      }).requestIdleCallback;

      if (typeof requestIdle === 'function') {
        idleHandle = requestIdle(startLoad, { timeout: 1500 });
        return;
      }

      timeoutHandle = globalThis.setTimeout(startLoad, 200) as unknown as number;
    };

    const cancelAfterPaint = scheduleAfterStartupPaint(scheduleIdleLoad, { frameCount: 2 });

    return () => {
      cancelled = true;
      cancelAfterPaint();
      clearScheduledLoad();
    };
  }, [Highlighter]);

  const traceMarker = renderTraceEnabled && renderTraceStartedAtMs !== null ? (
    <PrismRenderTrace
      startedAtMs={renderTraceStartedAtMs}
      renderPhase={Highlighter ? 'highlighted_commit' : 'fallback_commit'}
      contentLength={children.length}
      traceContext={traceContext}
    />
  ) : null;

  if (!Highlighter || preferFallback) {
    if (Fallback && fallbackProps) {
      return (
        <>
          {traceMarker}
          <Fallback {...fallbackProps} />
        </>
      );
    }

    return (
      <>
        {traceMarker}
        <pre
          className={`language-${language} code-block-fallback`}
          style={customStyle}
          data-openbitfun-component="markdown"
          data-openbitfun-part="codePre"
        >
          <code
            {...codeTagProps}
            style={codeTagProps?.style}
            data-openbitfun-component="markdown"
            data-openbitfun-part="codeContent"
          >
            {children}
          </code>
        </pre>
      </>
    );
  }

  return (
    <>
      {traceMarker}
      <Highlighter
        language={language}
        style={style}
        showLineNumbers={showLineNumbers}
        customStyle={customStyle}
        PreTag={AppearanceCodePre}
        codeTagProps={{
          ...codeTagProps,
          'data-openbitfun-component': 'markdown',
          'data-openbitfun-part': 'codeContent',
        }}
        lineNumberStyle={lineNumberStyle}
      >
        {children}
      </Highlighter>
    </>
  );
};
