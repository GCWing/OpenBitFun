import { describe, expect, it, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { markdownSections } from './markdownSections';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => key === 'position' ? undefined : child));
const prefix = ('A paragraph with **bold**, `inline`, [link](https://example.org) and Unicode 中文 👩🏽‍💻.\n\n').repeat(170);

describe('Markdown presentation sections', () => {
  it.each(['\n', '\r\n', '\r'])('keeps complete semantic blocks and exact source with %j line endings', newline => {
    const document = (prefix + [
      '# Heading\n\nSetext heading\n---\n\n',
      '```typescript\n' + 'const x = "```";\n'.repeat(400) + '```\n\n',
      '- First\n  - Nested\n\n    Paragraph in list\n\n- Second\n\n',
      '> Quote\n>\n> More quoted text\n\n',
      '| A | B |\n|---|---|\n' + '| **one** | two |\n'.repeat(240) + '\n',
      '~~~\nA tilde fence\n~~~\n\n',
      '$$\n' + 'x = y + z\n\n'.repeat(400) + '$$\n\n', prefix,
    ].join('')).replace(/\n/g, newline);
    const sections = markdownSections(document);
    expect(sections.length).toBeGreaterThan(4);
    const slices = sections.map(section => document.slice(section.start, section.end));
    expect(slices.join('')).toBe(document);
    expect(clean(slices.flatMap(slice => parser.parse(slice).children))).toEqual(clean(parser.parse(document).children));
    expect(markdownSections(document)).toBe(sections);
  });

  it.each([
    '[link][id]\n\n[id]: https://example.org',
    '[id]\n\n[id]: https://example.org',
    '[note][^1]\n\n[^1]: Footnote',
    '<details>\n\nHidden **text**\n\n</details>',
    'Paragraph with <span>inline HTML</span>.',
  ])('retains whole-document dependencies: %s', dependent => {
    const source = prefix + dependent + '\n\n' + prefix;
    expect(markdownSections(source)).toEqual([{ start: 0, end: source.length }]);
  });

  it('keeps append-only streaming sections identical to a full scan across a split CRLF', async () => {
    const document = (prefix + prefix).replace(/\n/g, '\r\n');
    const crlf = document.indexOf('\r\n', 4000);
    // `crlf + 1` ends on a bare CR; the next cut completes the CRLF pair.
    const cuts = [3500, crlf + 1, crlf + 2, crlf + 900, document.length - 4000, document.length];
    let sections = markdownSections(document.slice(0, cuts[0]));
    for (const cut of cuts.slice(1)) sections = markdownSections(document.slice(0, cut));

    const source = document.slice(0, cuts[cuts.length - 1]);
    expect(sections.map(section => source.slice(section.start, section.end)).join('')).toBe(source);
    vi.resetModules();
    const fresh = await import('./markdownSections');
    expect(sections).toEqual(fresh.markdownSections(source));
  });

  it('keeps a cached result describing its own source while a longer text streams', () => {
    const document = prefix + prefix;
    const short = document.slice(0, 4000);
    const cached = markdownSections(short);
    markdownSections(document.slice(0, 6000));
    const again = markdownSections(short);
    expect(again).toBe(cached);
    expect(again[again.length - 1].end).toBeLessThanOrEqual(short.length);
    expect(again.map(section => short.slice(section.start, section.end)).join('')).toBe(short);
  });
});
