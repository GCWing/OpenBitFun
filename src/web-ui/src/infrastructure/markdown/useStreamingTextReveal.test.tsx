// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
const cleanups: (() => void)[] = [];
function render(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  let mounted = true;
  const unmount = () => { if (mounted) { act(() => root.unmount()); container.remove(); mounted = false; } };
  cleanups.push(unmount);
  return { container, rerender: (next: React.ReactNode) => act(() => root.render(next)), unmount };
}
function cleanup() { cleanups.splice(0).forEach(fn => fn()); }
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAMING_TEXT_REVEAL_MS, useStreamingTextReveal } from './useStreamingTextReveal';

function Fixture({ text, streaming = true, enabled = true }: { text: string; streaming?: boolean; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useStreamingTextReveal(ref, text, streaming, enabled);
  return <div ref={ref}><p>{text}</p><button>Copy</button></div>;
}
let highlights: Map<string, Set<Range>>;
const visibleRanges = () => [...highlights.values()].flatMap(value => [...value]).map(range => range.toString());
beforeEach(() => {
  vi.useFakeTimers();
  highlights = new Map();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', Set);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('streaming text arrival paint', () => {
  it('skips DOM scanning while disabled and clears active paint without replay on re-enable', () => {
    const scan = vi.spyOn(document, 'createTreeWalker');
    try {
      const view = render(<Fixture text="A" enabled={false} />);
      view.rerender(<Fixture text="AB" enabled={false} />);
      expect(scan).not.toHaveBeenCalled();
      expect(visibleRanges()).toEqual([]);
      view.rerender(<Fixture text="AB" />);
      expect(visibleRanges()).toEqual([]);
      view.rerender(<Fixture text="ABC" />);
      expect(visibleRanges()).toEqual(['C']);
      scan.mockClear();
      view.rerender(<Fixture text="ABCD" enabled={false} />);
      expect(scan).not.toHaveBeenCalled();
      expect(highlights.size).toBe(0);
      expect(view.container.querySelector('[data-stream-reveal-active]')).toBeNull();
      view.rerender(<Fixture text="ABCDE" />);
      expect(visibleRanges()).toEqual([]);
      view.rerender(<Fixture text="ABCDEF" />);
      expect(visibleRanges()).toEqual(['F']);
    } finally {
      scan.mockRestore();
    }
  });

  it('fades only appended glyphs without replacing text nodes or wrapping spans', () => {
    const view = render(<Fixture text="Already here" />);
    const textNode = view.container.querySelector('p')!.firstChild;
    expect(visibleRanges()).toEqual([]);
    view.rerender(<Fixture text="Already here 新文字👨‍👩‍👧‍👦" />);
    expect(visibleRanges()).toEqual([' 新文字👨‍👩‍👧‍👦']);
    expect(view.container.querySelector('p')!.firstChild).toBe(textNode);
    expect(view.container.querySelector('span')).toBeNull();
    expect(visibleRanges().join('')).not.toContain('Copy');
    expect(view.container.querySelectorAll('[data-stream-reveal-active]')).toHaveLength(1);
    expect(view.container.querySelector('p')!.hasAttribute('data-stream-reveal-active')).toBe(true);
    act(() => vi.advanceTimersByTime(STREAMING_TEXT_REVEAL_MS + 20));
    expect(visibleRanges()).toEqual([]);
    expect(highlights.size).toBe(0);
    expect(view.container.querySelector('[data-stream-reveal-active]')).toBeNull();
  });
  it('does not restart earlier arrivals when another batch arrives or the stream completes', () => {
    const view = render(<Fixture text="A" />);
    view.rerender(<Fixture text="AB" />);
    act(() => vi.advanceTimersByTime(96));
    view.rerender(<Fixture text="ABC" />);
    expect(visibleRanges().sort()).toEqual(['B', 'C']);
    view.rerender(<Fixture text="ABC" streaming={false} />);
    expect(view.container.querySelector('p')!.hasAttribute('data-stream-reveal-active')).toBe(true);
    act(() => vi.advanceTimersByTime(80));
    expect(visibleRanges()).toEqual(['C']);
    act(() => vi.advanceTimersByTime(100));
    expect(visibleRanges()).toEqual([]);
  });
  it('settles history, remounts and replacements immediately', () => {
    const view = render(<Fixture text="History" streaming={false} />);
    view.rerender(<Fixture text="History extended" streaming={false} />);
    expect(visibleRanges()).toEqual([]);
    view.rerender(<Fixture text="Different response" />);
    expect(visibleRanges()).toEqual([]);
    view.unmount();
    render(<Fixture text="Already streaming on remount" />);
    expect(visibleRanges()).toEqual([]);
  });
  it('keeps parallel renderer ownership independent and releases ranges on unmount', () => {
    const first = render(<Fixture text="A" />);
    const second = render(<Fixture text="X" />);
    first.rerender(<Fixture text="AB" />);
    second.rerender(<Fixture text="XY" />);
    expect(visibleRanges()).toEqual(['B', 'Y']);
    first.unmount();
    expect(visibleRanges()).toEqual(['Y']);
    expect(second.container.querySelector('p')!.hasAttribute('data-stream-reveal-active')).toBe(true);
    second.unmount();
    expect(visibleRanges()).toEqual([]);
    expect(highlights.size).toBe(0);
  });
  it('honors reduced motion and works without the highlight API', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const view = render(<Fixture text="A" />);
    view.rerender(<Fixture text="AB" />);
    expect(visibleRanges()).toEqual([]);
    vi.stubGlobal('CSS', {});
    view.rerender(<Fixture text="ABC" />);
    expect(view.container.textContent).toBe('ABCCopy');
  });

  it('retains the parent marker across frames and new arrivals, removing it only on settlement', () => {
    const view = render(<Fixture text="A" />);
    const parent = view.container.querySelector('p')!;
    const add = vi.spyOn(parent, 'setAttribute');
    const remove = vi.spyOn(parent, 'removeAttribute');
    view.rerender(<Fixture text="AB" />);
    act(() => vi.advanceTimersByTime(80));
    view.rerender(<Fixture text="ABC" />);
    act(() => vi.advanceTimersByTime(96));
    expect(add.mock.calls.filter(([name]) => name === 'data-stream-reveal-active')).toHaveLength(1);
    expect(remove.mock.calls.filter(([name]) => name === 'data-stream-reveal-active')).toHaveLength(0);
    act(() => vi.advanceTimersByTime(100));
    expect(remove.mock.calls.filter(([name]) => name === 'data-stream-reveal-active')).toHaveLength(1);
    expect(highlights.size).toBe(0);
  });

  it('scopes rich text to its actual parents and cleans detached parents on replacement', () => {
    function Rich({ suffix, replaced = false }: { suffix: string; replaced?: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useStreamingTextReveal(ref, replaced ? 'Replacement' : `History${suffix}`, true);
      return <div ref={ref}>{replaced ? <p>Replacement</p> : <>
        <p>History</p><p><a href="#test">{suffix}</a></p>
      </>}</div>;
    }
    const view = render(<Rich suffix="" />);
    view.rerender(<Rich suffix="New" />);
    const link = view.container.querySelector('a')!;
    expect([...view.container.querySelectorAll('[data-stream-reveal-active]')]).toEqual([link]);
    expect(visibleRanges()).toEqual(['New']);
    view.rerender(<Rich suffix="" replaced />);
    expect(link.hasAttribute('data-stream-reveal-active')).toBe(false);
    expect(view.container.querySelector('[data-stream-reveal-active]')).toBeNull();
    expect(highlights.size).toBe(0);
  });

  it('clears active paint on visibility changes without deleting unrelated highlights', () => {
    const foreign = new Set<Range>();
    highlights.set('search', foreign);
    const view = render(<Fixture text="A" />);
    view.rerender(<Fixture text="AB" />);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(view.container.querySelector('[data-stream-reveal-active]')).toBeNull();
    expect([...highlights.keys()]).toEqual(['search']);
    hidden.mockRestore();
    act(() => vi.advanceTimersByTime(200));
    expect([...highlights.keys()]).toEqual(['search']);
  });

  it('clears active paint when reduced motion becomes enabled', () => {
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = false;
    vi.stubGlobal('matchMedia', () => media);
    const view = render(<Fixture text="A" />);
    view.rerender(<Fixture text="AB" />);
    media.matches = true;
    act(() => media.dispatchEvent(new Event('change')));
    expect(highlights.size).toBe(0);
    expect(view.container.querySelector('[data-stream-reveal-active]')).toBeNull();
  });

  it('keeps a shared text-parent marker until its last renderer owner releases it', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const ref = { current: element };
    function Owner({ source }: { source: string }) {
      useStreamingTextReveal(ref, source, true);
      return null;
    }
    element.textContent = 'A';
    const view = render(<><Owner key="one" source="A" /><Owner key="two" source="A" /></>);
    try {
      element.textContent = 'AB';
      view.rerender(<><Owner key="one" source="AB" /><Owner key="two" source="AB" /></>);
      expect(visibleRanges()).toEqual(['B', 'B']);
      view.rerender(<><Owner key="two" source="AB" /></>);
      expect(visibleRanges()).toEqual(['B']);
      expect(element.hasAttribute('data-stream-reveal-active')).toBe(true);
      view.unmount();
      expect(element.hasAttribute('data-stream-reveal-active')).toBe(false);
      expect(highlights.size).toBe(0);
    } finally {
      view.unmount();
      element.remove();
    }
  });
});
