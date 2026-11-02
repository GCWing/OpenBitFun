import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Nodes } from 'mdast';
import { remarkStreamingTableLinks } from './remarkStreamingTableLinks';

const header = '| File | Description |\n| --- | --- |\n';
function render(tail: string, streaming = true, math = false) {
  const source = header + tail;
  const processor = unified().use(remarkParse).use(remarkGfm);
  if (math) processor.use(remarkMath);
  processor.use(remarkStreamingTableLinks, { isStreaming: streaming });
  const original = processor.parse(source);
  const tree = processor.runSync(structuredClone(original), { value: source });
  const table = tree.children[0];
  if (table.type !== 'table') throw new Error('Expected table');
  const cell = table.children[table.children.length - 1].children[0];
  const text = (node: Nodes): string => 'value' in node ? node.value : 'children' in node ? node.children.map(text).join('') : '';
  return { tree, original, cell, text: text(cell) };
}

describe('streaming table link labels', () => {
  it.each([false, true])('hides every destination prefix and preserves formatted labels (math=%s)', math => {
    const destination = '/srv/workspace/docs/long-path/Guide_(advanced).md';
    for (let length = 0; length <= destination.length; length += 1) {
      const result = render('| Before [**Guide** `v2`](' + destination.slice(0, length), true, math);
      expect(result.text).toBe('Before Guide v2');
      expect(result.cell.children.some(node => node.type === 'strong')).toBe(true);
      expect(result.cell.children.some(node => node.type === 'inlineCode')).toBe(true);
      expect(result.cell.children.some(node => node.type === 'link')).toBe(false);
    }
  });

  it.each([
    '[Guide](<C:/path with spaces/Guide.md',
    '[Guide](<C:/path with spaces/Guide.md>',
    '[Guide](path\\(part\\).md',
    '[Guide](path.md "Title with )',
    "[Guide](path.md 'Title'",
    '[Guide](path.md (Title)',
  ])('handles unfinished destinations and titles: %s', tail => {
    expect(render('| ' + tail).text).toBe('Guide');
  });

  it('preserves nested brackets, escapes, entities and inline code', () => {
    expect(render('| [A [B] &amp; \\* \\&amp; `x](y`](/path').text).toBe('A [B] & * &amp; x](y');
    expect(render('| [a\\|b](/path').text).toBe('a|b');
    expect(render('| [a &copy &copy;](/path').text).toBe('a &copy ©');
    expect(render('| \\![Guide](/path').text).toBe('!Guide');
  });

  it('preserves preceding bare links and leaves positionless GFM fallback cells untouched', () => {
    const result = render('| https://example.com [Guide](/path');
    expect(result.text).toBe('https://example.com Guide');
    expect(result.cell.children[0].type).toBe('link');
    const fallback = render('| https\\://example.com [Guide](/path');
    expect(fallback.tree).toEqual(fallback.original);
  });

  it('handles a pending link in the second column and in a nested table', () => {
    for (const source of [header + '| Existing | [Guide](/path', (header + '| [Guide](/path').split('\n').map(line => '> ' + line).join('\n')]) {
      const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStreamingTableLinks, { isStreaming: true });
      const tree = processor.runSync(processor.parse(source), { value: source });
      expect(JSON.stringify(tree)).not.toContain('](/path');
    }
  });

  it.each([
    '| [Guide](/path.md)',
    '| [Guide](/path "title")',
    '| [Guide](/path.md',
  ])('restores standard parsing when streaming ends: %s', tail => {
    const result = render(tail, false);
    expect(result.tree).toEqual(result.original);
  });

  it.each([
    '| `example [Guide](/path`',
    '| ![Guide](/path',
    '| ![outer [Guide](/path',
    '| \\[Guide](/path',
    '| [Guide](/path) tail',
    '| [Guide](/path | explanation',
    '| [Guide](/path\n',
    '| [Guide](/path\n| next | value |',
    '| [Guide](/path invalid text',
    '| <span title="[Guide](/path">text</span>',
  ])('leaves code, images, escapes, completed cells and invalid syntax unchanged: %s', tail => {
    const result = render(tail);
    expect(result.tree).toEqual(result.original);
  });

  it('preserves completed links and original source positions', () => {
    const result = render('| [Earlier](/earlier.md) and [Guide](/path');
    expect(result.text).toBe('Earlier and Guide');
    const table = result.original.children[0];
    if (table.type !== 'table') throw new Error('Expected table');
    expect(result.cell.position).toEqual(table.children[1].children[0].position);
    expect(result.cell.children[0]).toEqual(table.children[1].children[0].children[0]);
  });

  it('does not alter paragraphs or fenced code outside tables', () => {
    for (const source of ['[Guide](/path', '```md\n[Guide](/path\n```']) {
      const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStreamingTableLinks, { isStreaming: true });
      const original = processor.parse(source);
      expect(processor.runSync(structuredClone(original), { value: source })).toEqual(original);
    }
  });
});
