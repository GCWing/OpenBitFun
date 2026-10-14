import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Markdown worker prewarming', () => {
  const text = 'Paragraph with &copy; and **emphasis**.\n\n'.repeat(80);
  let workers: TestWorker[];
  class TestWorker {
    onerror?: () => void;
    onmessage?: (event: { data: { tree?: unknown } }) => void;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { workers.push(this); }
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    workers = [];
    vi.stubGlobal('Worker', TestWorker);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops restarting a failed worker and preserves main-thread parsing', async () => {
    const { prewarmMarkdownParse, remarkCachedParse: cachedParse } = await import('./markdownParseCache');
    prewarmMarkdownParse(text);
    prewarmMarkdownParse(`${text} queued`);
    workers[0].onerror!();
    prewarmMarkdownParse(`${text} streamed update`);
    vi.advanceTimersByTime(60_000);
    prewarmMarkdownParse(`${text} later update`);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    const processor = unified().use(remarkParse).use(remarkGfm).use(cachedParse);
    expect(processor.parse(text)).toEqual(unified().use(remarkParse).use(remarkGfm).parse(text));
  });

  it('does not retry a worker whose constructor throws', async () => {
    const constructor = vi.fn(function () { throw new Error('Worker unavailable'); });
    vi.stubGlobal('Worker', constructor);
    const { prewarmMarkdownParse } = await import('./markdownParseCache');
    expect(() => prewarmMarkdownParse(text)).not.toThrow();
    prewarmMarkdownParse(`${text} update`);
    expect(constructor).toHaveBeenCalledOnce();
  });

  it('disables and terminates the worker if posting fails', async () => {
    const { prewarmMarkdownParse } = await import('./markdownParseCache');
    prewarmMarkdownParse(text);
    workers[0].onmessage!({ data: {} });
    workers[0].postMessage.mockImplementation(() => { throw new Error('Cannot post'); });
    expect(() => prewarmMarkdownParse(`${text} next`)).not.toThrow();
    prewarmMarkdownParse(`${text} update`);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
  });

  it('caches successful replies and can restart after normal idle termination', async () => {
    const { prewarmMarkdownParse, remarkCachedParse: cachedParse } = await import('./markdownParseCache');
    const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
    prewarmMarkdownParse(text);
    workers[0].onmessage!({ data: { tree } });
    const processor = unified().use(remarkParse).use(remarkGfm).use(cachedParse);
    expect(processor.parse(text)).toEqual(tree);
    prewarmMarkdownParse(text);
    expect(workers[0].postMessage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    prewarmMarkdownParse(`${text} next`);
    expect(workers).toHaveLength(2);
  });

  it('handles posting failures while advancing the queue after a reply', async () => {
    const { prewarmMarkdownParse } = await import('./markdownParseCache');
    prewarmMarkdownParse(text);
    prewarmMarkdownParse(`${text} queued`);
    workers[0].postMessage.mockImplementation(() => { throw new Error('Cannot post'); });
    expect(() => workers[0].onmessage!({ data: {} })).not.toThrow();
    prewarmMarkdownParse(`${text} update`);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
});
