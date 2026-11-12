import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { markdownSections } from './markdownSections';

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => key === 'position' ? undefined : child));
const prefix = ('A paragraph with **bold**, `inline`, [link](https://example.org) and Unicode 中文 👩🏽‍💻.\n\n').repeat(170);

describe('Markdown presentation sections', () => {
  it('keeps the same semantic boundaries when journal blank lines cross the section budget', () => {
    const source = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}: ${'x'.repeat(970)}\n\n\n\n`).join('');
    const normalized = source.replace(/\n{3,}/g, '\n\n');
    const slices = markdownSections(source).map(section => source.slice(section.start, section.end));
    expect(slices.join('')).toBe(source);
    expect(slices.map(slice => slice.replace(/\n{3,}/g, '\n\n')))
      .toEqual(markdownSections(normalized).map(section => normalized.slice(section.start, section.end)));
    expect(clean(slices.flatMap(slice => parser.parse(slice).children))).toEqual(clean(parser.parse(source).children));
  });

  it('keeps settled sections cached while a reply streams past many prefixes', () => {
    const settled = prefix + '# Settled\n\n' + prefix;
    const sections = markdownSections(settled);
    let streaming = prefix;
    for (let index = 0; index < 80; index += 1) {
      streaming += `Streamed paragraph ${index}.\n\n`;
      markdownSections(streaming, { streaming: true });
    }
    expect(markdownSections(settled)).toBe(sections);
    // A streamed source and its settled read share the same boundaries.
    expect(markdownSections(streaming)).toEqual(markdownSections(streaming, { streaming: true }));
  });

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
});
