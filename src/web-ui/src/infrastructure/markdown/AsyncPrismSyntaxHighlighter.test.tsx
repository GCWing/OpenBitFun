// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoadedPrismSyntaxHighlighter, loadPrismSyntaxHighlighter } from '@/shared/utils/syntaxHighlighterLoader';

import { AsyncPrismSyntaxHighlighter } from './AsyncPrismSyntaxHighlighter';

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
});
