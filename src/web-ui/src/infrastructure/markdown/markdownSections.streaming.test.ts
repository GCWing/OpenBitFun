import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parsedSources } = vi.hoisted(() => ({ parsedSources: [] as string[] }));
vi.mock('stream-markdown-parser', async importOriginal => {
  const actual = await importOriginal<typeof import('stream-markdown-parser')>();
  return {
    ...actual,
    getMarkdown: (...args: Parameters<typeof actual.getMarkdown>) => {
      const parser = actual.getMarkdown(...args);
      const parse = parser.block.parse;
      vi.spyOn(parser.block, 'parse').mockImplementation(function (...parseArgs) {
        parsedSources.push(parseArgs[0]);
        return parse.apply(parser.block, parseArgs);
      });
      return parser;
    },
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  parsedSources.length = 0;
});

const paragraph = `${'A paragraph with **bold** and Unicode 中文. '.repeat(24)}\n\n`;
const prefix = paragraph.repeat(24);

describe('streaming Markdown section parsing', () => {
  it('parses only the tail and reuses closed sections over repeated updates', async () => {
    const { markdownSections } = await import('./markdownSections');
    let source = prefix;
    let previous = markdownSections(source, { streaming: true });
    expect(previous.length).toBeGreaterThan(3);
    for (let index = 0; index < 25; index += 1) {
      source += `Update ${index}.\n\n`;
      parsedSources.length = 0;
      const next = markdownSections(source, { streaming: true });
      expect(parsedSources).toHaveLength(1);
      expect(parsedSources[0].length).toBeLessThan(source.length / 2);
      expect(next[0]).toBe(previous[0]);
      expect(next.map(section => source.slice(section.start, section.end)).join('')).toBe(source);
      previous = next;
    }
    // A fresh module has no streaming record: compare with a full parse.
    vi.restoreAllMocks();
    vi.resetModules();
    const cold = await import('./markdownSections');
    expect(previous).toEqual(cold.markdownSections(source));
  });

  it.each(['\n', '\r\n', '\r'])('matches full parsing with %j newlines and appended blocks', async newline => {
    const { markdownSections } = await import('./markdownSections');
    let source = prefix.replace(/\n/g, newline);
    markdownSections(source, { streaming: true });
    const chunks = ['```ts\n', paragraph.repeat(5), '```\n\n', '- List\n  - Nested\n\n', '| A | B |\n|---|---|\n| one | two |\n\n'];
    const frames = chunks.map(chunk => {
      source += chunk.replace(/\n/g, newline);
      return { source, sections: markdownSections(source, { streaming: true }) };
    });
    for (const frame of frames) {
      vi.restoreAllMocks();
      vi.resetModules();
      const cold = await import('./markdownSections');
      expect(frame.sections).toEqual(cold.markdownSections(frame.source));
    }
  });

  it.each(['\n[id]: https://example.org\n', '\n[^1]: Footnote\n', '\n<div>HTML</div>\n'])
    ('collapses frozen sections when the tail adds a document dependency: %s', async suffix => {
      const { markdownSections } = await import('./markdownSections');
      const source = '[id]\n\n' + prefix;
      expect(markdownSections(source, { streaming: true }).length).toBeGreaterThan(3);
      const extended = source + suffix;
      expect(markdownSections(extended, { streaming: true })).toEqual([{ start: 0, end: extended.length }]);
    });

  it('preserves journal blank-line coordinates across streaming and settlement', async () => {
    const { markdownSections } = await import('./markdownSections');
    const source = prefix.replace(/\n\n/g, '\n\n\n\n');
    markdownSections(source, { streaming: true });
    const extended = source + paragraph;
    const sections = markdownSections(extended, { streaming: true });
    const normalized = extended.replace(/\n{3,}/g, '\n\n');
    expect(sections.map(s => extended.slice(s.start, s.end).replace(/\n{3,}/g, '\n\n')))
      .toEqual(markdownSections(normalized).map(s => normalized.slice(s.start, s.end)));
    expect(markdownSections(extended)).toEqual(sections);
  });

  it('fully parses replacement content instead of reusing an unrelated prefix', async () => {
    const { markdownSections } = await import('./markdownSections');
    markdownSections(prefix, { streaming: true });
    const replacement = 'Replacement\n\n' + prefix;
    parsedSources.length = 0;
    markdownSections(replacement, { streaming: true });
    expect(parsedSources).toEqual([replacement]);
  });
});
