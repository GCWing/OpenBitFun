// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { getVisibleCodeLineCount, readLineHeight, WindowedCodeContent } from './WindowedCodeContent';

const highlights = vi.hoisted(() => ({ ready: false }));
vi.mock('../timeline/highlightResources', () => ({ useHighlightedLines: (content: string) => content.split('\n').map(line =>
  highlights.ready ? [{ type: 'keyword', content: line }] : [line]) }));

it('keeps complete native text and a live range while token decorations change', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const content = `${Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index};`).join('\n')}\n`;
  const render = () => act(() => root.render(<WindowedCodeContent content={content} language="typescript"
    scrollerRef={{ current: host }} startingLineNumber={1} showLineNumbers highlightedLine={null} onLineClick={() => {}} />));
  try {
    render();
    const source = host.querySelector('[data-code-source]')!;
    expect(source.childNodes).toHaveLength(1);
    expect(source.textContent).toBe(content);
    expect(host.querySelectorAll('[data-code-line]').length).toBeLessThan(60);
    const range = document.createRange(); range.selectNodeContents(source);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    act(() => document.dispatchEvent(new Event('selectionchange')));
    expect(selection.toString()).toBe(content);
    const text = source.firstChild;
    highlights.ready = true; render();
    expect(source.firstChild).toBe(text);
    expect(selection.toString()).toBe(content);
    expect(host.querySelector('.code-preview__decorations')?.getAttribute('aria-hidden')).toBe('true');
    expect((host.querySelector('.code-preview__decorations') as HTMLElement).style.opacity).not.toBe('0');
  } finally {
    window.getSelection()?.removeAllRanges(); act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  }
});

it('converts unitless line-height tokens to pixel virtualizer offsets', () => {
  vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '1.5', fontSize: '16px' }));
  try {
    expect(readLineHeight(document.createElement('code'))).toBe(24);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('does not virtualize the split item after a trailing newline', () => {
  expect(getVisibleCodeLineCount(3, true)).toBe(2);
  expect(getVisibleCodeLineCount(2, false)).toBe(2);
  expect(getVisibleCodeLineCount(1, false)).toBe(1);
});
