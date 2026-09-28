import Prism from 'prismjs';
import { describe, expect, it } from 'vitest';
import { getInlineDiffTokenStyle } from './inlineDiffPrismTheme';
import { splitTokensByNewlines, type PrismToken } from './inlineDiffTokens';

function collectTokens(tokens: PrismToken[]): Prism.Token[] {
  return tokens.flatMap(token => typeof token === 'string' ? [] : [
    token,
    ...collectTokens(Array.isArray(token.content) ? token.content : [token.content]),
  ]);
}

describe('inline diff syntax theme', () => {
  it('gives real HTML attribute names and values their own syntax roles', () => {
    const tokens = collectTokens(Prism.tokenize('<meta name="viewport" />', Prism.languages.markup));
    const attribute = tokens.find(token => token.type === 'attr-name');
    const value = tokens.find(token => token.type === 'attr-value');
    expect(attribute).toBeDefined();
    expect(value).toBeDefined();
    expect(getInlineDiffTokenStyle(attribute!).color).toBe('var(--openbitfun-color-code-diff-syntax-property)');
    expect(getInlineDiffTokenStyle(value!).color).toBe('var(--openbitfun-color-code-diff-syntax-string)');
  });

  it('distinguishes declarations, control flow, and null without overriding code typography', () => {
    const source = 'export function fetchUser(id: string) { const user = null; return user; }';
    const tokens = collectTokens(Prism.tokenize(source, Prism.languages.typescript));
    const styleFor = (content: string) => {
      const token = tokens.find(token => token.content === content)!;
      // The renderer splits full-file tokens into lines before applying styles.
      const split = splitTokensByNewlines([token])[0][0] as Prism.Token;
      return getInlineDiffTokenStyle(split);
    };
    expect(styleFor('const').color).toBe('var(--openbitfun-color-code-diff-syntax-declaration)');
    expect(styleFor('return').color).toBe('var(--openbitfun-color-code-diff-syntax-keyword)');
    expect(styleFor('null').color).toBe('var(--openbitfun-color-code-diff-syntax-number)');
    for (const token of tokens) {
      expect(getInlineDiffTokenStyle(token)).not.toHaveProperty('fontWeight');
      expect(getInlineDiffTokenStyle(token)).not.toHaveProperty('fontSize');
    }
  });
});
