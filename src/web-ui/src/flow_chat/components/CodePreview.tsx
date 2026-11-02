/**
 * CodePreview component
 * Lightweight, read-only code preview with syntax highlighting and streaming support
 *
 * Design notes:
 * 1. Use react-syntax-highlighter (Prism) instead of Monaco Editor
 *    - Monaco is heavy (2-3MB per instance) and hurts virtual list performance
 *    - Prism is lightweight and works well with streaming re-renders
 * 2. Auto-detect language from file extension
 * 3. Use memoization to avoid unnecessary re-renders
 * 4. Large content can be truncated when exceeding limits
 */

import React, { useMemo, memo, useRef, useEffect, useState, useCallback, useDeferredValue } from 'react';
import { getPrismLanguage } from '@/infrastructure/language-detection';
import { useAppearance } from '@/infrastructure/appearance';
import { getLoadedPrismSyntaxHighlighter, loadPrismSyntaxHighlighter } from '@/shared/utils/syntaxHighlighterLoader';
import { buildCodePreviewPrismStyle } from './codePreviewPrismTheme';
import { ScrollArea, type ScrollAreaEdgeFade, type ScrollbarVisibility } from '@openbitfun/ui';
import './CodePreview.scss';
import { WindowedCodeContent } from './WindowedCodeContent';

export interface CodePreviewProps {
  /** Code content */
  content: string;
  /** File path (used for language detection and navigation) */
  filePath?: string;
  /** Explicit language (overrides auto-detection) */
  language?: string;
  /** Whether streaming is in progress */
  isStreaming?: boolean;
  /** Whether to show line numbers */
  showLineNumbers?: boolean;
  /** Add the preview inset when the owning tool card uses a flush body. */
  inset?: boolean;
  /** Custom class name */
  className?: string;
  /** Auto-scroll to bottom while streaming */
  autoScrollToBottom?: boolean;
  /** Max height (px) */
  maxHeight?: number;
  /** Fade scrollable preview edges. */
  edgeFade?: ScrollAreaEdgeFade;
  /** Native scrollbar visibility and idle track behavior. */
  scrollbarVisibility?: ScrollbarVisibility;
  /** Line click callback (line numbers start at 1) */
  onLineClick?: (lineNumber: number, filePath?: string) => void;
}

/**
 * Detect language from file path using the global language detection service.
 */
function detectLanguageFromPath(filePath: string): string {
  if (!filePath) return 'text';
  return getPrismLanguage(filePath);
}

// typography-audit: allow -- virtualization estimate only; rendered code uses type.flow.code
const CODE_PREVIEW_STREAMING_LINE_HEIGHT_PX = 22;
const STREAMING_TAIL_MIN_LINES = 4;
const STREAMING_TAIL_MAX_LINES = 24;
const STREAMING_TAIL_OVERSCAN_LINES = 2;
const STREAMING_TAIL_MAX_CHARS = 6000;

function countNewlines(value: string, endExclusive = value.length): number {
  let count = 0;
  const end = Math.min(endExclusive, value.length);
  for (let index = 0; index < end; index += 1) {
    if (value.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

function getStreamingTailLineLimit(maxHeight: number, includeOverscan: boolean): number {
  const visibleLines = Math.max(1, Math.ceil(maxHeight / CODE_PREVIEW_STREAMING_LINE_HEIGHT_PX));
  const desiredLines = includeOverscan
    ? visibleLines + STREAMING_TAIL_OVERSCAN_LINES
    : visibleLines;
  const minimumLines = includeOverscan ? STREAMING_TAIL_MIN_LINES : 1;

  return Math.min(
    STREAMING_TAIL_MAX_LINES,
    Math.max(minimumLines, desiredLines),
  );
}

function getStreamingTailDisplayContent(content: string, maxHeight: number, includeOverscan: boolean): {
  content: string;
  startingLineNumber: number;
} {
  const tailLineLimit = getStreamingTailLineLimit(maxHeight, includeOverscan);
  const totalLineCount = countNewlines(content) + 1;

  if (totalLineCount <= tailLineLimit && content.length <= STREAMING_TAIL_MAX_CHARS) {
    return { content, startingLineNumber: 1 };
  }

  let sliceStart = 0;
  let remainingLineBreaks = tailLineLimit;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content.charCodeAt(index) !== 10) {
      continue;
    }

    remainingLineBreaks -= 1;
    if (remainingLineBreaks === 0) {
      sliceStart = index + 1;
      break;
    }
  }

  if (content.length - sliceStart > STREAMING_TAIL_MAX_CHARS) {
    sliceStart = Math.max(sliceStart, content.length - STREAMING_TAIL_MAX_CHARS);
  }

  return {
    content: content.slice(sliceStart),
    startingLineNumber: countNewlines(content, sliceStart) + 1,
  };
}

/**
 * CodePreview component with streaming-friendly syntax highlighting.
 */
export const CodePreview: React.FC<CodePreviewProps> = memo(({
  content,
  filePath,
  language,
  isStreaming = false,
  showLineNumbers = true,
  className = '',
  inset = false,
  autoScrollToBottom = true,
  maxHeight = 400,
  edgeFade = 'vertical',
  scrollbarVisibility = 'auto',
  onLineClick,
}) => {
  const { current: appearance } = useAppearance();
  const isLight = appearance?.mode === 'light';
  const prismStyle = useMemo(() => buildCodePreviewPrismStyle(isLight), [isLight]);
  const [SyntaxHighlighter, setSyntaxHighlighter] = useState<React.ComponentType<any> | null>(() => getLoadedPrismSyntaxHighlighter());

  const containerRef = useRef<HTMLDivElement>(null);
  const prevContentLengthRef = useRef(0);

  // During streaming, content updates at high frequency. Defer the highlighted
  // content passed to SyntaxHighlighter so that auto-scroll and cursor updates
  // (which use the real content) remain responsive on the main thread while
  // tokenization runs during browser idle time.
  const deferredContent = useDeferredValue(content);

  // Prism and line-number DOM are synchronous work. While params are streaming,
  // keep this preview near the visible viewport instead of tokenizing a large
  // hidden tail on every batch. The completed view still receives full content.
  const displayContentInfo = useMemo(() => {
    if (!isStreaming) {
      return { content: deferredContent, startingLineNumber: 1 };
    }

    return getStreamingTailDisplayContent(deferredContent, maxHeight, autoScrollToBottom);
  }, [isStreaming, deferredContent, maxHeight, autoScrollToBottom]);

  const displayContent = displayContentInfo.content;

  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPrismSyntaxHighlighter()
      .then((component) => {
        if (!cancelled) {
          setSyntaxHighlighter(() => component);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSyntaxHighlighter(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);
  
  const detectedLanguage = useMemo(() => {
    if (language) return language;
    if (filePath) return detectLanguageFromPath(filePath);
    return 'text';
  }, [language, filePath]);
  
  // Auto-scroll only when content grows during streaming.
  useEffect(() => {
    if (!autoScrollToBottom || !isStreaming || !containerRef.current) return;
    
    if (content.length > prevContentLengthRef.current) {
      const container = containerRef.current;
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
    
    prevContentLengthRef.current = content.length;
  }, [content, isStreaming, autoScrollToBottom]);
  
  const handleLineClick = useCallback((lineNumber: number) => {
    setHighlightedLine(prev => prev === lineNumber ? null : lineNumber);
    // Trigger callback for editor navigation.
    onLineClick?.(lineNumber, filePath);
  }, [onLineClick, filePath]);
  
  const lineProps = useCallback((lineNumber: number): React.HTMLProps<HTMLElement> => {
    const actualLineNumber = displayContentInfo.startingLineNumber + lineNumber - 1;
    const isHighlighted = highlightedLine === actualLineNumber;
    return {
      style: {
        display: 'block',
        backgroundColor: isHighlighted
          ? 'color-mix(in srgb, var(--openbitfun-color-accent-default) 15%, transparent)'
          : 'transparent',
        // Paint the rail outside the text without adding to the line's inset.
        boxShadow: isHighlighted ? '-3px 0 var(--openbitfun-color-accent-default)' : 'none',
        padding: 0,
        transition: 'background-color 0.15s ease',
      },
      onClick: () => handleLineClick(actualLineNumber),
      className: isHighlighted ? 'code-line--highlighted' : '',
    };
  }, [highlightedLine, handleLineClick, displayContentInfo.startingLineNumber]);
  
  if (!content) {
    return (
      <div data-openbitfun-component="code-preview" data-openbitfun-part="root" data-openbitfun-state="empty" className={`code-preview code-preview--empty ${className}`}>
        <span data-openbitfun-component="code-preview" data-openbitfun-part="placeholder" className="code-preview__placeholder">No content</span>
      </div>
    );
  }
  
  const containerStyle: React.CSSProperties = {
    maxHeight: `${maxHeight}px`,
  };
  
  return (
    <div data-openbitfun-component="code-preview" data-openbitfun-part="root" data-openbitfun-state={isStreaming ? 'streaming' : undefined} className={`code-preview ${isStreaming ? 'code-preview--streaming' : ''} ${className}`}>
      <ScrollArea
        edgeFade={edgeFade}
        scrollbarVisibility={scrollbarVisibility}
        orientation="both"
        overscrollBehaviorY="auto"
        ref={containerRef}
        data-openbitfun-component="code-preview"
        data-openbitfun-part="content"
        className="code-preview__content"
        data-inset={inset ? "true" : undefined}
        style={containerStyle}
        tabIndex={0}
      >
        {!isStreaming && (displayContent.length > 8000 || countNewlines(displayContent) > 120) ? (
          <WindowedCodeContent content={displayContent} language={detectedLanguage} scrollerRef={containerRef}
            startingLineNumber={displayContentInfo.startingLineNumber} showLineNumbers={showLineNumbers}
            highlightedLine={highlightedLine} onLineClick={handleLineClick} />
        ) : SyntaxHighlighter ? (
          <SyntaxHighlighter
            language={detectedLanguage}
            style={prismStyle}
            showLineNumbers={showLineNumbers}
            startingLineNumber={displayContentInfo.startingLineNumber}
            wrapLines={true}
            wrapLongLines={false}
            lineProps={lineProps}
            customStyle={{
              margin: 0,
              padding: 0,
              background: 'transparent',
              overflow: 'visible',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'var(--openbitfun-type-flow-code-font-family)',
                fontSize: 'var(--openbitfun-type-flow-code-font-size)',
                lineHeight: 'var(--openbitfun-type-flow-code-line-height)',
                fontWeight: 'var(--openbitfun-type-flow-code-font-weight)',
              }
            }}
            lineNumberStyle={{
              minWidth: '2.5em',
              paddingRight: '1em',
              textAlign: 'right',
              userSelect: 'none',
              color: 'var(--openbitfun-color-content-muted)',
              opacity: isLight ? 0.88 : 0.6,
            }}
          >
            {displayContent}
          </SyntaxHighlighter>
        ) : (
          <pre data-openbitfun-component="code-preview" data-openbitfun-part="plain" className="code-preview__plain" aria-label="Code preview">
            <code>
              {displayContent.split('\n').map((line, index) => {
                const lineNumber = displayContentInfo.startingLineNumber + index;
                return (
                  <span data-openbitfun-component="code-preview" data-openbitfun-part="line" data-openbitfun-state={highlightedLine === lineNumber ? 'highlighted' : undefined}
                    key={`${lineNumber}-${index}`}
                    className={`code-preview__plain-line${highlightedLine === lineNumber ? ' code-preview__plain-line--highlighted' : ''}`}
                    onClick={() => handleLineClick(lineNumber)}
                  >
                    {showLineNumbers && (
                      <span data-openbitfun-component="code-preview" data-openbitfun-part="lineNumber" className="code-preview__plain-line-number">{lineNumber}</span>
                    )}
                    <span data-openbitfun-component="code-preview" data-openbitfun-part="lineContent" className="code-preview__plain-line-content">{line || '\u00A0'}</span>
                  </span>
                );
              })}
            </code>
          </pre>
        )}
        
        {/* Streaming cursor indicator */}
        {isStreaming && (
          <span data-openbitfun-component="code-preview" data-openbitfun-part="cursor" className="code-preview__cursor" />
        )}
      </ScrollArea>
    </div>
  );
});

CodePreview.displayName = 'CodePreview';

export default CodePreview;

