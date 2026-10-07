import Prism from 'prismjs';
import { describe, expect, it } from 'vitest';
import { splitTokensByNewlines, type LineTokens, type PrismToken } from './inlineDiffTokens';

function textOf(token: PrismToken): string {
  if (typeof token === 'string') return token;
  return (Array.isArray(token.content) ? token.content : [token.content]).map(textOf).join('');
}

function textOfLine(tokens: LineTokens): string {
  return tokens.map(textOf).join('');
}

describe('inline diff syntax lines', () => {
  it('highlights TypeScript and TSX without loading the editor or Markdown renderer', () => {
    for (const [language, source] of [
      ['typescript', 'export async function fetchUser(id: string) { return null; }'],
      ['tsx', 'export const Greeting = () => <span>Hello</span>;'],
    ]) {
      const grammar = Prism.languages[language];
      expect(grammar).toBeDefined();
      const tokens = Prism.tokenize(source, grammar);
      expect(textOfLine(tokens)).toBe(source);
      expect(Prism.Token.stringify(tokens, language)).toContain('token keyword');
    }
  });

  it('keeps keywords and strings when splitting syntax into lines', () => {
    const source = 'if (!res) throw new Error("User not found");';
    const tokens = Prism.tokenize(source, Prism.languages.javascript);
    const line = splitTokensByNewlines(tokens)[0];
    const html = Prism.Token.stringify(line, 'javascript');
    expect(textOfLine(line)).toBe(source);
    expect(html).toContain('class="token keyword"');
    expect(html).toContain('class="token string"');
    expect(textOfLine(tokens)).toBe(source);
  });

  it('preserves parent syntax scopes on each line of a multiline template string', () => {
    const source = 'const label = `hello ${name}\nworld`;';
    const lines = splitTokensByNewlines(Prism.tokenize(source, Prism.languages.javascript));
    expect(lines.map(textOfLine)).toEqual(source.split('\n'));
    expect(Prism.Token.stringify(lines[1], 'javascript')).toContain('class="token template-string"');
  });

  it('keeps aliases and nested single-token contents when splitting into lines', () => {
    const token = new Prism.Token('outer', new Prism.Token('inner', 'abcdef', 'string'), ['property']);
    const line = splitTokensByNewlines([token])[0];
    expect(textOfLine(line)).toBe('abcdef');
    expect(Prism.Token.stringify(line, 'javascript')).toContain('token outer property');
    expect(Prism.Token.stringify(line, 'javascript')).toContain('token inner string');
    expect(textOf(token)).toBe('abcdef');
  });

  it('retains blank lines and Unicode text', () => {
    const lines = splitTokensByNewlines(['\n你好 🌍\n\n']);
    expect(lines.map(textOfLine)).toEqual(['', '你好 🌍', '', '']);
  });
});
