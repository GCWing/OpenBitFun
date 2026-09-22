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

  async function render(content: string, isStreaming = true) {
    await act(async () => root.render(<ThinkingMarkdown content={content} isStreaming={isStreaming} isDark
      components={components} urlTransform={urlTransform} renderFragment={renderFragment} />));
  }

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
