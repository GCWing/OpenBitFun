import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
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

/** Keep one native text node for selection/copy/accessibility. Only the expensive
 * syntax-token and line-number decorations are virtualized in the existing pane. */
export function WindowedCodeContent({ content, language, scrollerRef, startingLineNumber, showLineNumbers, highlightedLine, onLineClick }: {
  content: string; language: string; scrollerRef: RefObject<HTMLDivElement | null>;
  startingLineNumber: number; showLineNumbers: boolean; highlightedLine: number | null;
  onLineClick: (line: number) => void;
}) {
  const lines = useHighlightedLines(content, language);
  const plain = useMemo(() => content.split('\n'), [content]);
  const [lineHeight, setLineHeight] = useState(22);
  const rootRef = useRef<HTMLPreElement>(null);
  const sourceRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState(false);
  const virtualizer = useVirtualizer({ count: plain.length, getScrollElement: () => scrollerRef.current,
    estimateSize: () => lineHeight, overscan: 5 });
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      setSelected(Boolean(sourceRef.current && selection?.rangeCount && !selection.isCollapsed
        && selection.getRangeAt(0).intersectsNode(sourceRef.current)));
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);
  useLayoutEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    const measure = () => {
      const next = Number.parseFloat(getComputedStyle(source).lineHeight);
      if (Number.isFinite(next) && next > 0) setLineHeight(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(source); measure();
    return () => observer.disconnect();
  }, [scrollerRef]);
  return <pre ref={rootRef} className="code-preview__plain" data-openbitfun-component="code-preview" data-openbitfun-part="plain"
    style={{ minHeight: virtualizer.getTotalSize(), position: 'relative', width: 'max-content', minWidth: '100%' }}
    onClick={event => {
      if (!window.getSelection()?.isCollapsed) return;
      const index = Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top) / lineHeight);
      if (index >= 0 && index < plain.length) onLineClick(startingLineNumber + index);
    }}>
    <code ref={sourceRef} data-code-source="" style={{ paddingInlineStart: showLineNumbers ? '3.5em' : undefined }}>{content}</code>
    <span aria-hidden="true" className="code-preview__decorations"
      style={{ pointerEvents: 'none', userSelect: 'none', color: 'transparent', opacity: selected ? 0 : 1 }}>
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
