// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@openbitfun/ui';
import { ThinkingBlock } from '@openbitfun/ui/flow-chat';

// Supplied geometry exercises ownership and lifecycle; it is not visual proof.
describe('thinking page-margin annotation', () => {
  let host: HTMLDivElement;
  let root: Root;
  let panel: HTMLElement;
  let successor: HTMLElement;
  let button: HTMLButtonElement;
  let scroller: HTMLElement;
  let top: number;
  let height: number;
  let nested: boolean;
  let single: boolean;
  let callbacks: Map<Element, Set<() => void>>;
  let samples: string[];
  const frame = () => act(() => vi.advanceTimersByTime(20));
  const reveal = () => { act(() => vi.advanceTimersByTime(500)); frame(); };
  const popup = () => document.querySelector('[role="tooltip"]');
  const center = () => Number.parseFloat(panel.style.getPropertyValue('--_thinking-continuation-center'));
  const move = (element: Element, x: number, y = 300) => act(() => {
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  });
  const enter = (element: Element, x = 200, y = 300) => act(() => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body, clientX: x, clientY: y }));
    element.dispatchEvent(new MouseEvent('mouseenter', { clientX: x, clientY: y }));
  });
  const leave = (element: Element, to: EventTarget = document.body) => act(() => {
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));
    element.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: to }));
  });
  const resize = (element: Element) => act(() => callbacks.get(element)?.forEach(callback => callback()));
  const scroll = () => { act(() => scroller.dispatchEvent(new Event('scroll'))); frame(); };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    callbacks = new Map();
    vi.stubGlobal('ResizeObserver', class {
      private targets = new Set<Element>();
      constructor(private callback: () => void) {}
      observe(target: Element) {
        this.targets.add(target);
        if (!callbacks.has(target)) callbacks.set(target, new Set());
        callbacks.get(target)!.add(this.callback);
      }
      unobserve(target: Element) { this.targets.delete(target); callbacks.get(target)?.delete(this.callback); }
      disconnect() { this.targets.forEach(target => callbacks.get(target)?.delete(this.callback)); }
    });
    top = 100;
    height = 1000;
    nested = single = false;
    samples = [];
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => {
        samples.push(range.toString());
        const last = range.startOffset > 0;
        return new DOMRect(100, top + (single || !last ? 4 : height - 22), 8, 18);
      };
      return range;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.geometry === 'scroller') return new DOMRect(0, 100, 800, 600);
      if (this.dataset.geometry === 'nested') return new DOMRect(50, 200, 650, 260);
      if (this.hasAttribute('data-thinking-continuation')) return new DOMRect(100, top, 500, height);
      if (this.matches('.thinking-toggle')) return new DOMRect(74, top + (panel ? center() : 11) - 11, 22, 22);
      if (this.dataset.openbitfunPart === 'surface') return new DOMRect(100, top + 8, 500, 36);
      return new DOMRect(0, 0, 800, 1000);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function render(content: React.ReactNode = <p>First line and last line🙂</p>, virtualized = false) {
    const activate = vi.fn();
    act(() => root.render(<DesignSystemProvider nativeTooltipPolicy="application">
      <div data-geometry="scroller" style={{ overflowY: 'auto' }} data-openbitfun-viewport-inset-bottom="120">
        <div data-geometry={nested ? 'nested' : undefined} style={{ overflowY: nested ? 'auto' : 'visible' }}>
          <ThinkingBlock virtualized={virtualized} expanded={false} collapseIntoNext label="Thinking" capsuleLabel="Thought 24 characters" onOpenDetails={activate} />
          <div data-thinking-continuation="">{content}</div>
        </div>
      </div>
    </DesignSystemProvider>));
    panel = host.querySelector('[data-testid="chat-thinking-panel"]')!;
    successor = host.querySelector('[data-thinking-continuation]')!;
    button = host.querySelector('[data-testid="chat-thinking-toggle"]')!;
    scroller = host.querySelector('[data-geometry="scroller"]')!;
    return activate;
  }

  it('defers dormant virtual-row geometry but resolves it before keyboard interaction', () => {
    render(undefined, true);
    expect(panel.dataset.thinkingAttachment).toBe('side');
    expect(samples).toHaveLength(0);
    resize(successor);
    expect(samples).toHaveLength(0);
    act(() => button.focus());
    expect(samples.length).toBeGreaterThan(0);
    expect(Number.isFinite(center())).toBe(true);
  });

  it.each([
    { name: 'fully visible', start: 180, length: 160, expected: 80 },
    { name: 'entering', start: 400, length: 1000, expected: 90 },
    { name: 'middle', start: -300, length: 1800, expected: 640 },
    { name: 'leaving', start: -450, length: 600, expected: 575 },
  ])('centers keyboard entry in the $name portion, excluding composer occlusion', ({ start, length, expected }) => {
    top = start; height = length;
    render();
    act(() => button.focus());
    expect(center()).toBe(expected);
    expect(panel.dataset.thinkingAnnotation).toBe('text');
    expect(panel.dataset.thinkingInView).toBe('true');
    expect(successor.getAttribute('style')).toBeNull();
    expect(samples).toContain('🙂');
    expect(samples.every(sample => Array.from(sample).length === 1)).toBe(true);
  });

  it('intersects an inner group/card scrollport with the outer reader and observes chrome changes', async () => {
    nested = true; top = -100;
    render();
    enter(successor, 200, 600);
    expect(center()).toBe(430); // Inner viewport is 200..460.
    await act(async () => scroller.setAttribute('data-openbitfun-viewport-inset-bottom', '300'));
    frame();
    expect(center()).toBe(400); // Both clips: 200..400.
  });

  it('keeps single-line optical centering and expanded tool-header alignment', () => {
    single = true;
    render(<p>One line</p>);
    enter(successor);
    expect(center()).toBe(13);
    expect(panel.dataset.thinkingAnnotation).toBe('compact');
    render(<div><div data-openbitfun-component="flow-chat-tool-card" data-openbitfun-part="surface">File</div><pre>Long diff</pre></div>);
    enter(successor);
    expect(center()).toBe(26);
    expect(panel.dataset.thinkingAnnotation).toBe('compact');
  });

  it('uses text boundaries for the rail and hides when the control cannot fit', () => {
    top = -450; height = 600;
    render();
    enter(successor);
    expect(panel.style.getPropertyValue('--_thinking-text-start')).toBe('4px');
    expect(panel.style.getPropertyValue('--_thinking-text-end')).toBe('596px');
    top = -480;
    scroll();
    expect(panel.dataset.thinkingInView).toBe('false');
    top = -450;
    scroll();
    expect(panel.dataset.thinkingInView).toBe('true');
  });

  it('centers visible content independently of pointer position and preserves the text-bound rail', () => {
    top = -300; height = 1800;
    render();
    enter(successor, 200, 200);
    expect(center()).toBe(640); // Visible content is 100..580, excluding the composer.
    samples.length = 0;
    move(successor, 200, 450);
    frame();
    expect(center()).toBe(640);
    move(successor, 200, 680);
    frame();
    expect(center()).toBe(640);
    move(successor, 200, 105);
    frame();
    expect(center()).toBe(640);
    expect(samples).toHaveLength(0);
    expect(panel.style.getPropertyValue('--_thinking-text-start')).toBe('4px');
    expect(panel.style.getPropertyValue('--_thinking-text-end')).toBe('1796px');
  });

  it('centers short content and recomputes its visible midpoint on growth and scroll even in the side column', () => {
    top = 180; height = 200;
    render();
    enter(successor, 200, 280);
    expect(center()).toBe(100);
    move(successor, 90);
    height = 600;
    resize(successor);
    expect(center()).toBe(200); // Content now extends beyond the composer boundary at 580.
    move(successor, 200, 400);
    frame();
    expect(center()).toBe(200);
    move(successor, 90);
    top = -100;
    scroller.scrollTop = 280;
    scroll();
    expect(center()).toBe(400); // Remaining visible content is 100..500.
    expect(scroller.scrollTop).toBe(280);
  });

  it('keeps the full-column hover path alive, with a cancellable leave grace period', () => {
    render();
    enter(successor);
    move(successor, 90, 500);
    leave(successor, button);
    act(() => vi.advanceTimersByTime(140));
    expect(panel.dataset.thinkingActive).toBe('true');
    leave(panel);
    act(() => vi.advanceTimersByTime(119));
    expect(panel.dataset.thinkingActive).toBe('true');
    enter(panel);
    act(() => vi.advanceTimersByTime(2));
    expect(panel.dataset.thinkingActive).toBe('true');
    leave(panel);
    act(() => vi.advanceTimersByTime(120));
    expect(panel.hasAttribute('data-thinking-active')).toBe(false);
  });

  it.each([false, true])('dismisses a %s visible tooltip on scroll and requires deliberate pointer movement to reopen', visible => {
    render();
    enter(successor);
    enter(button, 84);
    move(button, 84);
    if (visible) { reveal(); expect(popup()).not.toBeNull(); }
    scroll();
    reveal();
    expect(popup()).toBeNull();
    enter(button, 84);
    move(button, 84);
    reveal();
    expect(popup()).toBeNull();
    move(button, 85);
    reveal();
    expect(popup()?.textContent).toBe('Thought 24 characters');
    leave(button);
    reveal();
    expect(popup()).toBeNull();
  });

  it('only tracks scrolling while active, coalesces measurements, and retains the same controls', () => {
    render();
    samples.length = 0;
    scroll();
    expect(samples).toHaveLength(0);
    enter(successor);
    samples.length = 0;
    act(() => { for (let i = 0; i < 4; i++) scroller.dispatchEvent(new Event('scroll')); });
    expect(samples).toHaveLength(0);
    frame();
    expect(samples).toHaveLength(2);
    expect(host.querySelector('[data-testid="chat-thinking-toggle"]')).toBe(button);
    expect(host.querySelector('[data-thinking-continuation]')).toBe(successor);
    leave(successor);
    act(() => vi.advanceTimersByTime(120));
    samples.length = 0;
    scroll();
    expect(samples).toHaveLength(0);
  });

  it('places keyboard focus in the visible content without opening a tooltip or moving the transcript', () => {
    top = -300; height = 1800;
    const activate = render();
    scroller.scrollTop = 400;
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    act(() => button.focus());
    expect(center()).toBe(640);
    expect(panel.dataset.thinkingActive).toBe('true');
    act(() => button.click());
    reveal();
    expect(activate).toHaveBeenCalledOnce();
    expect(popup()).toBeNull();
    expect(scroller.scrollTop).toBe(400);
    expect(document.activeElement).toBe(button);
    act(() => button.blur());
    expect(panel.hasAttribute('data-thinking-active')).toBe(false);
  });
});
