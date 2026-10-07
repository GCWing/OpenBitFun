// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider, Tooltip } from '@openbitfun/ui';
import { FlowChatMetric, FlowChatTurnMetrics } from '@openbitfun/ui/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('shared tooltip visibility', () => {
  let host: HTMLDivElement;
  let root: Root;
  const popup = () => document.querySelector<HTMLElement>('[role="tooltip"]');
  const render = (children: React.ReactNode) => act(() => root.render(
    <React.StrictMode><DesignSystemProvider>{children}</DesignSystemProvider></React.StrictMode>,
  ));
  const enter = (element: Element) => act(() => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  const leave = (element: Element) => act(() => element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  const press = (element: HTMLElement) => act(() => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.click();
  });
  const advance = (ms = 500) => act(() => vi.advanceTimersByTime(ms));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    host = document.createElement('div'); document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove();
    document.querySelectorAll('[data-openbitfun-overlay-host]').forEach(element => element.remove());
    vi.unstubAllGlobals(); vi.useRealTimers();
  });

  function metrics(focusable = true) {
    render(<>
      <FlowChatTurnMetrics label="Turn metrics" tokenValue="12.8K" cacheHitRate={0.72}
        tokenDescription="Token usage" tokenDetails="Usage details"
        rateValue="68 t/s" speedLevel={3} rateDescription="Output speed" rateDetails="Speed details"
        focusable={focusable} />
      <FlowChatMetric description="Elapsed time" content="Duration details" focusable={focusable}>1m16s</FlowChatMetric>
    </>);
    return Array.from(host.querySelectorAll('button'));
  }

  it.each([[0, 'Usage details'], [1, 'Speed details'], [2, 'Duration details']] as const)(
    'opens metric %s from its content immediately, including during a pending hover', (index, content) => {
      const button = metrics()[index];
      enter(button);
      act(() => button.focus());
      expect(popup()).toBeNull();
      press(button.querySelector<HTMLElement>('span') ?? button);
      expect(popup()?.textContent).toBe(content);
      advance(1);
      expect(button.getAttribute('aria-describedby')).toBe(popup()?.id);
    },
  );

  it('pins an already hovered card, permits content clicks, and closes on another trigger click', () => {
    const button = metrics()[0];
    enter(button); advance(); advance(1);
    const card = popup();
    press(button);
    expect(popup()).toBe(card);
    leave(button);
    act(() => button.blur());
    advance();
    press(card!);
    expect(popup()).toBe(card);
    press(button);
    expect(popup()).toBeNull();
    advance();
    expect(popup()).toBeNull();
  });

  it.each(['outside', 'Escape', 'scroll'])('dismisses a clicked card with %s and cancels delayed reopening', method => {
    const button = metrics()[0];
    enter(button); press(button);
    if (method === 'outside') press(document.body);
    else if (method === 'scroll') act(() => window.dispatchEvent(new Event('scroll')));
    else act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(popup()).toBeNull();
    advance();
    expect(popup()).toBeNull();
    press(button);
    expect(popup()?.textContent).toBe('Usage details');
  });

  it.each([false, true])('nested scrolling cancels pending and visible cursor-following hints (external ref: %s)', external => {
    function Example() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const options = { content: 'Shared details', followCursor: true };
      return external ? <><button ref={triggerRef}>Details</button><Tooltip {...options} triggerRef={triggerRef} /></>
        : <Tooltip {...options}><button>Details</button></Tooltip>;
    }
    render(<Example />);
    const button = host.querySelector('button')!;
    const hover = () => external
      ? act(() => button.dispatchEvent(new MouseEvent('mouseenter')))
      : enter(button);
    hover();
    act(() => host.dispatchEvent(new Event('scroll')));
    advance();
    expect(popup()).toBeNull();
    hover(); advance(); advance(1);
    expect(popup()?.textContent).toBe('Shared details');
    act(() => host.dispatchEvent(new Event('scroll')));
    expect(popup()).toBeNull();
    advance();
    expect(popup()).toBeNull();
  });

  it('dismisses pinned cards on visual viewport scrolling', () => {
    const viewport = new EventTarget();
    vi.stubGlobal('visualViewport', viewport);
    const button = metrics()[0];
    press(button);
    act(() => viewport.dispatchEvent(new Event('scroll')));
    expect(popup()).toBeNull();
    press(button);
    expect(popup()?.textContent).toBe('Usage details');
  });

  it('switches independent metric cards and preserves ordinary hover and focus previews', () => {
    const [usage, speed, duration] = metrics();
    press(usage); press(speed);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(popup()?.textContent).toBe('Speed details');
    press(document.body);
    enter(usage); advance();
    expect(popup()?.textContent).toBe('Usage details');
    leave(usage); advance();
    expect(popup()).toBeNull();
    act(() => duration.focus()); advance();
    expect(popup()?.textContent).toBe('Duration details');
    act(() => duration.blur());
    expect(popup()).toBeNull();
  });

  it('does not open unrevealed metric controls', () => {
    for (const button of metrics(false)) {
      expect(button.disabled).toBe(true);
      press(button); enter(button); advance();
      expect(popup()).toBeNull();
    }
  });

  it.each([false, true])('supports explicit click opening without changing ordinary hints (external ref: %s)', external => {
    function Example({ openOnClick }: { openOnClick: boolean }) {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return external ? <>
        <button ref={triggerRef}>Details</button>
        <Tooltip trigger="hover-focus" triggerRef={triggerRef} openOnClick={openOnClick} content="Details card" />
      </> : <Tooltip trigger="hover-focus" openOnClick={openOnClick} content="Details card">
        <button>Details</button>
      </Tooltip>;
    }
    render(<Example openOnClick={false} />);
    const button = host.querySelector('button')!;
    if (external) act(() => button.dispatchEvent(new MouseEvent('mouseenter')));
    else enter(button);
    press(button); advance();
    expect(popup()).toBeNull();
    render(<Example openOnClick />);
    press(button);
    expect(popup()?.textContent).toBe('Details card');
    press(document.body);
    expect(popup()).toBeNull();
  });

  it.each([
    { trigger: 'hover', external: false, followCursor: false },
    { trigger: 'hover', external: true, followCursor: true },
    { trigger: 'focus', external: true, followCursor: false },
    { trigger: 'click', external: false, followCursor: false },
  ] as const)('closes $trigger cards when their anchor is clipped (external: $external, cursor: $followCursor)', ({ trigger, external, followCursor }) => {
    let notify: ((visible: boolean) => void) | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        notify = visible => callback([{
          target: host.querySelector('button')!, isIntersecting: visible,
          intersectionRatio: visible ? 0.1 : 0,
        } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe = observe;
      disconnect = disconnect;
    });
    function Example() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const options = { trigger, followCursor, content: 'Shared details' };
      return external ? <><button ref={triggerRef}>Details</button><Tooltip {...options} triggerRef={triggerRef} /></>
        : <Tooltip {...options}><button>Details</button></Tooltip>;
    }
    render(<Example />);
    expect(observe).not.toHaveBeenCalled();
    const button = host.querySelector('button')!;
    if (trigger === 'click') press(button);
    else if (trigger === 'focus') act(() => button.focus());
    else if (external) act(() => button.dispatchEvent(new MouseEvent('mouseenter')));
    else enter(button);
    advance(); advance(1);
    expect(popup()?.textContent).toBe('Shared details');
    expect(observe).toHaveBeenCalledWith(button);
    act(() => notify!(true));
    expect(popup()).not.toBeNull();
    act(() => notify!(false));
    expect(popup()).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(disconnect).toHaveBeenCalled();
    act(() => notify!(true)); advance();
    expect(popup()).toBeNull();
  });

  it('clears click persistence on viewport exit and ignores late observations after reopening', () => {
    const notifications: Array<(visible: boolean) => void> = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        notifications.push(visible => callback([{
          target: host.querySelector('button')!, isIntersecting: visible,
        } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
      }
      observe() {}
      disconnect() {}
    });
    const button = metrics()[0];
    press(button); advance(1);
    const first = notifications.at(-1)!;
    act(() => first(false));
    expect(popup()).toBeNull();
    act(() => first(true));
    expect(popup()).toBeNull();
    press(button);
    expect(popup()?.textContent).toBe('Usage details');
    act(() => first(false));
    expect(popup()?.textContent).toBe('Usage details');
  });
});
