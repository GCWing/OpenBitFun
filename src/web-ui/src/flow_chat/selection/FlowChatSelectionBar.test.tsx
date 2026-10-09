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

describe('selection toolbar and annotation dialog lifecycle', () => {
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

  async function openAnnotation() {
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

  it('contains keyboard focus and returns it to the transcript when cancelled', async () => {
    const surface = await openAnnotation();
    const buttons = surface.querySelectorAll('button');
    buttons[buttons.length - 1].focus();
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(buttons[0]);
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(dialog()).toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(document.activeElement).toBe(container.querySelector('[data-flowchat-selection-root]'));
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
