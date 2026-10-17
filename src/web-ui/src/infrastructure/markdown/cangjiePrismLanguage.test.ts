import { describe, expect, it, vi } from 'vitest';
import Prism from 'prismjs';
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
  it('registers the grammar once on a loaded highlighter', () => {
    const registerLanguage = vi.fn();
    const highlighter = { registerLanguage };

    ensureCangjiePrismLanguage(highlighter);
    ensureCangjiePrismLanguage(highlighter);

    expect(registerLanguage).toHaveBeenCalledTimes(1);
    expect(registerLanguage).toHaveBeenCalledWith('cangjie', cangjiePrismGrammar);
  });
});
