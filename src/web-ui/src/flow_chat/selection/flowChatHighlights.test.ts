// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowChatHighlightOwner } from './flowChatHighlights';

const attribute = 'data-flowchat-highlight-annotations';
const name = 'openbitfun-flowchat-annotations';
class Highlight extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } }

describe('FlowChat highlight text scopes', () => {
  let registry: Map<string, Highlight>;
  const owners: ReturnType<typeof createFlowChatHighlightOwner>[] = [];
  const owner = (kind: Parameters<typeof createFlowChatHighlightOwner>[1] = 'annotations', doc = document) => {
    const result = createFlowChatHighlightOwner(doc, kind);
    owners.push(result);
    return result;
  };
  const content = () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>before</p><p>plain <a>link</a><strong>bold</strong> tail</p><p>after</p>';
    document.body.append(root);
    return root;
  };
  beforeEach(() => {
    registry = new Map();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal('Highlight', Highlight);
  });
  afterEach(() => {
    owners.splice(0).forEach(item => item.dispose());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('scopes every intersecting text parent across Markdown nodes without touching surrounding text', () => {
    const root = content();
    const paragraph = root.children[1];
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 2);
    range.setEnd(paragraph.querySelector('strong')!.firstChild!, 2);
    owner().update([range]);
    expect([...root.querySelectorAll(`[${attribute}]`)]).toEqual([
      paragraph, paragraph.querySelector('a'), paragraph.querySelector('strong'),
    ]);
    expect([...registry.get(name)!]).toEqual([range]);
    expect(root.textContent).toBe('beforeplain linkbold tailafter');
  });

  it('handles element boundaries and excludes text touched only at an empty endpoint', () => {
    const root = content();
    const paragraph = root.children[1];
    const range = document.createRange();
    range.setStart(paragraph, 1); range.setEnd(paragraph, 2);
    const paint = owner(); paint.update([range]);
    expect([...root.querySelectorAll(`[${attribute}]`)]).toEqual([paragraph.querySelector('a')]);
    range.setStart(paragraph.firstChild!, paragraph.firstChild!.textContent!.length);
    range.setEnd(paragraph.querySelector('strong')!.firstChild!, 0);
    paint.update([range]);
    expect([...root.querySelectorAll(`[${attribute}]`)]).toEqual([paragraph.querySelector('a')]);
    range.collapse(true); paint.update([range]);
    expect(root.querySelector(`[${attribute}]`)).toBeNull();
    expect(registry.has(name)).toBe(false);
  });

  it('retains shared parent markers across updates until the last owner releases them', () => {
    const root = content(); const link = root.querySelector('a')!;
    const range = document.createRange(); range.selectNodeContents(link);
    const set = vi.spyOn(link, 'setAttribute'); const remove = vi.spyOn(link, 'removeAttribute');
    const first = owner(); const second = owner();
    first.update([range]); second.update([range]); first.update([range.cloneRange()]);
    first.dispose(); first.dispose(); first.update([range]);
    expect(set).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
    expect(registry.get(name)?.size).toBe(1);
    second.dispose();
    expect(remove).toHaveBeenCalledTimes(1); expect(registry.has(name)).toBe(false);
  });

  it('cleans replaced parents and preserves independent highlight types', () => {
    const root = content(); const link = root.querySelector('a')!;
    const range = document.createRange(); range.selectNodeContents(link);
    const annotations = owner(); const excerpt = owner('excerpt');
    annotations.update([range]); excerpt.update([range]); annotations.update([]);
    expect(link.hasAttribute(attribute)).toBe(false);
    expect(link.hasAttribute('data-flowchat-highlight-excerpt')).toBe(true);
    expect(registry.has('openbitfun-flowchat-excerpt')).toBe(true);
    annotations.update([range]); root.replaceChildren();
    annotations.update([range]); excerpt.update([range]);
    expect(link.hasAttribute(attribute)).toBe(false);
    expect(link.hasAttribute('data-flowchat-highlight-excerpt')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('keeps documents independent and uses their own Highlight API', () => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const doc = frame.contentDocument!;
    const remoteRegistry = new Map<string, Highlight>();
    Object.defineProperty(doc.defaultView, 'CSS', { value: { highlights: remoteRegistry }, configurable: true });
    Object.defineProperty(doc.defaultView, 'Highlight', { value: Highlight, configurable: true });
    doc.body.innerHTML = '<p>other document</p>';
    const range = doc.createRange(); range.selectNodeContents(doc.body.firstChild!);
    const remote = owner('annotations', doc); remote.update([range]); owner().update([range]);
    expect(registry.size).toBe(0); expect(remoteRegistry.get(name)?.size).toBe(1);
    expect(doc.querySelector(`[${attribute}]`)).toBe(doc.body.firstChild);
    remote.dispose();
    expect(remoteRegistry.size).toBe(0); expect(doc.querySelector(`[${attribute}]`)).toBeNull();
  });

  it('does not mark unsupported highlights or remove a foreign registry entry', () => {
    const root = content();
    const range = document.createRange(); range.selectNodeContents(root.querySelector('a')!);
    vi.stubGlobal('Highlight', undefined);
    const paint = owner(); paint.update([range]);
    expect(root.querySelector(`[${attribute}]`)).toBeNull();
    vi.stubGlobal('Highlight', Highlight); paint.update([range]);
    const foreign = new Highlight(range); registry.set(name, foreign); paint.dispose();
    expect(registry.get(name)).toBe(foreign);
  });
});
