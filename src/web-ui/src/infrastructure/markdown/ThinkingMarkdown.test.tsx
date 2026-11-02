// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Components } from 'react-markdown';
import { defaultUrlTransform } from 'react-markdown';
import { getMarkdown, parseMarkdownToStructure } from 'stream-markdown-parser';
import ThinkingMarkdown from './ThinkingMarkdown';

describe('thinking streaming renderer', () => {
  let root: Root;
  let container: HTMLDivElement;
  const renderParagraph = vi.fn();
  const renderCode = vi.fn();
  const components: Components = {
    p: ({ children }) => { renderParagraph(children); return <p>{children}</p>; },
    code: ({ children, className }) => { renderCode(); return <code className={className}>{children}</code>; },
  };
  const urlTransform = (value: string) => /^file:/.test(value) ? value : defaultUrlTransform(value);
  const renderFragment = vi.fn((content: string) => <span>{content}</span>);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(() => act(() => root.unmount()));

  async function render(content: string, isStreaming = true, singleLinePreview = false) {
    await act(async () => root.render(<ThinkingMarkdown content={content} isStreaming={isStreaming} isDark
      components={components} urlTransform={urlTransform} renderFragment={renderFragment} singleLinePreview={singleLinePreview} />));
  }

  it('retains inline emphasis, links and code in the latest preview paragraph', async () => {
    await render('Earlier paragraph.\n\nLatest **bold**, *emphasis*, ~~removed~~, `value` and [link](https://example.com).', true, true);
    const preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.textContent).toBe('Latest bold, emphasis, removed, value and link.');
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
    expect(preview.querySelector('em')?.textContent).toBe('emphasis');
    expect(preview.querySelector('del')?.textContent).toBe('removed');
    expect(preview.querySelector('code')?.textContent).toBe('value');
    expect(preview.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(preview.querySelector('p')).toBeNull();
  });

  it('previews the latest code line without block geometry and retains the full code on completion', async () => {
    const content = 'Before.\n\n```ts\nconst first = 1;\n  const latest = "代码 👨‍👩‍👧‍👦";\n\n';
    await render(content, true, true);
    const code = container.querySelector('.thinking-markdown-full code');
    const preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.textContent).toBe('const latest = "代码 👨‍👩‍👧‍👦";');
    expect(preview.querySelector('pre, code, button')).toBeNull();
    await render(content + '```', false, true);
    expect(container.querySelector('.thinking-markdown-full code')).toBe(code);
    expect(preview.textContent).toBe('const latest = "代码 👨‍👩‍👧‍👦";');
    expect(code?.textContent).toContain('const first = 1;');
  });

  it.each(['\n\n```ts\n', '\n\n---\n', '\n\n![', '  \n'])('keeps readable content through an empty formatting boundary: %j', async boundary => {
    await render('Last **readable** line.' + boundary, true, true);
    expect(container.querySelector('.thinking-markdown-preview')?.textContent).toBe('Last readable line.');
  });

  it('keeps long logical lines intact for browser wrapping instead of slicing by character count', async () => {
    const line = 'const value = "' + 'long 中文 👩‍💻 '.repeat(100) + '";';
    await render('```ts\n' + line, true, true);
    expect(container.querySelector('.thinking-markdown-preview')?.textContent).toBe(line);
  });

  it('reduces nested list and heading layout while retaining inline formatting', async () => {
    await render('- first\n  - nested **bold** and `value`', true, true);
    let preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.textContent).toBe('nested bold and value');
    expect(preview.querySelector('ul, ol, li, p')).toBeNull();
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
    await render('## A *heading*', true, true);
    preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.querySelector('strong em')?.textContent).toBe('heading');
    expect(preview.querySelector('h1, h2, h3')).toBeNull();
  });

  it('flattens the latest table row, skips empty rows and preserves cell emphasis', async () => {
    await render('| A | B |\n| - | - |\n| first | old |\n| latest | **bold** |\n| | |', true, true);
    const preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.textContent).toBe('latest · bold');
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
    expect(preview.querySelector('table, tr, td')).toBeNull();
    expect(container.querySelectorAll('.thinking-markdown-full td')).toHaveLength(6);
  });

  it('uses text for math and image geometry without sending the preview through expensive renderers', async () => {
    await render('Formula $\\frac{a}{b}$ and ![Diagram](https://example.com/image.png)', true, true);
    const preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.textContent).toBe('Formula \\frac{a}{b} and Diagram');
    expect(preview.querySelector('img, .katex')).toBeNull();
    // Only the retained full body asks for math rendering.
    expect(renderFragment).toHaveBeenCalledTimes(1);
  });

  it('sanitizes exceptional HTML preview content and flattens block layout', async () => {
    await render('<details><summary>More</summary><p>Hello <strong>world</strong></p><img alt="Diagram" src="image.png"><script>unsafe()</script></details>', false, true);
    const preview = container.querySelector('.thinking-markdown-preview')!;
    expect(preview.textContent).toBe('More Hello world Diagram');
    expect(preview.querySelector('strong')?.textContent).toBe('world');
    expect(preview.querySelector('details, p, img, script')).toBeNull();
  });

  it('does not carry preview content across replacement or rewind', async () => {
    await render('Old thought.\n\n```ts\nold();', true, true);
    await render('New **thought**.', true, true);
    expect(container.querySelector('.thinking-markdown-preview')?.textContent).toBe('New thought.');
    await render('', true, true);
    expect(container.querySelector('.thinking-markdown-preview')?.textContent).toBe('');
  });

  it('skips rendering settled blocks while a 100K tail grows and preserves DOM on completion', async () => {
    const prefix = 'Settled **paragraph**.\n\n';
    await render(prefix + 'Growing');
    const settled = container.querySelector('p');
    renderParagraph.mockClear();
    const tail = 'Growing' + 'long thinking '.repeat(8000);
    await render(prefix + tail);
    expect(container.textContent?.endsWith(tail.trimEnd())).toBe(true);
    expect(container.querySelector('p')).toBe(settled);
    expect(renderParagraph).toHaveBeenCalledTimes(1);
    await render(prefix + tail, false);
    expect(container.querySelector('p')).toBe(settled);
    expect(renderFragment).not.toHaveBeenCalled();
  });

  it('keeps incomplete long fenced code mounted through closure and completion', async () => {
    const code = 'const value = 1;\n'.repeat(6500);
    await render('```ts\n' + code);
    const element = container.querySelector('code');
    expect(element?.textContent).toContain(code.trimEnd());
    await render('```ts\n' + code + '```', false);
    expect(container.querySelector('code')).toBe(element);
    expect(element?.className).toBe('language-ts');
    expect(renderFragment).not.toHaveBeenCalled();
  });

  it('skips settled paragraphs and code even when the parser stops reusing nodes', async () => {
    const code = 'const value = 1;\n'.repeat(80);
    const prefix = 'Settled **paragraph**.\n\n' + (`\`\`\`ts\n${code}\`\`\`\n\n`).repeat(80)
      + '[Link][ref]\n\n[ref]: https://example.com\n\n';
    // Reference definitions force the real parser out of its structured reuse path.
    const parser = getMarkdown('thinking-reuse-regression');
    const options = { final: false, streamParse: 'auto' as const, reuseStableTopLevelNodes: true };
    const before = parseMarkdownToStructure(prefix + 'Growing', parser, options);
    const after = parseMarkdownToStructure(prefix + 'Growing tail', parser, options);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toEqual(before[0]);
    expect(prefix.length).toBeGreaterThan(100_000);

    await render(prefix + 'Growing');
    const settledCode = container.querySelector('code');
    renderParagraph.mockClear();
    renderCode.mockClear();
    await render(prefix + 'Growing tail');
    expect(container.textContent?.endsWith('Growing tail')).toBe(true);
    expect(container.querySelector('code')).toBe(settledCode);
    expect(renderCode).not.toHaveBeenCalled();
    expect(renderParagraph).toHaveBeenCalledTimes(1);
  });

  it('updates unchanged paragraph text when later reference definitions resolve links and images', async () => {
    const prefix = '[Link][ref] and ![Image][image]\n\n';
    await render(prefix + 'Tail');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src') ?? '').toBe('');
    await render(prefix + 'Tail\n\n[ref]: https://example.com/first "First"\n[image]: https://example.com/first.png\n');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/first');
    expect(container.querySelector('a')?.title).toBe('First');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/first.png');
    await render(prefix + 'Tail\n\n[ref]: https://example.com/second "Second"\n[image]: https://example.com/second.png\n');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/second');
    expect(container.querySelector('a')?.title).toBe('Second');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/second.png');
  });

  it('resets incremental state when content is replaced or rewound', async () => {
    await render('Old prefix.\n\nOld tail');
    await render('Replacement');
    expect(container.textContent).toBe('Replacement');
    await render('Replace');
    expect(container.textContent).toBe('Replace');
  });

  it('refreshes reused blocks when their resource environment or final state changes', async () => {
    const content = 'Settled paragraph.\n\nTail';
    const firstEnvironment = {};
    const secondEnvironment = {};
    const renderWithEnvironment = async (environment: object, isStreaming = true) => act(async () => root.render(
      <ThinkingMarkdown content={content} isStreaming={isStreaming} isDark components={components}
        urlTransform={urlTransform} renderFragment={renderFragment} environment={environment} />,
    ));
    await renderWithEnvironment(firstEnvironment);
    renderParagraph.mockClear();
    await renderWithEnvironment(firstEnvironment);
    expect(renderParagraph).not.toHaveBeenCalled();
    await renderWithEnvironment(secondEnvironment);
    expect(renderParagraph).toHaveBeenCalledTimes(2);
    renderParagraph.mockClear();
    await renderWithEnvironment(secondEnvironment, false);
    expect(renderParagraph).toHaveBeenCalledTimes(2);
  });

  it('keeps parser state isolated between simultaneous thinking blocks', async () => {
    const renderPair = async (first: string, second: string) => act(async () => root.render(<>
      <ThinkingMarkdown content={first} isStreaming isDark components={components} urlTransform={urlTransform} renderFragment={renderFragment} />
      <ThinkingMarkdown content={second} isStreaming isDark components={components} urlTransform={urlTransform} renderFragment={renderFragment} />
    </>));
    await renderPair('First **thought**.\n\nTail', 'Second `thought`.\n\nOther');
    await renderPair('First **thought**.\n\nTail grows', 'Second `thought`.\n\nOther grows');
    expect(container.querySelector('strong')?.textContent).toBe('thought');
    expect(container.querySelector('code')?.textContent).toBe('thought');
    expect(container.textContent).toBe('First thought.Tail growsSecond thought.Other grows');
  });

  it('renders nested lists and tables with complete content', async () => {
    await render('- first\n  - nested\n- [x] done\n\n| A | B |\n| :- | -: |\n| value | **bold** |', false);
    expect(container.querySelector('li li')?.textContent).toBe('nested');
    expect(container.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelector('td strong')?.textContent).toBe('bold');
  });

  it('does not activate incomplete or unsafe links', async () => {
    await render('[partial](https://example.com');
    expect(container.textContent).toBe('partial');
    expect(container.querySelector('a')).toBeNull();
    await render('[partial](https://example.com) [bad](javascript:alert(1))', false);
    expect(container.querySelector('a')?.href).toBe('https://example.com/');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('passes only exceptional fragments through the existing safe pipeline', async () => {
    await render('Normal **thinking** and $x+y$.\n\n<details><summary>More</summary>Content</details>', false);
    expect(renderFragment).toHaveBeenCalledWith('$x+y$', true, true);
    expect(renderFragment).toHaveBeenCalledWith('<details><summary>More</summary>Content</details>', false, false);
    expect(renderFragment).toHaveBeenCalledTimes(2);
  });
});
