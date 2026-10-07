/**
 * InlineDiffPreview component.
 * Lightweight inline diff preview for tool cards.
 *
 * Design notes:
 * 1. Avoid Monaco DiffEditor (too heavy)
 * 2. Use the diff library (npm: diff) for performance
 * 3. Unified diff with whole-line change markers and syntax highlighting
 * 4. Token-first syntax highlighting: tokenize full content once via prismjs,
 *    split into per-line token arrays, render without per-line SyntaxHighlighter instances
 * 5. Row virtualization via @tanstack/react-virtual: only visible rows are in the DOM
 */

import React, { useMemo, memo, useRef, useCallback, useState, useLayoutEffect, CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ScrollArea, type ScrollAreaEdgeFade, type ScrollbarVisibility } from '@openbitfun/ui';
import { getPrismLanguage } from '@/infrastructure/language-detection';
import { createLogger } from '@/shared/utils/logger';
import { getInlineDiffTokenStyle } from './inlineDiffPrismTheme';
import { computeLineDiff, type DiffLine } from './inlineDiffModel';
import { type LineTokens, type PrismToken } from './inlineDiffTokens';
import { useHighlightedLines } from '../timeline/highlightResources';
import { FlowChatResourceCache } from '../timeline/resourceCache';
import './InlineDiffPreview.scss';
import { truncateForDiff } from './inlineDiffTruncation';

const log = createLogger('InlineDiffPreview');

/** Estimated row height in px; the virtualizer measures the resolved typography. */
const ROW_HEIGHT = 22;

const diffCache = new FlowChatResourceCache<string, DiffLine[]>(8 * 1024 * 1024, 64);

export interface InlineDiffPreviewProps {
  /** Original content. */
  originalContent: string;
  /** Modified content. */
  modifiedContent: string;
  /** File path (language detection). */
  filePath?: string;
  /** Explicit language. */
  language?: string;
  /** Max height in px. */
  maxHeight?: number;
  /** Fade scrollable preview edges. */
  edgeFade?: ScrollAreaEdgeFade;
  /** Native scrollbar visibility and idle track behavior. */
  scrollbarVisibility?: ScrollbarVisibility;
  /** Custom class name. */
  className?: string;
  /** Whether to show line numbers. */
  showLineNumbers?: boolean;
  /** Line number mode: dual=old/new columns, single=the source number for this row. */
  lineNumberMode?: 'dual' | 'single';
  /** Whether to show +/- prefix. */
  showPrefix?: boolean;
  /** Context lines around changes. */
  contextLines?: number;
  /** Row click callback. */
  onLineClick?: (lineNumber: number, type: 'original' | 'modified') => void;
}

// ---------------------------------------------------------------------------
// Tokenization utilities
// ---------------------------------------------------------------------------

/**
 * Tokenize a full content string with prismjs, return per-line token arrays.
 * Falls back to plain-text lines when the language grammar is not registered.
 */

/**
 * Render a single Prism token as a React element.
 * Mirrors what react-syntax-highlighter does internally.
 */
function renderToken(
  token: PrismToken,
  key: string | number,
): React.ReactNode {
  if (typeof token === 'string') return token;

  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  const classNames = ['token', token.type, ...aliases];
  const style = getInlineDiffTokenStyle(token);

  const children = Array.isArray(token.content)
    ? (token.content as PrismToken[]).map((child, i) => renderToken(child, i))
    : typeof token.content === 'string'
    ? token.content
    : renderToken(token.content, 0);

  return (
    <span data-openbitfun-component="inline-diff-preview" data-openbitfun-part="lineContent" key={key} className={classNames.join(' ')} style={style}>
      {children}
    </span>
  );
}

/**
 * Render a line's token array as React children.
 */
function renderTokenLine(tokens: LineTokens): React.ReactNode {
  if (!tokens || tokens.length === 0) return '\u00A0'; // non-breaking space for empty lines
  return tokens.map((token, i) => renderToken(token, i));
}

// ---------------------------------------------------------------------------
// Context folding
// ---------------------------------------------------------------------------

function applyContextCollapsing(lines: DiffLine[], contextLines: number): DiffLine[] {
  if (contextLines < 0) return lines;

  const changeIndices: number[] = [];
  lines.forEach((line, index) => {
    if (line.type === 'added' || line.type === 'removed') changeIndices.push(index);
  });

  if (changeIndices.length === 0) {
    return [{ type: 'context-separator', content: 'No differences; contents are identical.' }];
  }

  const showLine = new Set<number>();
  for (const idx of changeIndices) {
    for (let i = Math.max(0, idx - contextLines); i <= Math.min(lines.length - 1, idx + contextLines); i++) {
      showLine.add(i);
    }
  }

  const result: DiffLine[] = [];
  let lastShownIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (showLine.has(i)) {
      if (lastShownIndex >= 0 && i > lastShownIndex + 1) {
        result.push({ type: 'context-separator', content: `... omitted ${i - lastShownIndex - 1} lines ...` });
      }
      result.push(lines[i]);
      lastShownIndex = i;
    }
  }

  if (result.length > 0 && result[0].type !== 'context-separator') {
    const firstShownIdx = Array.from(showLine).sort((a, b) => a - b)[0];
    if (firstShownIdx > 0) {
      result.unshift({ type: 'context-separator', content: `... omitted first ${firstShownIdx} lines ...` });
    }
  }

  if (lastShownIndex < lines.length - 1) {
    result.push({
      type: 'context-separator',
      content: `... omitted last ${lines.length - 1 - lastShownIndex} lines ...`,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * InlineDiffPreview component.
 *
 * Performance model:
 *   - Tokenize originalContent once  (useMemo)
 *   - Tokenize modifiedContent once  (useMemo)
 *   - Virtualize syntax-highlighted rows; measure width with one plain-text node
 */
export const InlineDiffPreview: React.FC<InlineDiffPreviewProps> = memo(({
  originalContent,
  modifiedContent,
  filePath,
  language,
  maxHeight = 300,
  edgeFade = 'vertical',
  scrollbarVisibility = 'auto',
  className = '',
  showLineNumbers = true,
  lineNumberMode = 'single',
  showPrefix = false,
  contextLines = 3,
  onLineClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);

  const detectedLanguage = useMemo(() => {
    if (language) return language;
    if (filePath) return getPrismLanguage(filePath);
    return 'text';
  }, [language, filePath]);

  // Truncate very large inputs before diff/tokenization to protect the main thread.
  const truncated = useMemo(
    () => truncateForDiff(originalContent, modifiedContent),
    [originalContent, modifiedContent],
  );

  // Compute diff line list (fast, O(ND))
  const diffLineList = useMemo<DiffLine[]>(() => {
    try {
      const key = JSON.stringify([truncated.originalContent, truncated.modifiedContent, contextLines]);
      const cached = diffCache.get(key);
      if (cached) return cached;
      const rawDiff = computeLineDiff(truncated.originalContent, truncated.modifiedContent);
      const lines = applyContextCollapsing(rawDiff, contextLines);
      diffCache.set(key, lines, key.length * 2 + lines.reduce((bytes, line) => bytes + line.content.length * 2 + 80, 0));
      return lines;
    } catch (error) {
      log.error('Diff computation failed', error);
      return [{ type: 'context-separator' as const, content: 'Diff computation failed; file may be too large.' }];
    }
  }, [truncated.originalContent, truncated.modifiedContent, contextLines]);

  // One hidden plain-text node supplies the intrinsic width of every line,
  // including offscreen rows. Horizontal scrolling stays stable as rows mount.
  const widthContent = useMemo(
    () => diffLineList.filter(line => line.type !== 'context-separator').map(line => line.content).join('\n'),
    [diffLineList],
  );
  const lineNumberDigits = useMemo(() => Math.max(2, ...diffLineList.map(line =>
    String(Math.max(line.originalLineNumber ?? 0, line.modifiedLineNumber ?? 0)).length)), [diffLineList]);

  // Tokenize each content once — O(content_length), not O(lines²)
  const originalLineTokens = useHighlightedLines(truncated.originalContent, detectedLanguage);
  const modifiedLineTokens = useHighlightedLines(truncated.modifiedContent, detectedLanguage);

  // Line number → token array lookup helpers
  const getTokensForLine = useCallback(
    (line: DiffLine): LineTokens => {
      if (line.type === 'removed') {
        const idx = (line.originalLineNumber ?? 1) - 1;
        return originalLineTokens[idx] ?? [line.content];
      }
      if (line.type === 'added' || line.type === 'unchanged') {
        const idx = (line.modifiedLineNumber ?? 1) - 1;
        return modifiedLineTokens[idx] ?? [line.content];
      }
      return [line.content];
    },
    [originalLineTokens, modifiedLineTokens],
  );

  // Keep dynamic measurement for custom font sizes and context separators.
  const virtualizer = useVirtualizer({
    count: diffLineList.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Re-render when the viewport changes so measured rows stay aligned.
  // We use a generation counter to force re-renders WITHOUT calling
  // virtualizer.measure() — measure() resets the measurements cache and
  // would discard heights already captured by measureElement refs.
  const [measureGeneration, setMeasureGeneration] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // On mount, after measureElement refs have stored actual heights,
    // force a synchronous re-render so getVirtualItems() uses those
    // measurements instead of the 22 px estimates.  Without this,
    // custom line heights can cause rows to overlap
    // because their translateY positions are based on wrong estimates.
    setMeasureGeneration((g) => g + 1);

    const ro = new ResizeObserver(() => {
      // Container dimensions changed; re-render so the
      // virtualizer picks up the new measureElement heights.
      setMeasureGeneration((g) => g + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleLineClick = useCallback(
    (index: number, line: DiffLine) => {
      if (line.type === 'context-separator') return;
      setHighlightedLine(prev => (prev === index ? null : index));
      if (onLineClick) {
        const lineNum = line.type === 'removed' ? line.originalLineNumber : line.modifiedLineNumber;
        const type = line.type === 'removed' ? 'original' : 'modified';
        if (lineNum) onLineClick(lineNum, type);
      }
    },
    [onLineClick],
  );

  if (!originalContent && !modifiedContent) {
    return (
      <div data-openbitfun-component="inline-diff-preview" data-openbitfun-part="root" data-openbitfun-state="empty" className={`inline-diff-preview inline-diff-preview--empty ${className}`}>
        <span className="inline-diff-preview__placeholder" data-openbitfun-component="inline-diff-preview" data-openbitfun-part="placeholder">No content</span>
      </div>
    );
  }

  const totalHeight = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // measureGeneration is a render-trigger counter (bumped by useLayoutEffect
  // and ResizeObserver).  Referencing it here proves to TypeScript that the
  // state is consumed; the virtualizer's getTotalSize / getVirtualItems are
  // called unconditionally above and naturally pick up the measurements that
  // measureElement refs store before the first paint.
  void measureGeneration;

  const renderGutter = (originalNumber: number | string, modifiedNumber: number | string, removed = false) => (
    showLineNumbers && (
      <span
        className={`diff-line__gutter${lineNumberMode === 'single' ? ' diff-line__gutter--single' : ''}`}
        data-openbitfun-component="inline-diff-preview"
        data-openbitfun-part="gutter"
        aria-hidden="true"
      >
        {lineNumberMode === 'single' ? (
          <span className="diff-line__num">{removed ? originalNumber : modifiedNumber}</span>
        ) : (
          <>
            <span className="diff-line__num diff-line__num--original">{originalNumber}</span>
            <span className="diff-line__num diff-line__num--modified">{modifiedNumber}</span>
          </>
        )}
      </span>
    )
  );

  return (
    <div
      data-openbitfun-component="inline-diff-preview"
      data-openbitfun-part="root"
      data-line-numbers={showLineNumbers ? 'visible' : 'hidden'}
      className={`inline-diff-preview ${className}`}
      style={{ '--_diff-number-digits': lineNumberDigits } as CSSProperties}
    >
      {truncated.truncated && (
        <div className="inline-diff-preview__truncation-notice" data-openbitfun-component="inline-diff-preview" data-openbitfun-part="notice">
          Content too large; showing first and last portions{truncated.omittedLines === null ? '.' : ` (${truncated.omittedLines} lines omitted).`}
        </div>
      )}
      <ScrollArea
        ref={containerRef}
        className="inline-diff-preview__content"
        orientation="both"
        edgeFade={edgeFade}
        scrollbarVisibility={scrollbarVisibility}
        overscrollBehaviorY="auto"
        data-openbitfun-component="inline-diff-preview"
        data-openbitfun-part="content"
        style={{ maxHeight: `${maxHeight}px` }}
        tabIndex={0}
      >
        <div className="inline-diff-preview__canvas" style={{ height: totalHeight }}>
          <div className="diff-line inline-diff-preview__sizer" aria-hidden="true">
            {renderGutter('', '')}
            {showPrefix && <span className="diff-line__prefix" />}
            <span className="diff-line__content">{widthContent}</span>
          </div>
          {virtualItems.map(virtualRow => {
            const line = diffLineList[virtualRow.index];
            const isHighlighted = highlightedLine === virtualRow.index;

            if (line.type === 'context-separator') {
              return (
                <div data-openbitfun-component="inline-diff-preview" data-openbitfun-part="line"
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  className="diff-line diff-line--separator"
                  data-index={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <span className="diff-line__gutter diff-line__gutter--separator" />
                  <span className="diff-line__content diff-line__content--separator">{line.content}</span>
                </div>
              );
            }

            const lineClass = [
              'diff-line',
              `diff-line--${line.type}`,
              isHighlighted ? 'diff-line--highlighted' : '',
            ]
              .filter(Boolean)
              .join(' ');

            const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
            const lineTokens = getTokensForLine(line);

            return (
              <div data-openbitfun-component="inline-diff-preview" data-openbitfun-part="line"
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                className={lineClass}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => handleLineClick(virtualRow.index, line)}
              >
                {renderGutter(line.originalLineNumber ?? '', line.modifiedLineNumber ?? '', line.type === 'removed')}
                <span
                  className={`diff-line__prefix${showPrefix ? '' : ' diff-line__prefix--hidden'}`}
                  data-openbitfun-component="inline-diff-preview"
                  data-openbitfun-part="prefix"
                >{prefix}</span>
                <span
                  className="diff-line__content"
                  data-openbitfun-component="inline-diff-preview"
                  data-openbitfun-part="lineContent"
                >
                  {renderTokenLine(lineTokens)}
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
});

InlineDiffPreview.displayName = 'InlineDiffPreview';

export default InlineDiffPreview;
