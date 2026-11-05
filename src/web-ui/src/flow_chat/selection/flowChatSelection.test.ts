// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { captureFlowChatSelection, findExcerptSource, resolveExcerptRange } from './flowChatSelection';

const source = { surfaceId: 'local', sessionId: 'session-1', sessionName: 'Session' };
function transcript(html: string) {
  const root = document.createElement('div');
  root.dataset.flowchatSelectionRoot = source.sessionId;
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
function select(start: Node, end = start, startOffset = 0, endOffset = end.textContent!.length) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

describe('FlowChat selection snapshots', () => {
  it('round trips section hints and distinguishes repeated text in different sections', () => {
    const root = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="reply" data-source-markdown-start="0"><p>Repeated</p></div><div data-flow-item-id="reply" data-source-markdown-start="3200"><p>Repeated</p></div></div>');
    const paragraph = root.querySelectorAll('p')[1];
    const snapshot = captureFlowChatSelection(root, select(paragraph.firstChild!), source)!;
    const fragment = JSON.parse(JSON.stringify(snapshot.excerpt.fragments[0]));
    expect(fragment.markdownStart).toBe(3200);
    expect(resolveExcerptRange(findExcerptSource(root, fragment)!, fragment)?.startContainer).toBe(paragraph.firstChild);
    // Existing snapshots have no hint and retain the full-source coordinate space.
    const old = { ...fragment }; delete old.markdownStart;
    expect(findExcerptSource(root, old)).toBeNull();
    root.innerHTML = '<div data-turn-id="turn-1"><div data-flow-item-id="reply"><p>Repeated</p></div></div>';
    expect(resolveExcerptRange(findExcerptSource(root, JSON.parse(JSON.stringify(old)))!, old)?.toString()).toBe('Repeated');
    // A whole-source renderer can still resolve a new unambiguous excerpt.
    expect(resolveExcerptRange(findExcerptSource(root, fragment)!, fragment)?.toString()).toBe('Repeated');
    root.innerHTML = '<div data-turn-id="turn-1"><div data-flow-item-id="reply"><p>Repeated</p><p>Repeated</p></div></div>';
    // Local offset zero in a later section must not select the first copy.
    expect(resolveExcerptRange(findExcerptSource(root, fragment)!, fragment)).toBeNull();
  });
  it('captures Markdown inline nodes and paragraph boundaries without controls', () => {
    const root = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="text-1"><p>Hello <strong>world</strong></p><p>Next line</p><button>Copy</button></div></div>');
    const paragraphs = root.querySelectorAll('p');
    const captured = captureFlowChatSelection(root, select(paragraphs[0].firstChild!, paragraphs[1].firstChild!), source)!;
    expect(captured.excerpt.fragments).toEqual([expect.objectContaining({
      turnId: 'turn-1', flowItemId: 'text-1', text: 'Hello world\nNext line', start: 0, end: 21,
    })]);
    const fragment = captured.excerpt.fragments[0];
    const resolved = resolveExcerptRange(findExcerptSource(root, fragment)!, fragment)!;
    expect(resolved.startContainer).toBe(paragraphs[0].firstChild);
    expect(resolved.endContainer).toBe(paragraphs[1].firstChild);
  });

  it('keeps fragments anchored to their own messages', () => {
    const root = transcript('<div data-turn-id="turn-1"><div class="user-message-item__content">Question</div><div data-flow-item-id="reply">Answer</div></div>');
    const blocks = root.firstElementChild!.children;
    const snapshot = captureFlowChatSelection(root, select(blocks[0].firstChild!, blocks[1].firstChild!), source)!;
    expect(snapshot.excerpt.fragments.map(part => [part.flowItemId, part.text])).toEqual([[undefined, 'Question'], ['reply', 'Answer']]);
  });

  it('preserves legacy cross-cell excerpts when table presentation wrappers are added', () => {
    const root = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="table"><table><tbody><tr><td>First <strong>value</strong></td><td>Second</td></tr><tr><td>Third</td><td>Last</td></tr></tbody></table></div></div>');
    const cells = root.querySelectorAll('td');
    const start = cells[0].firstChild!;
    const end = cells[3].firstChild!;
    const legacy = captureFlowChatSelection(root, select(start, end), source)!.excerpt.fragments[0];
    for (const cell of cells) {
      const boundary = document.createElement('div');
      boundary.className = 'markdown-table-cell-content';
      const body = document.createElement('div');
      body.className = 'markdown-table-cell-body';
      body.append(...cell.childNodes);
      boundary.append(body);
      cell.append(boundary);
    }
    const current = captureFlowChatSelection(root, select(start, end), source)!.excerpt.fragments[0];
    expect(current).toEqual(legacy);
    const restored = resolveExcerptRange(findExcerptSource(root, legacy)!, legacy)!;
    expect(restored.startContainer).toBe(start);
    expect(restored.endContainer).toBe(end);
    const restoredText = restored.toString();
    // A rehydrated excerpt from either DOM shape still resolves after reverting
    // to old markup; layout wrappers must not create persisted text separators.
    for (const cell of cells) cell.replaceChildren(...cell.querySelector('.markdown-table-cell-body')!.childNodes);
    expect(resolveExcerptRange(findExcerptSource(root, current)!, current)?.toString()).toBe(restoredText);
  });

  it('rejects a selection across session surfaces or inside an editor', () => {
    const first = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="a">first</div></div>');
    const second = transcript('<div data-turn-id="turn-2"><div data-flow-item-id="b">second</div></div>');
    expect(captureFlowChatSelection(first, select(first.querySelector('[data-flow-item-id]')!.firstChild!, second.querySelector('[data-flow-item-id]')!.firstChild!), source)).toBeNull();
    const editor = transcript('<div contenteditable="true" data-turn-id="turn-1"><div data-flow-item-id="a">draft</div></div>');
    expect(captureFlowChatSelection(editor, select(editor.querySelector('[data-flow-item-id]')!.firstChild!), source)).toBeNull();
  });

  it('relocates the correct repeated phrase after an earlier insertion and rejects removed text', () => {
    const root = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="a">First: same. Second: same.</div></div>');
    const block = root.querySelector<HTMLElement>('[data-flow-item-id]')!;
    const captured = captureFlowChatSelection(root, select(block.firstChild!, block.firstChild!, 21, 25), source)!;
    expect(captured.excerpt.fragments[0].text).toBe('same');
    block.prepend(document.createTextNode('Inserted. '));
    const range = resolveExcerptRange(block, captured.excerpt.fragments[0])!;
    expect(range.toString()).toBe('same');
    expect(range.startContainer).toBe(block.lastChild);
    block.textContent = 'The source was edited';
    expect(resolveExcerptRange(block, captured.excerpt.fragments[0])).toBeNull();
  });

  it('excludes adjacent text when selection endpoints are element offsets', () => {
    const root = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="a"><p>first</p><p>second</p></div></div>');
    const block = root.querySelector('[data-flow-item-id]')!;
    const snapshot = captureFlowChatSelection(root, select(block, block, 0, 1), source)!;
    expect(snapshot.excerpt.fragments[0].text).toBe('first');
  });

  it('maps a selected newline to a Markdown paragraph boundary after re-rendering', () => {
    const root = transcript('<div data-turn-id="turn-1"><div data-flow-item-id="a">Heading\nChosen</div></div>');
    const block = root.querySelector<HTMLElement>('[data-flow-item-id]')!;
    const fragment = captureFlowChatSelection(root, select(block.firstChild!, block.firstChild!, 7, 14), source)!.excerpt.fragments[0];
    block.innerHTML = '<p>Heading</p><p>Chosen</p>';
    expect(resolveExcerptRange(block, fragment)?.toString()).toBe('Chosen');
  });
});
