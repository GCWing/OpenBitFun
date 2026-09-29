// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFlowChatSelection } from './flowChatSelection';
import { computeSelectionBarPosition, measureSelectionBarGeometry, sameFlowChatSelection, type SelectionBarGeometry } from './flowChatSelectionPosition';

const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
const size = { width: 160, height: 30 };
const geometry = (x = 380, top = 200): SelectionBarGeometry => ({
  anchor: { x, top, bottom: top + 20, preferredPlacement: 'top' },
  bounds: rect(100, 100, 600, 400),
  textRects: [rect(180, top, 200, 20)],
});

describe('selection toolbar placement policy', () => {
  it('centres on the focus endpoint above a single line', () => {
    expect(computeSelectionBarPosition(geometry(), size)).toEqual({ left: 300, top: 162, placement: 'top' });
  });

  it('shifts only as far as required to stay within the transcript pane', () => {
    expect(computeSelectionBarPosition(geometry(105), size)?.left).toBe(108);
    expect(computeSelectionBarPosition(geometry(695), size)?.left).toBe(532);
  });

  it('keeps a valid selection actionable when its horizontal endpoint extends past the pane', () => {
    expect(computeSelectionBarPosition(geometry(80), size)).toEqual({ left: 108, top: 162, placement: 'top' });
    expect(computeSelectionBarPosition(geometry(740), size)).toEqual({ left: 532, top: 162, placement: 'top' });
  });

  it('flips when opening at an edge, then keeps the chosen side', () => {
    const edge = geometry(380, 110);
    expect(computeSelectionBarPosition(edge, size)).toEqual({ left: 300, top: 138, placement: 'bottom' });
    expect(computeSelectionBarPosition(edge, size, 'top')).toBeNull();
  });

  it('does not flip into the selected lines when the endpoint is near the bottom', () => {
    const multiline = geometry(380, 450);
    multiline.anchor.preferredPlacement = 'bottom';
    multiline.textRects = [rect(180, 400, 420, 45), rect(180, 450, 200, 20)];
    expect(computeSelectionBarPosition(multiline, size)).toBeNull();
  });

  it('rejects vertically clipped endpoints and panes too narrow for the toolbar', () => {
    expect(computeSelectionBarPosition(geometry(380, 90), size)).toBeNull();
    expect(computeSelectionBarPosition({ ...geometry(), bounds: rect(300, 100, 170, 400) }, size)).toBeNull();
  });
});

// Supplied DOM geometry verifies the selection/positioning contract, not rendered appearance.
describe('native selection endpoint geometry', () => {
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  let root: HTMLDivElement;
  let scroller: HTMLElement;
  let source: HTMLElement;
  let first: Text;
  let last: Text;
  const textGeometry = new Map<Node, DOMRect>();
  const elementGeometry = new Map<Element, DOMRect>();

  beforeEach(() => {
    root = document.createElement('div');
    root.dataset.flowchatSelectionRoot = 'session';
    root.innerHTML = '<div data-flowchat-scroller="true" data-openbitfun-viewport-inset-bottom="100" style="overflow: auto">'
      + '<div data-turn-id="turn"><div data-flow-item-id="text"><p>first <strong>bold</strong></p><p>last</p></div></div></div>';
    document.body.append(root);
    scroller = root.firstElementChild as HTMLElement;
    source = root.querySelector('[data-flow-item-id]')!;
    first = source.querySelector('p')!.firstChild as Text;
    last = source.querySelectorAll('p')[1].firstChild as Text;
    textGeometry.set(first, rect(180, 180, 60, 20));
    textGeometry.set(source.querySelector('strong')!.firstChild!, rect(240, 180, 40, 20));
    textGeometry.set(last, rect(180, 220, 40, 20));
    elementGeometry.set(root, rect(0, 0, 900, 600));
    elementGeometry.set(scroller, rect(100, 100, 600, 400));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return elementGeometry.get(this) ?? rect(0, 0, 0, 0);
    });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function (this: Range) {
      const bounds = textGeometry.get(this.startContainer);
      if (!bounds || this.startContainer !== this.endContainer) return [];
      const width = bounds.width / this.startContainer.textContent!.length;
      return [rect(bounds.left + this.startOffset * width, bounds.top, (this.endOffset - this.startOffset) * width, bounds.height)];
    } });
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    root.remove(); textGeometry.clear(); elementGeometry.clear();
    vi.restoreAllMocks();
    if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  });

  function capture(backward = false) {
    const native = window.getSelection()!;
    native.setBaseAndExtent(backward ? last : first, backward ? 4 : 2, backward ? first : last, backward ? 2 : 4);
    return captureFlowChatSelection(root, native, { sessionId: 'session', surfaceId: 'local', sessionName: 'Session' })!;
  }

  it('places a forward multiline selection below its actual endpoint and excludes the input inset', () => {
    const measured = measureSelectionBarGeometry(root, capture())!;
    expect(measured.anchor).toEqual({ x: 220, top: 220, bottom: 240, preferredPlacement: 'bottom' });
    expect(measured.bounds).toEqual({ left: 100, right: 700, top: 100, bottom: 400 });
    expect(computeSelectionBarPosition(measured, size)).toEqual({ left: 140, top: 248, placement: 'bottom' });
  });

  it('puts reverse selection above the focus at the start, keeping document order only for quoting', () => {
    const forward = capture();
    const backward = capture(true);
    expect(backward.range.toString()).toBe(forward.range.toString());
    expect(sameFlowChatSelection(forward, backward)).toBe(false);
    expect(sameFlowChatSelection(backward, window.getSelection())).toBe(true);
    expect(measureSelectionBarGeometry(root, backward)?.anchor)
      .toEqual({ x: 200, top: 180, bottom: 200, preferredPlacement: 'top' });
  });

  it('uses selected text runs when an element-offset endpoint has no caret rectangle', () => {
    const native = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(source);
    native.removeAllRanges(); native.addRange(range);
    const snapshot = captureFlowChatSelection(root, native, { sessionId: 'session', surfaceId: 'local', sessionName: 'Session' })!;
    expect(measureSelectionBarGeometry(root, snapshot)?.anchor.x).toBe(220);
  });

  it('rejects an endpoint hidden by nested clipping or the overlaid input', () => {
    const snapshot = capture();
    const paragraph = last.parentElement!;
    paragraph.style.overflowY = 'hidden';
    elementGeometry.set(paragraph, rect(100, 250, 500, 100));
    expect(measureSelectionBarGeometry(root, snapshot)).toBeNull();
    paragraph.style.overflowY = '';
    scroller.dataset.openbitfunViewportInsetBottom = '280';
    expect(measureSelectionBarGeometry(root, snapshot)).toBeNull();
  });

  it('anchors to the visible part of a selected line when the focus extends beyond its left edge', () => {
    const snapshot = capture(true);
    textGeometry.set(first, rect(20, 180, 120, 20));
    const measured = measureSelectionBarGeometry(root, snapshot)!;
    expect(measured?.anchor).toEqual({ x: 100, top: 180, bottom: 200, preferredPlacement: 'top' });
    expect(computeSelectionBarPosition(measured, size)).toEqual({ left: 108, top: 142, placement: 'top' });
  });

  it('also keeps a selection actionable when its focus extends beyond the right edge', () => {
    textGeometry.set(last, rect(680, 220, 120, 20));
    const measured = measureSelectionBarGeometry(root, capture())!;
    expect(measured?.anchor.x).toBe(700);
    expect(computeSelectionBarPosition(measured, size)).toEqual({ left: 532, top: 248, placement: 'bottom' });
  });

  it('still rejects a selected endpoint line that is entirely clipped horizontally', () => {
    textGeometry.set(first, rect(0, 180, 60, 20));
    textGeometry.set(source.querySelector('strong')!.firstChild!, rect(60, 180, 40, 20));
    expect(measureSelectionBarGeometry(root, capture(true))).toBeNull();
  });

  it('falls back to the embedded transcript root without using another pane', () => {
    scroller.removeAttribute('data-flowchat-scroller');
    const measured = measureSelectionBarGeometry(root, capture())!;
    expect(measured.bounds).toEqual({ left: 0, right: 900, top: 0, bottom: 600 });
  });
});
