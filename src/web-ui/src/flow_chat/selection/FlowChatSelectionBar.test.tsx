// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { contextMenuRegistry } from '@/shared/context-menu-system/core/ContextMenuRegistry';
import { ContextType, type SelectionContext } from '@/shared/context-menu-system/types/context.types';
import { FlowChatSelectionBar } from './FlowChatSelectionBar';
import { FLOWCHAT_EXCERPT_ACTION, type ExcerptActionRequest } from './excerptActions';
import { highlightExcerptRange } from './locateConversationExcerpt';
import { ConversationExcerptQuote } from './ConversationExcerptEditor';
import type { ConversationExcerptContext } from '@/shared/types/context';
import * as excerptUtils from '@/shared/utils/conversationExcerpt';

const state = vi.hoisted(() => ({
  sessions: new Map<string, { sessionId: string; title: string; workspacePath: string; sessionKind?: string }>([
    ['main', { sessionId: 'main', title: 'Source session', workspacePath: '/workspace' }],
    ['btw', { sessionId: 'btw', title: 'Side session', workspacePath: '/workspace', sessionKind: 'btw' }],
  ]),
  t: (key: string) => key,
  getPreference: vi.fn(),
  preferenceListeners: new Set<() => void>(),
  selectionIntent: vi.fn(),
}));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  hasCachedConfig: () => false,
  getCachedConfig: () => undefined,
  getOptionalConfig: state.getPreference,
  watch: (_path: string, callback: () => void) => {
    state.preferenceListeners.add(callback);
    return () => state.preferenceListeners.delete(callback);
  },
} }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: state.sessions }) } }));
vi.mock('../session-drivers/resolve', () => ({ resolveSessionDriverId: () => 'local' }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: state.t }) }));

function Transcript({ sessionId = 'main' }: { sessionId?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  return <>
    <div ref={rootRef} tabIndex={-1} data-flowchat-selection-root={sessionId}>
      <div data-turn-id="turn"><div data-flow-item-id="text">Selected source text</div></div>
    </div>
    <FlowChatSelectionBar rootRef={rootRef} sessionId={sessionId} parentSessionId={sessionId === 'btw' ? 'main' : undefined}
      onSelectionIntent={state.selectionIntent} />
  </>;
}

describe('selection toolbar and floating annotation editor lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const requests: ExcerptActionRequest[] = [];
  const receive = (event: Event) => requests.push((event as CustomEvent<ExcerptActionRequest>).detail);
  const flushFrames = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
  const dialog = () => document.querySelector<HTMLDivElement>('[role="dialog"][data-state="open"]')!;
  const toolbar = () => document.querySelector<HTMLDivElement>('.conversation-excerpt__popover');
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  const resizeCallbacks = new Set<() => void>();
  let textTop = 200;

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    activateSurface('local');
    frames.clear();
    resizeCallbacks.clear();
    textTop = 200;
    requests.length = 0;
    state.getPreference.mockReset().mockResolvedValue(undefined);
    state.selectionIntent.mockClear();
    state.preferenceListeners.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Transcript />));
    window.addEventListener(FLOWCHAT_EXCERPT_ACTION, receive);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.removeEventListener(FLOWCHAT_EXCERPT_ACTION, receive);
    window.getSelection()?.removeAllRanges();
    container.remove();
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(host => host.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  });

  // Geometry is supplied only for lifecycle assertions; this is not visual acceptance.
  function selectForToolbar(dragging = false) {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: () => void) { resizeCallbacks.add(callback); }
      observe() {}
      disconnect() { resizeCallbacks.delete(this.callback); }
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList.contains('conversation-excerpt__popover')
        ? new DOMRect(0, 0, 160, 30) : new DOMRect(100, 80, 600, 440);
    });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function (this: Range) {
      if (this.startContainer.nodeType !== Node.TEXT_NODE) return [];
      return [new DOMRect(180 + this.startOffset * 10, textTop, (this.endOffset - this.startOffset) * 10, 20)];
    } });
    const target = container.querySelector('[data-flow-item-id]')!;
    if (dragging) act(() => target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    act(() => {
      window.getSelection()!.setBaseAndExtent(target.firstChild!, 0, target.firstChild!, target.textContent!.length);
      document.dispatchEvent(new Event('selectionchange'));
    });
    flushFrames();
    return target;
  }

  it('waits for the selecting gesture to end and keeps one position for unchanged selection events', () => {
    const target = selectForToolbar(true);
    expect(toolbar()).toBeNull();
    act(() => target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })));
    flushFrames();
    const popup = toolbar()!;
    expect(popup.style.visibility).toBe('visible');
    const position = popup.style.cssText;
    act(() => document.dispatchEvent(new Event('selectionchange')));
    flushFrames();
    expect(toolbar()).toBe(popup);
    expect(popup.style.cssText).toBe(position);
  });

  it.each([120, 680])('completes a drag released in a gutter at x=%i even when that region stops bubbling', (clientX) => {
    selectForToolbar(true);
    const gutter = document.createElement('div');
    container.querySelector('[data-flowchat-selection-root]')!.append(gutter);
    gutter.addEventListener('pointerup', event => event.stopPropagation());
    act(() => gutter.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX, clientY: 210 })));
    flushFrames();
    expect(toolbar()?.style.visibility).toBe('visible');
    expect(window.getSelection()?.toString()).toBe('Selected source text');
    gutter.remove();
  });

  it.each(['left', 'right'])('accepts a native selection ending on the %s whitespace wrapper', (side) => {
    const target = selectForToolbar(true);
    const scope = container.querySelector('[data-flowchat-selection-root]')!;
    const gutter = document.createElement('div');
    if (side === 'left') scope.prepend(gutter); else scope.append(gutter);
    act(() => {
      window.getSelection()!.setBaseAndExtent(target.firstChild!, side === 'left' ? target.textContent!.length : 0, gutter, 0);
      document.dispatchEvent(new Event('selectionchange'));
      gutter.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    });
    flushFrames();
    expect(toolbar()?.style.visibility).toBe('visible');
    expect(window.getSelection()?.toString()).toBe('Selected source text');
    gutter.remove();
  });

  it('ignores other panes scrolling and does not reopen a scrolled-away selection on unrelated pointerup', () => {
    selectForToolbar();
    const unrelated = document.createElement('div');
    document.body.append(unrelated);
    const popup = toolbar();
    expect(popup).not.toBeNull();
    act(() => unrelated.dispatchEvent(new Event('scroll')));
    expect(toolbar()).toBe(popup);
    act(() => container.querySelector('[data-flowchat-selection-root]')!.dispatchEvent(new Event('scroll')));
    expect(toolbar()).toBeNull();
    act(() => {
      unrelated.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange'));
    });
    flushFrames();
    expect(toolbar()).toBeNull();
    expect(window.getSelection()?.toString()).toBe('Selected source text');
    unrelated.remove();
  });

  it('retires the toolbar when its text moves instead of moving an action under the pointer', () => {
    selectForToolbar();
    expect(toolbar()).not.toBeNull();
    textTop += 40;
    act(() => resizeCallbacks.forEach(callback => callback()));
    flushFrames();
    expect(toolbar()).toBeNull();
  });

  it('does not treat a cancelled selection gesture as a completed selection', () => {
    const target = selectForToolbar(true);
    act(() => target.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true })));
    act(() => document.dispatchEvent(new Event('selectionchange')));
    flushFrames();
    expect(toolbar()).toBeNull();
  });

  it('lets keyboard users focus and dismiss the toolbar without reviving it on the same selection', () => {
    selectForToolbar();
    const first = toolbar()!.querySelector('button');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    act(() => first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(toolbar()).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-flowchat-selection-root]'));
    act(() => document.dispatchEvent(new Event('selectionchange')));
    flushFrames();
    expect(toolbar()).toBeNull();
  });

  async function openAnnotation(beforeOpen?: () => void) {
    selectForToolbar();
    const target = container.querySelector<HTMLElement>('[data-flow-item-id]')!;
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const context: SelectionContext = {
      type: ContextType.SELECTION, event: new MouseEvent('contextmenu'), targetElement: target,
      position: { x: 0, y: 0 }, timestamp: Date.now(), selectedText: selection.toString(), selection, isEditable: false,
    };
    const provider = contextMenuRegistry.findMatchingProviders(context)[0];
    await act(async () => {
      const items = await provider.getMenuItems(context);
      beforeOpen?.();
      await items[0].onClick?.(context);
    });
    flushFrames();
    return dialog();
  }

  function enterComment(value: string) {
    const textarea = dialog().querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return textarea;
  }

  async function setAutoShowToolbar(enabled: boolean) {
    state.getPreference.mockResolvedValue(enabled);
    await act(async () => state.preferenceListeners.forEach(callback => callback()));
  }

  it.each(['main', 'btw'])('hides automatic actions in %s while retaining selection, reading intent, and the ask shortcut', async (sessionId) => {
    await setAutoShowToolbar(false);
    await act(async () => root.render(<Transcript sessionId={sessionId} />));
    selectForToolbar();
    expect(toolbar()).toBeNull();
    expect(state.selectionIntent).toHaveBeenCalledOnce();
    expect(window.getSelection()?.toString()).toBe('Selected source text');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'b', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    })));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: 'ask', parentSessionId: 'main', excerpt: { source: { sessionId } } });
  });

  it('retains right-click annotation and side questions when automatic actions are disabled', async () => {
    await setAutoShowToolbar(false);
    expect(await openAnnotation()).not.toBeNull();
    act(() => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    act(() => vi.advanceTimersByTime(180));
    const target = selectForToolbar();
    const context: SelectionContext = {
      type: ContextType.SELECTION, event: new MouseEvent('contextmenu'), targetElement: target,
      position: { x: 0, y: 0 }, timestamp: Date.now(), selectedText: window.getSelection()!.toString(),
      selection: window.getSelection()!, isEditable: false,
    };
    const provider = contextMenuRegistry.findMatchingProviders(context)[0];
    await act(async () => {
      const items = await provider.getMenuItems(context);
      expect(items[1].disabled).toBe(false);
      await items[1].onClick?.(context);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('ask');
    expect(toolbar()).toBeNull();
  });

  it('closes an existing toolbar immediately and allows a fresh selection after re-enabling', async () => {
    const target = selectForToolbar();
    expect(toolbar()).not.toBeNull();
    await setAutoShowToolbar(false);
    expect(toolbar()).toBeNull();
    expect(window.getSelection()?.toString()).toBe('Selected source text');
    await setAutoShowToolbar(true);
    expect(toolbar()).toBeNull();
    act(() => {
      window.getSelection()!.setBaseAndExtent(target.firstChild!, 1, target.firstChild!, 8);
      document.dispatchEvent(new Event('selectionchange'));
    });
    flushFrames();
    expect(toolbar()).not.toBeNull();
  });

  it('does not discard an open annotation or its comment when automatic actions are disabled', async () => {
    const surface = await openAnnotation();
    const textarea = enterComment('Keep this draft');
    await setAutoShowToolbar(false);
    expect(dialog()).toBe(surface);
    expect(textarea.value).toBe('Keep this draft');
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    })));
    expect(requests[0]).toMatchObject({ action: 'annotate', excerpt: { comment: 'Keep this draft' } });
  });

  it('releases temporary paint without allowing an old locate timer to clear the next excerpt', () => {
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
    const text = container.querySelector('[data-flow-item-id]')!;
    const first = document.createRange(); first.selectNodeContents(text);
    const releaseFirst = highlightExcerptRange(first);
    const second = first.cloneRange(); second.setStart(text.firstChild!, 1);
    const releaseSecond = highlightExcerptRange(second);
    releaseFirst();
    expect([...highlights.get('openbitfun-flowchat-excerpt')!]).toEqual([second]);
    expect(text.hasAttribute('data-flowchat-highlight-excerpt')).toBe(true);
    releaseSecond();
    expect(highlights.size).toBe(0);
    expect(text.hasAttribute('data-flowchat-highlight-excerpt')).toBe(false);
  });

  it('keeps the comment while the editor scrolls, resizes, or the source unmounts', async () => {
    const surface = await openAnnotation();
    const textarea = enterComment('Keep this note');
    expect(document.activeElement).toBe(textarea);
    expect(surface.querySelector('[data-openbitfun-product-part="quote"]')?.textContent).toBe('Selected source text');
    expect(surface.querySelector('label')).toBeNull();
    expect(textarea.getAttribute('placeholder')).toBe('selection.annotationPlaceholder');
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      textarea.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      container.querySelector('[data-flow-item-id]')!.remove();
    });
    flushFrames();
    expect(dialog()).toBe(surface);
    expect(textarea.value).toBe('Keep this note');
    expect(requests).toEqual([]);
  });

  it('keeps the transcript interactive and returns focus when cancelled from the editor', async () => {
    const surface = await openAnnotation();
    expect(surface.getAttribute('aria-modal')).toBe('false');
    expect(document.querySelector('[data-openbitfun-overlay-modal="true"]')).toBeNull();
    const transcript = container.querySelector<HTMLElement>('[data-flowchat-selection-root]')!;
    expect(transcript.closest('[inert]')).toBeNull();
    act(() => {
      transcript.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      transcript.focus();
      transcript.dispatchEvent(new Event('scroll'));
    });
    expect(dialog()).toBe(surface);
    expect(document.activeElement).toBe(transcript);
    surface.querySelector('textarea')!.focus();
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(dialog()).toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(document.activeElement).toBe(container.querySelector('[data-flowchat-selection-root]'));
    expect(requests).toEqual([]);
  });

  function pointer(target: HTMLElement, type: string, x: number, y: number, pointerId = 1) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    act(() => target.dispatchEvent(event));
  }

  it('reuses formatted quote text across renders and refreshes it for a new excerpt', () => {
    const format = vi.spyOn(excerptUtils, 'excerptText');
    const excerpt: ConversationExcerptContext = {
      id: 'quote', type: 'conversation-excerpt', timestamp: 0,
      source: { surfaceId: 'local', sessionId: 'main', sessionName: 'Source session' },
      fragments: [{ turnId: 'turn', text: '  Selected\n source\ttext  ', start: 0, end: 25, prefix: '', suffix: '' }],
    };
    act(() => root.render(<ConversationExcerptQuote excerpt={excerpt} />));
    expect(format).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('Selected source text');
    act(() => root.render(<ConversationExcerptQuote excerpt={excerpt} action={<button>Action</button>} />));
    expect(format).toHaveBeenCalledOnce();
    const updated = { ...excerpt, fragments: [{ ...excerpt.fragments[0], text: ' New\n quote ', end: 12 }] };
    act(() => root.render(<ConversationExcerptQuote excerpt={updated} />));
    expect(format).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('New quote');
  });

  it.each([
    { selector: '.conversation-excerpt__drag', property: 'left', delta: 60 },
    { selector: '[data-resize-edge="right"]', property: 'width', delta: 60 },
    { selector: '[data-resize-edge="bottom"]', property: 'height', delta: 40 },
    { selector: '[data-resize-edge="corner"]', property: 'width', delta: 60 },
  ] as const)('coalesces $selector pointer samples into one update per frame', async ({ selector, property, delta }) => {
    const format = vi.spyOn(excerptUtils, 'excerptText');
    const surface = await openAnnotation();
    const formatCalls = format.mock.calls.length;
    const handle = surface.querySelector<HTMLElement>(selector)!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    const initial = Number.parseFloat(surface.style[property]);
    pointer(handle, 'pointerdown', 300, 300);
    for (let index = 1; index <= 20; index += 1) pointer(handle, 'pointermove', 300 + index * 3, 300 + index * 2);
    expect(Number.parseFloat(surface.style[property])).toBe(initial);
    expect(frames.size).toBe(1);
    flushFrames();
    expect(Number.parseFloat(surface.style[property])).toBe(initial + delta);
    expect(frames.size).toBe(0);
    pointer(handle, 'pointermove', 330, 320);
    expect(Number.parseFloat(surface.style[property])).toBe(initial + delta);
    flushFrames();
    expect(Number.parseFloat(surface.style[property])).toBe(initial + delta / 2);
    expect(format).toHaveBeenCalledTimes(formatCalls);
    pointer(handle, 'pointerup', 330, 320);
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('flushes the final pending sample on %s without leaving a stale frame', async (event) => {
    const surface = await openAnnotation();
    const handle = surface.querySelector<HTMLElement>('.conversation-excerpt__drag')!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => event !== 'lostpointercapture');
    handle.releasePointerCapture = vi.fn();
    const initialLeft = Number.parseFloat(surface.style.left);
    pointer(handle, 'pointerdown', 300, 300);
    pointer(handle, 'pointermove', 350, 340);
    pointer(handle, event, 350, 340);
    expect(Number.parseFloat(surface.style.left)).toBe(initialLeft + 50);
    expect(frames.size).toBe(0);
    pointer(handle, 'pointermove', 400, 400);
    flushFrames();
    expect(Number.parseFloat(surface.style.left)).toBe(initialLeft + 50);
  });

  it.each(['resize', 'close'])('discards queued drag work on viewport %s', async (action) => {
    const surface = await openAnnotation();
    const handle = surface.querySelector<HTMLElement>('.conversation-excerpt__drag')!;
    handle.setPointerCapture = vi.fn();
    const initialLeft = surface.style.left;
    pointer(handle, 'pointerdown', 300, 300);
    pointer(handle, 'pointermove', 500, 400);
    act(() => action === 'resize' ? window.dispatchEvent(new Event('resize'))
      : surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(frames.size).toBe(0);
    flushFrames();
    if (action === 'close') expect(dialog()).toBeNull();
    else {
      expect(surface.style.left).toBe(initialLeft);
      pointer(handle, 'pointermove', 600, 500);
      expect(frames.size).toBe(0);
    }
  });

  it('opens near the selection from the toolbar without covering the selected line', () => {
    selectForToolbar();
    act(() => toolbar()!.querySelector('button')!.click());
    flushFrames();
    const surface = dialog();
    expect(surface.style.visibility).toBe('visible');
    expect(Number.parseFloat(surface.style.top)).toBe(228);
    expect(Number.parseFloat(surface.style.left)).toBe(200);
    expect(surface.querySelector('textarea')!.getAttribute('data-openbitfun-part')).toBe('input');
  });

  it('keeps the selected location when focusing the transcript replaces the source DOM', () => {
    const source = selectForToolbar();
    const transcript = container.querySelector<HTMLElement>('[data-flowchat-selection-root]')!;
    vi.spyOn(transcript, 'focus').mockImplementation(() => source.replaceChildren('Selected source text'));
    act(() => toolbar()!.querySelector('button')!.click());
    flushFrames();
    expect(dialog().style.left).toBe('200px');
    expect(dialog().style.top).toBe('228px');
  });

  it('keeps the context-menu selection location when its source rerenders before the action runs', async () => {
    const surface = await openAnnotation(() => {
      container.querySelector('[data-flow-item-id]')!.replaceChildren('Selected source text');
    });
    expect(surface.style.left).toBe('200px');
    expect(surface.style.top).toBe('228px');
  });

  it('moves and resizes using pointer capture, preserves the draft, and stays inside the viewport', async () => {
    const surface = await openAnnotation();
    const textarea = enterComment('Keep while moving');
    const handle = surface.querySelector<HTMLElement>('.conversation-excerpt__drag')!;
    const resize = surface.querySelector<HTMLElement>('[data-resize-edge="corner"]')!;
    for (const element of [handle, resize]) {
      element.setPointerCapture = vi.fn();
      element.hasPointerCapture = vi.fn(() => true);
      element.releasePointerCapture = vi.fn();
    }
    const initialLeft = Number.parseFloat(surface.style.left);
    const initialTop = Number.parseFloat(surface.style.top);
    pointer(handle, 'pointerdown', 200, 240);
    pointer(handle, 'pointermove', 232, 264, 2);
    expect(Number.parseFloat(surface.style.left)).toBe(initialLeft);
    pointer(handle, 'pointermove', 232, 264);
    pointer(handle, 'pointerup', 232, 264);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(Number.parseFloat(surface.style.left)).toBe(initialLeft + 32);
    expect(Number.parseFloat(surface.style.top)).toBe(initialTop + 24);
    pointer(resize, 'pointerdown', 560, 508);
    pointer(resize, 'pointermove', 620, 548);
    pointer(resize, 'pointerup', 620, 548);
    expect(surface.style.width).toBe('420px');
    expect(surface.style.height).toBe('320px');
    pointer(resize, 'pointerdown', 620, 548);
    pointer(resize, 'pointermove', -2000, -2000);
    pointer(resize, 'pointercancel', -2000, -2000);
    expect(surface.style.width).toBe('260px');
    expect(surface.style.height).toBe('220px');
    pointer(handle, 'pointerdown', 232, 264);
    pointer(handle, 'pointermove', 5000, 5000);
    pointer(handle, 'pointerup', 5000, 5000);
    expect(Number.parseFloat(surface.style.left) + Number.parseFloat(surface.style.width)).toBe(window.innerWidth - 8);
    expect(Number.parseFloat(surface.style.top) + Number.parseFloat(surface.style.height)).toBe(window.innerHeight - 8);
    act(() => {
      vi.stubGlobal('innerWidth', 320);
      vi.stubGlobal('innerHeight', 300);
      window.dispatchEvent(new Event('resize'));
    });
    expect(Number.parseFloat(surface.style.left) + Number.parseFloat(surface.style.width)).toBeLessThanOrEqual(312);
    expect(Number.parseFloat(surface.style.top) + Number.parseFloat(surface.style.height)).toBeLessThanOrEqual(292);
    expect(textarea.value).toBe('Keep while moving');
    expect(requests).toEqual([]);
  });

  it.each([
    { edge: 'right', width: '420px', height: '280px' },
    { edge: 'bottom', width: '360px', height: '320px' },
    { edge: 'corner', width: '420px', height: '320px' },
  ])('resizes from the $edge without changing the other axis or losing the draft', async ({ edge, width, height }) => {
    const surface = await openAnnotation();
    const textarea = enterComment('Keep this draft');
    const initialLeft = surface.style.left;
    const initialTop = surface.style.top;
    const handle = surface.querySelector<HTMLElement>(`[data-resize-edge="${edge}"]`)!;
    expect(handle.children).toHaveLength(0);
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();
    pointer(handle, 'pointerdown', 400, 400);
    pointer(handle, 'pointermove', 460, 440);
    pointer(handle, 'pointerup', 460, 440);
    expect(surface.style.width).toBe(width);
    expect(surface.style.height).toBe(height);
    pointer(handle, 'pointermove', 500, 500);
    expect(surface.style.width).toBe(width);
    expect(surface.style.height).toBe(height);
    expect(surface.style.left).toBe(initialLeft);
    expect(surface.style.top).toBe(initialTop);
    expect(textarea.value).toBe('Keep this draft');
    expect(requests).toEqual([]);
  });

  it.each([
    { edge: 'right', width: '368px', height: '280px' },
    { edge: 'bottom', width: '360px', height: '288px' },
  ])('resizes only the $edge axis with keyboard arrows', async ({ edge, width, height }) => {
    const surface = await openAnnotation();
    const handle = surface.querySelector<HTMLElement>(`[data-resize-edge="${edge}"]`)!;
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(surface.style.width).toBe(width);
    expect(surface.style.height).toBe(height);
  });

  it('moves and resizes with keyboard arrows without submitting the draft', async () => {
    const surface = await openAnnotation();
    const move = surface.querySelector<HTMLElement>('.conversation-excerpt__drag')!;
    const resize = surface.querySelector<HTMLElement>('[data-resize-edge="corner"]')!;
    const initialLeft = Number.parseFloat(surface.style.left);
    act(() => {
      move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(Number.parseFloat(surface.style.left)).toBe(initialLeft + 8);
    expect(surface.style.height).toBe('312px');
    expect(requests).toEqual([]);
  });

  it('submits the frozen quote and trimmed comment once using the editor shortcut', async () => {
    await openAnnotation();
    const textarea = enterComment('  Please clarify  ');
    act(() => {
      window.getSelection()?.removeAllRanges();
      container.querySelector('[data-flow-item-id]')!.remove();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: 'annotate', parentSessionId: 'main', excerpt: {
      comment: 'Please clarify', source: { sessionId: 'main', surfaceId: 'local' },
      fragments: [{ text: 'Selected source text' }],
    } });
    expect(dialog()).toBeNull();
  });
});
