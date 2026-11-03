// @vitest-environment jsdom

import React, { act } from 'react';
import { resolve } from 'node:path';
import { compile } from 'sass';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoadedPrismSyntaxHighlighter, loadPrismSyntaxHighlighter } from '@/shared/utils/syntaxHighlighterLoader';

import { AsyncPrismSyntaxHighlighter } from './AsyncPrismSyntaxHighlighter';
import { MarkdownCodeBody } from './MarkdownCodeBody';
import { buildMarkdownPrismStyle } from './markdownPrismTheme';

vi.mock('@/shared/utils/startupTaskScheduling', () => ({
  scheduleAfterStartupPaint: () => () => {},
}));

vi.mock('@/shared/utils/startupTrace', () => ({
  isStartupRenderTraceEnabled: () => false,
  recordReactRenderProfile: vi.fn(),
  startupTrace: {},
}));

describe('AsyncPrismSyntaxHighlighter appearance contract', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('marks the real pre and code elements as skin-addressable parts', async () => {
    await act(async () => {
      root.render(
        <AsyncPrismSyntaxHighlighter language="ts" style={{}}>
          {'const value = 1;'}
        </AsyncPrismSyntaxHighlighter>,
      );
    });

    expect(container.querySelector('pre[data-openbitfun-part="codePre"]')).not.toBeNull();
    expect(container.querySelector('code[data-openbitfun-part="codeContent"]')).not.toBeNull();
  });

  it('highlights Cangjie when another consumer has already loaded Prism', async () => {
    const highlighter = await loadPrismSyntaxHighlighter();
    expect(getLoadedPrismSyntaxHighlighter()).toBe(highlighter);

    await act(async () => {
      root.render(
        <AsyncPrismSyntaxHighlighter language="cangjie" style={{}}>
          {'func add(a: Int64): Int64 { return a + 1 }'}
        </AsyncPrismSyntaxHighlighter>,
      );
    });

    expect(container.querySelector('.code-block-fallback')).toBeNull();
    expect(container.querySelector('code .token.keyword')?.textContent).toBe('func');
    expect(container.querySelector('code .token.function')?.textContent).toBe('add');
    expect(container.querySelector('code .token.builtin')?.textContent).toBe('Int64');
  });

  it.each([true, false])('preserves code whitespace and selection boundaries with fallback=%s', async (preferFallback) => {
    await loadPrismSyntaxHighlighter();
    const styles = document.createElement('style');
    styles.textContent = compile(resolve('src/infrastructure/markdown/Markdown.scss')).css;
    document.head.append(styles);
    const source = 'func main() {\n\tlet value = "a long value that must remain on one scrollable line";\n\n    run(value);\n}';
    try {
      await act(async () => root.render(<div className="markdown-renderer">
        <div className="code-block-wrapper"><MarkdownCodeBody>
          <AsyncPrismSyntaxHighlighter language="cangjie" style={buildMarkdownPrismStyle(false)} preferFallback={preferFallback}>
            {source}
          </AsyncPrismSyntaxHighlighter>
        </MarkdownCodeBody></div>
      </div>));
      const pre = container.querySelector('pre')!;
      const code = pre.querySelector('code')!;
      expect(getComputedStyle(pre).display).toBe('flex');
      expect(getComputedStyle(pre).flexDirection).toBe('column');
      expect(getComputedStyle(pre.parentElement!).display).toBe('flex');
      expect(getComputedStyle(pre.parentElement!).overflowX).toBe('auto');
      expect(code.parentElement).toBe(pre);
      expect(getComputedStyle(code).display).toBe('block');
      expect(getComputedStyle(code).whiteSpace).toBe('pre');
      expect(code.textContent).toBe(source);
      // Prism consumes token classes when the product theme supplies inline
      // styles. Check the actual token run rather than its optional class.
      const keyword = [...code.querySelectorAll('span')].find(node => node.textContent === 'func');
      expect(Boolean(keyword)).toBe(!preferFallback);
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString()).toBe(source);
    } finally {
      styles.remove();
      window.getSelection()?.removeAllRanges();
    }
  });
});
