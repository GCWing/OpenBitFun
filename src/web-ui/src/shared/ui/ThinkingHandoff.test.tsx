// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingBlock } from '@openbitfun/ui/flow-chat';

// Animation promises exercise lifecycle/identity only; they are not visual QA.
describe('thinking completion handoff', () => {
  let host: HTMLDivElement;
  let root: Root;
  let reducedMotion: boolean;
  let frames: Map<number, FrameRequestCallback>;
  const panel = () => host.querySelector<HTMLElement>('[data-testid="chat-thinking-panel"]')!;
  const button = () => host.querySelector<HTMLButtonElement>('[data-testid="chat-thinking-toggle"]')!;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    reducedMotion = false;
    frames = new Map();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function render({ expanded = false, streaming = false, label = 'Thought 20 characters',
    continuation = true, hidden = false, parentClosing = false } = {}) {
    act(() => root.render(<div {...{ inert: parentClosing ? '' : undefined }}>
      <ThinkingBlock expanded={expanded} visuallyStreaming={streaming} collapseIntoNext
        label={label} capsuleLabel="Thought 20 characters" onOpenDetails={() => {}} hidden={hidden}>
        <p>Reasoning content</p>
      </ThinkingBlock>
      <div data-thinking-continuation="">{continuation && <p>Following content</p>}</div>
    </div>));
  }

  function transition(selector: string, property: string) {
    const element = host.querySelector<HTMLElement>(selector)!;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    let settled = false;
    const finished = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const getAnimations = vi.fn(() => settled ? [] : [{ transitionProperty: property, finished }]);
    Object.defineProperty(element, 'getAnimations', { configurable: true, value: getAnimations });
    return {
      getAnimations,
      finish: () => { settled = true; resolve(); },
      cancel: () => { settled = true; reject(new Error('Transition cancelled')); },
    };
  }

  it('mounts completed history directly in its final position without replay', () => {
    render();
    expect(panel().dataset.thinkingPhase).toBe('side');
    expect(panel().dataset.thinkingAttachment).toBe('side');
    expect(panel().dataset.thinkingMotion).toBe('initial');
    const control = button();
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(16));
    });
    expect(panel().dataset.thinkingMotion).toBeUndefined();
    expect(panel().dataset.thinkingPhase).toBe('side');
    render({ label: 'Thought 24 characters' });
    expect(panel().dataset.thinkingPhase).toBe('side');
    expect(button()).toBe(control);
  });

  it.each(['min-block-size', 'min-height'])('waits for fade, fold and %s, keeping the outgoing label and native focus', async minSize => {
    render({ expanded: true, label: 'Thinking...' });
    const control = button();
    act(() => control.focus());
    const fade = transition('.thinking-collapsed-header', 'opacity');
    const slot = transition('.thinking-header-slot', 'height');
    const fold = transition('.thinking-expand-container', 'grid-template-rows');
    const row = transition('.flow-thinking-item', minSize);
    render();
    expect(panel().dataset.thinkingPhase).toBe('leaving');
    expect(panel().dataset.thinkingAttachment).toBe('side');
    expect(host.querySelector('.thinking-label')?.textContent).toBe('Thinking...');

    render({ label: 'Thought 24 characters' });
    await act(async () => { fade.finish(); slot.finish(); });
    expect(panel().dataset.thinkingPhase).toBe('leaving');
    expect(host.querySelector('.thinking-label')?.textContent).toBe('Thinking...');
    await act(async () => fold.finish());
    expect(panel().dataset.thinkingPhase).toBe('leaving');
    await act(async () => row.finish());
    expect(panel().dataset.thinkingPhase).toBe('side');
    expect(button()).toBe(control);
    expect(document.activeElement).toBe(control);
  });

  it('reverses an unfinished close and ignores the superseded completion', async () => {
    render({ expanded: true });
    const oldFade = transition('.thinking-collapsed-header', 'opacity');
    const oldFold = transition('.thinking-expand-container', 'grid-template-rows');
    render();
    const returnFade = transition('.thinking-collapsed-header', 'opacity');
    render({ expanded: true, streaming: true, label: 'Thinking...' });
    await act(async () => { oldFade.finish(); oldFold.cancel(); });
    expect(panel().dataset.thinkingPhase).toBe('leaving');
    expect(panel().dataset.thinkingAttachment).toBe('block');
    await act(async () => returnFade.finish());
    expect(panel().dataset.thinkingPhase).toBe('block');
    expect(host.querySelector('.thinking-label')?.textContent).toBe('Thinking...');
  });

  it('retains the side anchor while fading out to resume reasoning', async () => {
    render();
    const control = button();
    const header = host.querySelector<HTMLElement>('.thinking-collapsed-header')!;
    header.style.insetBlockStart = '90px';
    panel().style.setProperty('--_thinking-continuation-center', '101px');
    const fade = transition('.thinking-collapsed-header', 'opacity');
    render({ expanded: true, streaming: true });
    expect(panel().dataset.thinkingPhase).toBe('leaving');
    expect(panel().dataset.thinkingOrigin).toBe('side');
    expect(panel().style.getPropertyValue('--_thinking-handoff-top')).toBe('90px');
    await act(async () => fade.finish());
    expect(panel().dataset.thinkingPhase).toBe('block');
    expect(panel().style.getPropertyValue('--_thinking-handoff-top')).toBe('');
    expect(button()).toBe(control);
  });

  it('waits for an empty successor to receive content before handing off', async () => {
    render({ continuation: false });
    expect(panel().dataset.thinkingAttachment).toBe('block');
    expect(panel().dataset.thinkingPhase).toBe('block');
    const fade = transition('.thinking-collapsed-header', 'opacity');
    await act(async () => render());
    expect(panel().dataset.thinkingPhase).toBe('leaving');
    await act(async () => fade.finish());
    expect(panel().dataset.thinkingPhase).toBe('side');
  });

  it('keeps a completion before the first paint instant', () => {
    render({ expanded: true, streaming: true });
    render();
    expect(panel().dataset.thinkingMotion).toBe('initial');
    expect(panel().dataset.thinkingPhase).toBe('side');
  });

  it.each(['reduced motion', 'hidden', 'parent closing'] as const)('settles immediately for %s', reason => {
    render({ expanded: true });
    const fade = transition('.thinking-collapsed-header', 'opacity');
    reducedMotion = reason === 'reduced motion';
    render({ hidden: reason === 'hidden', parentClosing: reason === 'parent closing' });
    expect(panel().dataset.thinkingPhase).toBe('side');
    expect(fade.getAnimations).not.toHaveBeenCalled();
  });

  it('settles a cancelled transition without leaving the control stranded', async () => {
    render({ expanded: true });
    const fade = transition('.thinking-collapsed-header', 'opacity');
    render();
    await act(async () => fade.cancel());
    expect(panel().dataset.thinkingPhase).toBe('side');
  });
});
