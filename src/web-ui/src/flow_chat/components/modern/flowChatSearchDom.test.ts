// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFlowChatSearchHighlightOwner,
  findElementWithDataValue,
  findFlowChatSearchTextRange,
  findFlowChatSearchTextRanges,
  getFlowChatSearchTextRoot,
} from './flowChatSearchDom';

describe('FlowChat search DOM navigation', () => {
  it('finds a query split across Markdown text nodes', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Before <span>key</span><strong>word</strong> after</p>';

    const range = findFlowChatSearchTextRange(root, 'KEYWORD');

    expect(range?.toString()).toBe('keyword');
  });

  it('maps a folded match back to original offsets when lowercasing expands a character', () => {
    const root = document.createElement('div');
    root.textContent = 'İstanbul';

    const range = findFlowChatSearchTextRange(root, 'stanbul');

    expect(range?.toString()).toBe('stanbul');
  });

  it('targets an exact flow item id without interpolating it into a selector', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div data-flow-item-id="first">wrong</div>
      <div data-flow-item-id="item&quot;with-special">right needle</div>
    `;

    const target = findElementWithDataValue(
      wrapper,
      'data-flow-item-id',
      'item"with-special',
    );

    expect(target?.textContent).toBe('right needle');
    expect(getFlowChatSearchTextRoot(wrapper, 'item"with-special')).toBe(target);
  });

  it('finds every occurrence in document order', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>needle first</p><p>then <em>nee</em>dle second and needle third</p>';

    const ranges = findFlowChatSearchTextRanges(root, 'needle');

    expect(ranges).toHaveLength(3);
    expect(ranges.map(range => range.toString())).toEqual(['needle', 'needle', 'needle']);
  });

  it('finds non-overlapping occurrences only', () => {
    const root = document.createElement('div');
    root.textContent = 'aaa';

    expect(findFlowChatSearchTextRanges(root, 'aa')).toHaveLength(1);
  });

  it('ignores text hidden by a collapsed accessible container', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div aria-hidden="true">hidden needle</div><div>visible needle</div>';

    const range = findFlowChatSearchTextRange(root, 'needle');

    expect(range?.startContainer.parentElement?.textContent).toBe('visible needle');
  });
});

describe('FlowChat search highlight ownership', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('keeps other mounted rows and chat panes highlighted when one owner unmounts', () => {
    // This registry checks range ownership only; jsdom provides no visual proof.
    class TestHighlight extends Set<Range> {
      constructor(...ranges: Range[]) { super(ranges); }
    }
    const registry = new Map<string, TestHighlight>();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal('Highlight', TestHighlight);
    const source = document.createElement('p');
    source.textContent = 'needle one, needle two';
    document.body.append(source);
    const [first, second] = findFlowChatSearchTextRanges(source, 'needle');
    const firstOwner = createFlowChatSearchHighlightOwner(document);
    const secondOwner = createFlowChatSearchHighlightOwner(document);

    firstOwner.update(first, []);
    secondOwner.update(null, [second]);
    expect([...registry.get('openbitfun-flowchat-search-current')!]).toEqual([first]);
    expect([...registry.get('openbitfun-flowchat-search-match')!]).toEqual([second]);
    expect([...registry.keys()].at(-1)).toBe('openbitfun-flowchat-search-current');

    firstOwner.dispose();
    expect(registry.has('openbitfun-flowchat-search-current')).toBe(false);
    expect([...registry.get('openbitfun-flowchat-search-match')!]).toEqual([second]);

    firstOwner.update(first, []);
    expect(registry.has('openbitfun-flowchat-search-current')).toBe(false);
    secondOwner.dispose();
    expect(registry.size).toBe(0);
  });
});
