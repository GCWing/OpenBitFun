import { describe, expect, it, vi } from 'vitest';
import Prism from 'prismjs';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-async-light';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cangjiePrismGrammar } from '@/tools/editor/languages/cangjie.language';
import { ensureCangjiePrismLanguage } from './cangjiePrismLanguage';

const grammar = cangjiePrismGrammar as unknown as Prism.Grammar;

describe('cangjie Prism grammar', () => {
  it('tokenizes declarations for chat code fences', () => {
    const html = Prism.highlight('func add(a: Int64): Int64 {\n    return a + 1\n}', grammar, 'cangjie');

    expect(html).toContain('token keyword');
    expect(html).toContain('token function');
    expect(html).toContain('token builtin');
    expect(html).toContain('token punctuation');
  });

  it('keeps comments, strings and annotations whole', () => {
    const html = Prism.highlight('// note\nlet s = "a ${b} c"\n@Derive(ToString) struct P {}', grammar, 'cangjie');

    expect(html).toContain('token comment');
    expect(html).toContain('token string');
    expect(html).toContain('token annotation function');
    expect(html).toContain('token class-name');
  });
});

describe('ensureCangjiePrismLanguage', () => {
  it('registers once and highlights with the real async highlighter', async () => {
    const highlighter = SyntaxHighlighter as typeof SyntaxHighlighter & {
      preload: () => Promise<void>;
    };
    await highlighter.preload();
    const registerLanguage = vi.spyOn(highlighter, 'registerLanguage');

    try {
      ensureCangjiePrismLanguage(highlighter);
      ensureCangjiePrismLanguage(highlighter);

      expect(registerLanguage).toHaveBeenCalledTimes(1);
      expect(registerLanguage).toHaveBeenCalledWith('cangjie', expect.any(Function));
      const html = renderToStaticMarkup(React.createElement(highlighter, {
        language: 'cangjie',
        useInlineStyles: false,
        children: 'func add(a: Int64): Int64 { return a + 1 }',
      }));
      expect(html).toContain('class="token keyword"');
      expect(html).toContain('class="token function"');
      expect(html).toContain('class="token builtin"');
    } finally {
      registerLanguage.mockRestore();
    }
  });
});
