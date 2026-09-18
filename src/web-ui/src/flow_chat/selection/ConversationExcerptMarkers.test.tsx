// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationExcerptContext } from '@/shared/types/context';
import { ConversationExcerptMarkers } from './ConversationExcerptMarkers';
import { ConversationExcerptSourceContext } from './conversationExcerptSourceContext';

vi.mock('./ConversationExcerptAttachments', () => ({ ConversationExcerptPreview: () => null }));
// Highlight the source even if its endpoint is currently clipped out of view.
vi.mock('./conversationExcerptMarkerPosition', () => ({ measureExcerptMarkerPosition: () => null }));

const excerpt: ConversationExcerptContext = {
  id: 'annotation', type: 'conversation-excerpt', timestamp: 1, annotationNumber: 1,
  source: { surfaceId: 'local', sessionId: 'main', sessionName: 'Main' },
  fragments: [{ turnId: 'turn', flowItemId: 'text', text: 'selected', start: 0, end: 8, prefix: '', suffix: '' }],
};
const name = 'openbitfun-flowchat-annotations';

describe('persistent annotation highlights', () => {
  let container: HTMLDivElement;
  let first: HTMLDivElement;
  let second: HTMLDivElement;
  let root: Root;
  let highlights: Map<string, Set<Range>>;
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  const render = (left: ConversationExcerptContext[], right: ConversationExcerptContext[] = []) => act(() => {
    root.render(<>
      <ConversationExcerptSourceContext.Provider value={new Map([['turn', left]])}>
        <ConversationExcerptMarkers wrapper={first} turnId="turn" />
      </ConversationExcerptSourceContext.Provider>
      <ConversationExcerptSourceContext.Provider value={new Map([['turn', right]])}>
        <ConversationExcerptMarkers wrapper={second} turnId="turn" />
      </ConversationExcerptSourceContext.Provider>
    </>);
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    highlights = new Map();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    container = document.createElement('div');
    first = document.createElement('div'); second = document.createElement('div');
    for (const wrapper of [first, second]) {
      wrapper.innerHTML = '<div data-turn-id="turn"><div data-flow-item-id="text">selected source</div></div>';
      document.body.append(wrapper);
    }
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove(); first.remove(); second.remove(); frames.clear();
    vi.unstubAllGlobals();
  });

  it('keeps both panes highlighted after native selection clears and removes only the deleted annotation', () => {
    render([excerpt], [{ ...excerpt, id: 'peer-annotation' }]);
    window.getSelection()?.removeAllRanges();
    expect([...highlights.get(name)!].map(range => range.toString())).toEqual(['selected', 'selected']);
    render([], [{ ...excerpt, id: 'peer-annotation' }]);
    expect(highlights.get(name)?.size).toBe(1);
    expect(second.contains([...highlights.get(name)!][0].startContainer)).toBe(true);
    render([]);
    expect(highlights.has(name)).toBe(false);
  });

  it('restores every fragment of legacy annotations and rebuilds ranges after source DOM replacement', async () => {
    const legacy = { ...excerpt, annotationNumber: undefined, fragments: [
      ...excerpt.fragments,
      { ...excerpt.fragments[0], text: 'source', start: 9, end: 15, prefix: '', suffix: '' },
    ] };
    render([legacy]);
    expect([...highlights.get(name)!].map(range => range.toString())).toEqual(['selected', 'source']);
    const previous = first.querySelector('[data-flow-item-id]')!.firstChild;
    await act(async () => {
      first.querySelector('[data-flow-item-id]')!.textContent = 'selected source';
      await Promise.resolve();
    });
    act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
    expect([...highlights.get(name)!].map(range => range.toString())).toEqual(['selected', 'source']);
    expect([...highlights.get(name)!][0].startContainer).not.toBe(previous);
    render([]);
    render([legacy]);
    expect(highlights.get(name)?.size).toBe(2);
  });

  it('cleans up on unmount without clearing temporary locate highlights', () => {
    const temporary = new Set<Range>();
    highlights.set('openbitfun-flowchat-excerpt', temporary);
    render([excerpt]);
    act(() => root.render(null));
    expect(highlights.has(name)).toBe(false);
    expect(highlights.get('openbitfun-flowchat-excerpt')).toBe(temporary);
  });
});
