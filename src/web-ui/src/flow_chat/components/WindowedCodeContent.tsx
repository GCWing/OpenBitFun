import React, { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useHighlightedLines } from '../timeline/highlightResources';
import { getInlineDiffTokenStyle } from './inlineDiffPrismTheme';
import type { PrismToken } from './inlineDiffTokens';

function tokenNode(token: PrismToken, key: number): React.ReactNode {
  if (typeof token === 'string') return token;
  return <span key={key} style={getInlineDiffTokenStyle(token)}>{Array.isArray(token.content)
    ? token.content.map((child, index) => tokenNode(child, index))
    : typeof token.content === 'string' ? token.content : tokenNode(token.content, 0)}</span>;
}

/**
 * Resolve the source line box to pixels before feeding it to the virtualizer.
 *
 * `line-height` is a unitless design token (`1.52` in the code role). The
 * computed style keeps that value unitless, while the virtualizer's offsets
 * are pixels. Treating the result of `parseFloat` as pixels makes every later
 * decoration row drift farther from the native text row.
 */
export function readLineHeight(source: HTMLElement): number | null {
  const computed = getComputedStyle(source);
  const rawLineHeight = computed.lineHeight.trim();
  const value = Number.parseFloat(rawLineHeight);
  if (!Number.isFinite(value) || value <= 0) return null;

  if (rawLineHeight.endsWith('px')) return value;

  const fontSize = Number.parseFloat(computed.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? value * fontSize : null;
}

export function getVisibleCodeLineCount(splitLineCount: number, hasTrailingNewline: boolean): number {
  return Math.max(1, splitLineCount - (hasTrailingNewline ? 1 : 0));
}

function readNativeLineRect(source: HTMLElement, lineIndex: number): { top: number; height: number } | null {
  const text = source.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return null;
  const value = text.textContent ?? '';
  let start = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    const newline = value.indexOf('\n', start);
    if (newline < 0) return null;
    start = newline + 1;
  }
  const newline = value.indexOf('\n', start);
  const end = newline < 0 ? value.length : newline;
  const range = document.createRange();
  range.setStart(text, Math.min(start, value.length));
  range.setEnd(text, Math.min(Math.max(start + (end - start), start + 1), value.length));
  const rect = typeof range.getClientRects === 'function' ? range.getClientRects()[0] : null;
  return rect ? { top: rect.top, height: rect.height } : null;
}

function readActualLineHeight(source: HTMLElement, lineCount: number): number | null {
  if (lineCount < 2) return null;
  const sampleLine = Math.min(lineCount - 1, 32);
  const first = readNativeLineRect(source, 0);
  const sample = readNativeLineRect(source, sampleLine);
  if (!first || !sample || sample.top <= first.top) return null;
  const lineHeight = (sample.top - first.top) / sampleLine;
  return Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : null;
}

/** Keep one native text node for selection/copy/accessibility. Only the expensive
 * syntax-token and line-number decorations are virtualized in the existing pane. */
export function WindowedCodeContent({ content, language, scrollerRef, startingLineNumber, showLineNumbers, highlightedLine, onLineClick }: {
  content: string; language: string; scrollerRef: RefObject<HTMLDivElement | null>;
  startingLineNumber: number; showLineNumbers: boolean; highlightedLine: number | null;
  onLineClick: (line: number) => void;
}) {
  const lines = useHighlightedLines(content, language);
  const { plain, visibleLineCount } = useMemo(() => {
    const plain = content.split('\n');
    return {
      plain,
      visibleLineCount: getVisibleCodeLineCount(plain.length, content.endsWith('\n')),
    };
  }, [content]);
  const [lineHeight, setLineHeight] = useState(22);
  const rootRef = useRef<HTMLPreElement>(null);
  const sourceRef = useRef<HTMLElement>(null);
  const virtualizer = useVirtualizer({ count: visibleLineCount, getScrollElement: () => scrollerRef.current,
    estimateSize: () => lineHeight, overscan: 5 });
  useLayoutEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    const measure = () => {
      const cssLineHeight = readLineHeight(source);
      const actualLineHeight = readActualLineHeight(source, visibleLineCount);
      const next = actualLineHeight ?? cssLineHeight;
      if (next !== null) setLineHeight(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(source); measure();
    return () => observer.disconnect();
  }, [content.length, visibleLineCount, scrollerRef]);

  // The first virtualizer pass uses the fallback 22px estimate. Once the
  // source line box is measured, invalidate TanStack Virtualizer's cached
  // estimates so every row is projected with the resolved line height.
  const previousLineHeightRef = useRef(lineHeight);
  useLayoutEffect(() => {
    if (previousLineHeightRef.current === lineHeight) return;
    previousLineHeightRef.current = lineHeight;
    virtualizer.measure();
  }, [lineHeight, virtualizer]);

  return <pre ref={rootRef} className="code-preview__plain" data-openbitfun-component="code-preview" data-openbitfun-part="plain"
    style={{ minHeight: virtualizer.getTotalSize(), position: 'relative', width: 'max-content', minWidth: '100%' }}
    onClick={event => {
      if (!window.getSelection()?.isCollapsed) return;
      const index = Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top) / lineHeight);
      if (index >= 0 && index < visibleLineCount) onLineClick(startingLineNumber + index);
    }}>
    <code ref={sourceRef} data-code-source="" style={{
      color: 'transparent',
      paddingInlineStart: showLineNumbers ? '3.5em' : undefined,
    }}>{content}</code>
    <span aria-hidden="true" className="code-preview__decorations"
      style={{ pointerEvents: 'none', userSelect: 'none', color: 'var(--openbitfun-color-content-primary)' }}>
      {virtualizer.getVirtualItems().map(row => {
      const number = startingLineNumber + row.index;
      return <span key={row.key} className={`code-preview__plain-line${highlightedLine === number ? ' code-preview__plain-line--highlighted' : ''}`}
        data-code-line={row.index} data-openbitfun-component="code-preview" data-openbitfun-part="line"
        style={{ position: 'absolute', insetInlineStart: 0, top: row.start, height: lineHeight }}>
        {showLineNumbers && <span className="code-preview__plain-line-number" aria-hidden="true">{number}</span>}
        <span className="code-preview__plain-line-content">{lines[row.index]?.map(tokenNode) ?? plain[row.index] ?? ''}</span>
      </span>;
    })}</span>
  </pre>;
}
