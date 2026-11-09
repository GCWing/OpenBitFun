// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FlowChatReaderState } from './readerState';
import { useTimelineInteraction } from './useTimelineInteraction';

it('retains interaction leases without layout reads while inactive and reconciles them on reveal', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), reader = new FlowChatReaderState(), release = vi.fn();
  vi.spyOn(reader, 'holdGroup').mockReturnValue(release);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1, reads = 0, deliver = () => {};
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { deliver = callback; }
    observe() {} disconnect() {}
  });
  const tick = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(16)); };
  function View({ active }: { active: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const pinned = useTimelineInteraction(ref, reader, () => true, undefined, undefined, active);
    return <div ref={ref} data-pinned={[...pinned].join(',')}><div className="virtual-item-wrapper"
      data-virtual-item-key="row" data-timeline-kind="group-members" data-timeline-group-id="group">Text</div></div>;
  }
  try {
    act(() => root.render(<View active />));
    Object.defineProperties(host.firstElementChild!, {
      clientHeight: { get: () => { reads++; return 800; } },
      clientWidth: { get: () => { reads++; return 600; } },
    });
    const range = document.createRange(); range.selectNodeContents(host.querySelector('.virtual-item-wrapper')!);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    act(() => document.dispatchEvent(new Event('selectionchange')));
    expect(host.firstElementChild?.getAttribute('data-pinned')).toBe('row');
    expect(reader.holdGroup).toHaveBeenCalledWith('group', 'reader');
    act(() => root.render(<View active={false} />)); reads = 0;
    selection.removeAllRanges();
    act(() => { document.dispatchEvent(new Event('selectionchange')); deliver(); tick(); });
    expect(reads).toBe(0); expect(release).not.toHaveBeenCalled();
    expect(host.firstElementChild?.getAttribute('data-pinned')).toBe('row');
    act(() => root.render(<View active />));
    expect(frames.size).toBe(1);
    act(tick);
    expect(reads).toBe(2); expect(release).toHaveBeenCalledTimes(1);
    expect(host.firstElementChild?.getAttribute('data-pinned')).toBe('');
  } finally { act(() => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it('coalesces mutation delivery without reading layout until the frame and ignores late delivery after disposal', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), reader = new FlowChatReaderState();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1, reads = 0, deliver = () => {};
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++; frames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { deliver = callback; }
    observe() {} disconnect() {}
  });
  function View() {
    const ref = useRef<HTMLDivElement>(null);
    useTimelineInteraction(ref, reader, () => true);
    return <div ref={ref}><div className="virtual-item-wrapper" data-virtual-item-key="row">Text</div></div>;
  }
  try {
    act(() => root.render(<View />));
    Object.defineProperties(host.firstElementChild!, {
      clientHeight: { get: () => { reads++; return 800; } },
      clientWidth: { get: () => { reads++; return 600; } },
    });
    act(() => { deliver(); deliver(); window.dispatchEvent(new Event('resize')); });
    expect(reads).toBe(0);
    expect(frames.size).toBe(1);
    act(() => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(16)); });
    expect(reads).toBe(2);
    act(() => { deliver(); root.unmount(); });
    expect(frames.size).toBe(0);
    deliver();
    expect(frames.size).toBe(0);
  } finally { if (host.firstChild) act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

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

it('retains crossing ranges and releases selection leases when cleared or moved outside', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), reader = new FlowChatReaderState(), take = vi.fn();
  function View() {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const pinned = useTimelineInteraction(scrollerRef, reader, () => true, undefined, take);
    return <>
      <p data-before>Outside before</p>
      <div ref={scrollerRef} data-scroller data-pinned={[...pinned].join(',')}>
        <div className="virtual-item-wrapper" data-virtual-item-key="first"><p>First row</p></div>
        <div className="virtual-item-wrapper" data-virtual-item-key="second"><p>Second row</p></div>
      </div>
      <p data-after>Outside after</p>
    </>;
  }
  try {
    act(() => root.render(<View />));
    const scroller = host.querySelector('[data-scroller]')!;
    Object.defineProperties(scroller, { clientHeight: { value: 800 }, clientWidth: { value: 600 } });
    const selection = window.getSelection()!;
    const select = (range: Range | null) => act(() => {
      selection.removeAllRanges();
      if (range) selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const outside = document.createRange(); outside.selectNodeContents(host.querySelector('[data-before]')!);
    select(outside);
    expect(take).not.toHaveBeenCalled();
    expect(scroller.getAttribute('data-pinned')).toBe('');

    const crossing = document.createRange();
    crossing.setStart(host.querySelector('[data-before]')!.firstChild!, 1);
    crossing.setEnd(host.querySelector('[data-after]')!.firstChild!, 5);
    select(crossing);
    expect(scroller.getAttribute('data-pinned')).toBe('first,second');
    expect(take).not.toHaveBeenCalled(); // Preserve the existing anchor-inside takeover rule.
    select(null);
    expect(scroller.getAttribute('data-pinned')).toBe('');
    select(outside);

    const inside = document.createRange(); inside.selectNodeContents(scroller.querySelector('p')!);
    select(inside);
    expect(scroller.getAttribute('data-pinned')).toBe('first');
    expect(take).toHaveBeenLastCalledWith('selection');
    select(outside);
    expect(scroller.getAttribute('data-pinned')).toBe('');
  } finally {
    act(() => { window.getSelection()?.removeAllRanges(); root.unmount(); }); host.remove();
  }
});
