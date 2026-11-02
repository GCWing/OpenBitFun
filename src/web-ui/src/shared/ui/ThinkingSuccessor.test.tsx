// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingBlock } from '@openbitfun/ui/flow-chat';

// Controllable transition promises verify sequencing, not rendered appearance.
describe('thinking to successor transaction', () => {
  let host: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let reduced: boolean;
  let onPreference: (() => void) | undefined;
  const ready = vi.fn();
  const panel = () => host.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
  const successor = () => host.querySelector<HTMLElement>('[data-thinking-continuation]')!;
  const nextFrame = () => act(() => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(16));
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    reduced = false;
    onPreference = undefined;
    frames = new Map();
    let next = 0;
    ready.mockClear();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({
      get matches() { return reduced; },
      addEventListener: (_event: string, callback: () => void) => { onPreference = callback; },
      removeEventListener: () => {},
    }));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  function render({ streaming = true, expanded = true, seven = false, content = false,
    priority = false, error = false, identity = 'thought', parentClosing = false, burst = false, hidden = false } = {}) {
    act(() => root.render(<div {...{ inert: parentClosing ? '' : undefined }}>
      <ThinkingBlock label={streaming ? 'Thinking' : 'Thought 100 characters'} expanded={expanded}
        visuallyStreaming={streaming} streamingExpanded={seven} onStreamingExpandedChange={() => {}}
        coordinateContinuation handoffIdentity={identity} onContinuationReadyChange={ready}
        collapseIntoNext onOpenDetails={() => {}} hidden={hidden}>
        <p>Reasoning text</p>
      </ThinkingBlock>
      <div data-thinking-continuation="">{content && <button
        data-openbitfun-status={error ? 'error' : undefined}
        data-thinking-handoff-priority={priority ? 'immediate' : undefined}>Real execution state</button>}</div>
      {burst && <div data-thinking-continuation=""><p>Second output</p></div>}
    </div>));
  }
  function transition(selector: string, property: string) {
    let finish!: () => void;
    let cancel!: () => void;
    const finished = new Promise<void>((resolve, reject) => {
      finish = resolve; cancel = () => reject(new Error('cancelled'));
    });
    Object.defineProperty(host.querySelector(selector), 'getAnimations', {
      configurable: true, value: () => [{ transitionProperty: property, finished }],
    });
    return { finish, cancel };
  }

  it.each([false, true])('keeps the successor mounted but unpresented until fade/fold complete (seven: %s)', async seven => {
    render({ seven }); nextFrame();
    const thinkingToggle = host.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;
    act(() => thinkingToggle.focus());
    const fade = transition('.thinking-collapsed-header', 'opacity');
    const fold = transition('.thinking-expand-container', seven ? 'grid-template-rows' : 'opacity');
    render({ seven, content: true });
    const card = successor();
    const button = card.querySelector('button');
    expect(card.dataset.thinkingSuccessor).toBe('held');
    expect(card.hasAttribute('inert')).toBe(true);
    expect(card.getAttribute('aria-hidden')).toBe('true');
    expect(panel().dataset.thinkingExchange).toBe('holding');
    expect(ready).toHaveBeenLastCalledWith(true, false, true);
    render({ seven, content: true, streaming: false, expanded: false });
    expect(panel().dataset.thinkingExchange).toBe('closing');
    expect(panel().dataset.thinkingViewport).toBe(seven ? 'expanded' : 'compact');
    await act(async () => fade.finish());
    expect(card.dataset.thinkingSuccessor).toBe('held');
    await act(async () => fold.finish());
    expect(panel().dataset.thinkingExchange).toBe('released');
    expect(card.hasAttribute('inert')).toBe(false);
    expect(card.hasAttribute('aria-hidden')).toBe(false);
    expect(card.hasAttribute('data-thinking-successor')).toBe(false);
    expect(successor().querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(thinkingToggle);
  });

  it('holds the completed row for output arriving after the stream ended', async () => {
    render(); nextFrame();
    render({ streaming: false, expanded: false });
    const fade = transition('.thinking-collapsed-header', 'opacity');
    render({ streaming: false, expanded: false, content: true });
    expect(panel().dataset.thinkingExchange).toBe('closing');
    expect(successor().dataset.thinkingSuccessor).toBe('held');
    await act(async () => fade.finish());
    expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
  });

  it.each(['history', 'live remount', 'first paint', 'reduced', 'hidden', 'parent closing', 'priority'])(
    'does not queue motion for %s', reason => {
      if (!['history', 'live remount'].includes(reason)) {
        render(); if (reason !== 'first paint') nextFrame();
      }
      reduced = reason === 'reduced';
      render({ streaming: reason !== 'history', expanded: reason !== 'history', content: true,
        hidden: reason === 'hidden', parentClosing: reason === 'parent closing', priority: reason === 'priority' });
      expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
      expect(successor().hasAttribute('inert')).toBe(false);
    },
  );

  it.each(['priority', 'error', 'preference', 'burst'])('releases an ongoing handoff immediately for %s', async reason => {
    render(); nextFrame();
    const fade = transition('.thinking-collapsed-header', 'opacity');
    render({ content: true, streaming: false, expanded: false });
    expect(successor().dataset.thinkingSuccessor).toBe('held');
    if (reason === 'preference') act(() => { reduced = true; onPreference?.(); });
    else render({ content: true, streaming: false, expanded: false, priority: reason === 'priority', error: reason === 'error', burst: reason === 'burst' });
    expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
    expect(ready).toHaveBeenLastCalledWith(true, true, false);
    await act(async () => fade.finish());
    expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
  });

  it.each(['identity', 'removal', 'cancel'])('cleans up an interrupted handoff: %s', async reason => {
    render(); nextFrame();
    const fade = transition('.thinking-collapsed-header', 'opacity');
    render({ content: true, streaming: false, expanded: false });
    const card = successor();
    if (reason === 'identity') render({ identity: 'another-attempt', content: true });
    else if (reason === 'removal') render();
    await act(async () => fade.cancel());
    expect(card.hasAttribute('inert')).toBe(false);
    expect(card.hasAttribute('data-thinking-successor')).toBe(false);
    if (reason !== 'cancel') expect(panel().dataset.thinkingExchange).toBeUndefined();
  });

  it('lets a closing parent release held content without starting another inner fold', async () => {
    render({ seven: true }); nextFrame();
    render({ seven: true, content: true });
    expect(successor().dataset.thinkingSuccessor).toBe('held');
    // Change only the ancestor, as a memoized collection member would see it.
    await act(async () => host.firstElementChild!.setAttribute('inert', ''));
    expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
    expect(panel().dataset.thinkingExchange).toBeUndefined();
    expect(panel().dataset.expanded).toBe('true');
  });

  it('ignores an old fold completion when live reading resumes', async () => {
    render({ seven: true }); nextFrame();
    const oldFade = transition('.thinking-collapsed-header', 'opacity');
    render({ seven: true, content: true, streaming: false, expanded: false });
    render({ seven: true, content: true });
    await act(async () => oldFade.finish());
    expect(panel().dataset.thinkingExchange).toBe('holding');
    expect(successor().dataset.thinkingSuccessor).toBe('held');
    const newFade = transition('.thinking-collapsed-header', 'opacity');
    render({ seven: true, content: true, streaming: false, expanded: false });
    await act(async () => newFade.finish());
    expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
  });

  it('coordinates a peer continuation without moving either DOM node between virtual rows', async () => {
    const resolver = () => ({ element: host.querySelector<HTMLElement>('[data-thinking-continuation]'), observeRoot: host });
    const rows = (content: boolean, streaming: boolean) => <>
      <div data-row="first"><ThinkingBlock label="Thinking" expanded={streaming} visuallyStreaming={streaming}
        coordinateContinuation handoffIdentity="cross-round" resolveContinuation={resolver} onContinuationReadyChange={ready}
        collapseIntoNext onOpenDetails={() => {}}><p>Reasoning</p></ThinkingBlock></div>
      <div data-row="second"><div data-thinking-continuation="">{content && <p>Next round</p>}</div></div>
    </>;
    act(() => root.render(rows(false, true))); nextFrame();
    const thinking = panel();
    const fade = transition('.thinking-collapsed-header', 'opacity');
    act(() => root.render(rows(true, false)));
    // An observed peer may be materialized in a separate subtree commit.
    await act(async () => {});
    expect(successor().dataset.thinkingSuccessor).toBe('held');
    await act(async () => fade.finish());
    expect(successor().hasAttribute('data-thinking-successor')).toBe(false);
    expect(panel()).toBe(thinking);
    expect(panel().parentElement?.dataset.row).toBe('first');
    expect(successor().parentElement?.dataset.row).toBe('second');
  });
});
