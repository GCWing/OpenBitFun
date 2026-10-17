// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { CANGJIE_LANGUAGE_ID, registerCangjieLanguage } from './cangjie.language';

let monaco: typeof Monaco;

// Loading the real Monaco module graph can exceed 10 seconds on a cold Windows run.
beforeAll(async () => {
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  monaco = await import('monaco-editor/esm/vs/editor/editor.api');
  registerCangjieLanguage(monaco);
}, 60_000);

function tokenize(text: string): Monaco.editor.Token[][] {
  return monaco.editor.tokenize(text, CANGJIE_LANGUAGE_ID);
}

function plainType(type: string): string {
  return type.replace(/\.cangjie$/, '');
}

function typesOnLine(text: string, lineIndex: number): Array<{ offset: number; type: string }> {
  return tokenize(text)[lineIndex].map((token) => ({ offset: token.offset, type: plainType(token.type) }));
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Token type covering the first standalone occurrence of `word` on `lineIndex`.
 * Whole-word matching matters because single-letter parameter names also appear
 * inside neighbouring identifiers.
 */
function typeOfWord(text: string, word: string, lineIndex = 0): string {
  const line = text.split('\n')[lineIndex];
  const matcher = new RegExp(`(?:^|[^\\w$])(${escapeForRegExp(word)})(?![\\w$])`);
  const match = matcher.exec(line);
  expect(match, `"${word}" must appear on line ${lineIndex}`).not.toBeNull();
  const column = match!.index + match![0].indexOf(match![1]);
  const covering = [...typesOnLine(text, lineIndex)].reverse().find((token) => token.offset <= column);
  return covering?.type ?? '';
}

describe('cangjie Monarch tokenizer', () => {
  it('registers the language with the .cj extension', () => {
    const language = monaco.languages.getLanguages().find((entry) => entry.id === CANGJIE_LANGUAGE_ID);
    expect(language?.extensions).toContain('.cj');
  });

  it('highlights declarations, parameters and builtin types', () => {
    const line = 'func add(a: Int64, b: Int64): Int64 { return a + b }';
    expect(typeOfWord(line, 'func')).toBe('keyword');
    expect(typeOfWord(line, 'add')).toBe('function');
    expect(typeOfWord(line, 'a')).toBe('variable');
    expect(typeOfWord(line, 'Int64')).toBe('type.builtin');
    expect(typeOfWord(line, 'return')).toBe('keyword');
  });

  it('separates declared types, variables and call sites', () => {
    const struct = 'public struct Point { let x: Float64 }';
    expect(typeOfWord(struct, 'struct')).toBe('keyword');
    expect(typeOfWord(struct, 'Point')).toBe('type.identifier');
    expect(typeOfWord(struct, 'x')).toBe('variable');

    const call = 'let total = calculate(1, 2)';
    expect(typeOfWord(call, 'total')).toBe('variable');
    expect(typeOfWord(call, 'calculate')).toBe('function');
  });

  it('highlights macro invocations', () => {
    const line = '@Derive(ToString)';
    expect(typesOnLine(line, 0)[0]?.type).toBe('keyword');
    expect(typeOfWord(line, 'Derive')).toBe('function');
  });

  it('highlights every numeric literal form', () => {
    const line = 'let n = 0x1Fu8 + 0b1010 + 0o717 + 2.5e3f32 + 42';
    expect(typeOfWord(line, '0x1Fu8')).toBe('number.hex');
    expect(typeOfWord(line, '0b1010')).toBe('number.binary');
    expect(typeOfWord(line, '0o717')).toBe('number.octal');
    expect(typeOfWord(line, '2.5e3f32')).toBe('number.float');
    expect(typeOfWord(line, '42')).toBe('number');
  });

  it('tokenizes strings, escapes and interpolation', () => {
    const line = 'let s = "hi ${name} \\n tail"';
    expect(typeOfWord(line, 'hi')).toBe('string');
    expect(typeOfWord(line, '\\n')).toBe('string.escape');
    // Interpolated expressions are code again, not string content.
    expect(typeOfWord(line, 'name')).not.toBe('string');
  });

  it('keeps raw strings opaque and stops them at the closing hashes', () => {
    const text = 'let s = #"a "quoted" b"#\nlet t = 1';
    expect(typeOfWord(text, '"quoted"')).toBe('string');
    expect(typeOfWord(text, 'let', 1)).toBe('keyword');
  });

  it('supports multiline strings and nested block comments', () => {
    const multiline = 'let s = """line one\nline two"""\nlet t = 2';
    expect(typeOfWord(multiline, 'line two', 1)).toBe('string');
    expect(typeOfWord(multiline, 'let', 2)).toBe('keyword');

    const nested = '/* outer /* inner */ still comment */\nlet t = 3';
    expect(typeOfWord(nested, 'still')).toBe('comment');
    expect(typeOfWord(nested, 'let', 1)).toBe('keyword');
  });

  it('keeps range operators and member access distinct', () => {
    const rangeLine = 'for (i in 0..10) { }';
    expect(typesOnLine(rangeLine, 0).find((token) => token.offset === rangeLine.indexOf('..'))?.type).toBe('operator');

    const memberLine = 'let n = list.size';
    expect(typesOnLine(memberLine, 0).find((token) => token.offset === memberLine.indexOf('.'))?.type).toBe('delimiter');
  });

  it('does not leak an unterminated single-line string into the next line', () => {
    expect(typesOnLine('let s = "open\nlet t = 4', 1)[0]?.type).toBe('keyword');
    expect(typesOnLine("let c = '\nlet t = 5", 1)[0]?.type).toBe('keyword');
  });
});
