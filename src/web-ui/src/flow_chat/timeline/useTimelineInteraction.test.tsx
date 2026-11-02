// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FlowChatReaderState } from './readerState';
import { useTimelineInteraction } from './useTimelineInteraction';

it('takes reading ownership before manual disclosure, leaving automatic state changes alone', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), reader = new FlowChatReaderState(), events: string[] = [];
  const take = vi.fn(() => events.push('reader'));
  function View() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    useTimelineInteraction(scrollerRef, reader, () => true, undefined, take);
    return <div ref={scrollerRef}><div className="virtual-item-wrapper" data-virtual-item-key="card">
      <button aria-expanded="false" onClick={() => events.push('toggle')}><span>Expand</span></button>
      <input aria-label="Filter" />
    </div><button data-outside="true" aria-expanded="false">Outside timeline</button></div>;
  }
  try {
    act(() => root.render(<View />));
    const button = host.querySelector('button')!;
    button.setAttribute('aria-expanded', 'true'); expect(take).not.toHaveBeenCalled();
    act(() => button.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(events).toEqual(['reader', 'toggle']);
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() => host.querySelector('input')!.click());
    expect(take).toHaveBeenCalledTimes(3);
    act(() => host.querySelector('input')!.focus());
    expect(take).toHaveBeenCalledTimes(3);
    act(() => host.querySelector<HTMLElement>('[data-outside]')!.click());
    expect(take).toHaveBeenCalledTimes(3);
    act(() => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    expect(take).toHaveBeenCalledTimes(4);
    act(() => host.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true })));
    expect(take).toHaveBeenCalledTimes(5);
  } finally { act(() => root.unmount()); host.remove(); }
});

it('retains focused response controls without takeover, while disclosure and transcript selection still take over', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), reader = new FlowChatReaderState(), take = vi.fn();
  function View() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const pinned = useTimelineInteraction(scrollerRef, reader, () => true, undefined, take);
    return <div ref={scrollerRef} data-pinned={[...pinned].join(',')}>
      <div className="virtual-item-wrapper" data-virtual-item-key="question" data-flowchat-interaction="response">
        <input aria-label="Answer" /><button aria-expanded="true">Fold</button><p>Question text</p>
        <button aria-expanded="false" aria-haspopup="menu" data-menu>Actions</button>
        <div aria-expanded="true"><button data-action>Respond</button></div>
        <div contentEditable="plaintext-only" data-answer-editor suppressContentEditableWarning>Custom answer</div>
        <span data-whitespace> </span>
      </div>
    </div>;
  }
  try {
    act(() => root.render(<View />));
    const scroller = host.firstElementChild!;
    Object.defineProperties(scroller, { clientHeight: { value: 800 }, clientWidth: { value: 600 } });
    const answer = host.querySelector('input')!;
    act(() => answer.focus());
    expect(scroller.getAttribute('data-pinned')).toBe('question');
    act(() => {
      answer.click();
      answer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      answer.dispatchEvent(new Event('input', { bubbles: true }));
      answer.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(take).not.toHaveBeenCalled();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-menu]')!.click();
      host.querySelector<HTMLButtonElement>('[data-action]')!.click();
    });
    const select = (selector: string) => {
      const selection = window.getSelection()!;
      const range = document.createRange(); range.selectNodeContents(host.querySelector(selector)!);
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    };
    act(() => select('[data-whitespace]'));
    act(() => select('[data-answer-editor]'));
    expect(take).not.toHaveBeenCalled();
    act(() => host.querySelector('button')!.click());
    expect(take).toHaveBeenCalledTimes(1);
    act(() => select('p'));
    expect(take).toHaveBeenCalledTimes(2);
    expect(take).toHaveBeenLastCalledWith('selection');
  } finally {
    act(() => { window.getSelection()?.removeAllRanges(); root.unmount(); }); host.remove();
  }
});
