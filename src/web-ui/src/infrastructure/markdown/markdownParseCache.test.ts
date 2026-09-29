import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { remarkCachedParse } from './markdownParseCache';

describe('immutable Markdown parse cache', () => {
  const source = `# Cached document\n\n${'Paragraph with **emphasis**.\n\n'.repeat(90)}
[reference][target] and footnote[^1]

| a | b |
| - | - |
| x | y |

[target]: https://example.com
[^1]: Definition at the end.

<script>alert(1)</script><img src="x" onerror="alert(1)">`;

  it('preserves whole-document GFM references, footnotes, positions and independent trees', () => {
    const expected = unified().use(remarkParse).use(remarkGfm).parse(source);
    const parse = () => unified().use(remarkParse).use(remarkGfm).use(remarkCachedParse).parse(source);
    const first = parse();
    expect(first).toEqual(expected);
    first.children.length = 0;
    expect(parse()).toEqual(expected);
  });

  it('runs raw HTML handling and sanitization after a cache hit', () => {
    const pipeline = () => unified().use(remarkParse).use(remarkGfm).use(remarkCachedParse)
      .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitize);
    const render = () => { const processor = pipeline(); return processor.runSync(processor.parse(source)); };
    const first = render();
    expect(render()).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('"tagName":"script"');
    expect(JSON.stringify(first)).not.toContain('onError');
  });
});
