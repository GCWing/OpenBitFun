// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { contextMenuRegistry } from '@/shared/context-menu-system/core/ContextMenuRegistry';
import { ContextType, type SelectionContext } from '@/shared/context-menu-system/types/context.types';
import { FlowChatSelectionBar } from './FlowChatSelectionBar';
import { FLOWCHAT_EXCERPT_ACTION, type ExcerptActionRequest } from './excerptActions';

const state = vi.hoisted(() => ({
  sessions: new Map([['main', { sessionId: 'main', title: 'Source session', workspacePath: '/workspace' }]]),
  t: (key: string) => key,
}));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({ sessions: state.sessions }) } }));
vi.mock('../session-drivers/resolve', () => ({ resolveSessionDriverId: () => 'local' }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: state.t }) }));

function Transcript() {
  const rootRef = useRef<HTMLDivElement>(null);
  return <>
    <div ref={rootRef} tabIndex={-1} data-flowchat-selection-root="main">
      <div data-turn-id="turn"><div data-flow-item-id="text">Selected source text</div></div>
    </div>
    <FlowChatSelectionBar rootRef={rootRef} sessionId="main" />
  </>;
}

describe('selection annotation dialog lifecycle', () => {
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

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    activateSurface('local');
    frames.clear();
    requests.length = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Transcript />));
    window.addEventListener(FLOWCHAT_EXCERPT_ACTION, receive);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.removeEventListener(FLOWCHAT_EXCERPT_ACTION, receive);
    window.getSelection()?.removeAllRanges();
    container.remove();
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(host => host.remove());
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('keeps the comment while the editor scrolls, resizes, or the source unmounts', async () => {
    const surface = await openAnnotation();
    const textarea = enterComment('Keep this note');
    expect(document.activeElement).toBe(textarea);
    expect(surface.querySelector('[data-openbitfun-product-part="quote"]')?.textContent).toBe('Selected source text');
    expect(surface.querySelector('label')).toBeNull();
    expect(textarea.getAttribute('placeholder')).toBeNull();
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
