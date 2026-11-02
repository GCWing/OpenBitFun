// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flowChatWidthStore, FLOW_CHAT_WIDTH_STORAGE_KEY } from '@/infrastructure/appearance/preferences/flowChatWidthStore';
import { FlowChatWidthBoundary } from './FlowChatWidthBoundary';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('FlowChat content-width boundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  let paneWidth: number;
  let resized: () => void;
  let resizing: ReturnType<typeof vi.fn>;
  let writes: ReturnType<typeof vi.spyOn>;
  const pane = () => host.querySelector<HTMLDivElement>('[data-testid="pane"]')!;
  const handle = (side = 'right') => host.querySelector<HTMLDivElement>(`.flow-chat-width-boundary__handle--${side}`)!;
  const renderedWidth = () => pane().style.getPropertyValue('--openbitfun-control-flow-chat-transcript-max-width');
  function Harness({ active }: { active: boolean }) {
    const paneRef = useRef<HTMLDivElement>(null);
    return <div ref={paneRef} data-testid="pane"><textarea defaultValue="draft" />
      <FlowChatWidthBoundary paneRef={paneRef} active={active} onResizingChange={resizing} />
    </div>;
  }
  const render = (active = true) => act(() => root.render(<Harness active={active} />));
  const pointer = (type: string, x: number, side = 'right', pointerId = 1) => act(() => {
    const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    handle(side).dispatchEvent(event);
  });
  const key = (value: string, side = 'right', shiftKey = false) => act(() => {
    handle(side).dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
  });
  const frame = () => act(() => vi.advanceTimersByTime(16));

  beforeEach(() => {
    paneWidth = 1200;
    resizing = vi.fn();
    flowChatWidthStore.setState({ preferredWidth: 900 });
    window.localStorage.clear();
    writes = vi.spyOn(Storage.prototype, 'setItem');
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => paneWidth);
    const captured = new WeakMap<Element, number>();
    HTMLElement.prototype.setPointerCapture = vi.fn(function (this: HTMLElement, id: number) { captured.set(this, id); });
    HTMLElement.prototype.hasPointerCapture = vi.fn(function (this: HTMLElement, id: number) { return captured.get(this) === id; });
    HTMLElement.prototype.releasePointerCapture = vi.fn(function (this: HTMLElement) { captured.delete(this); });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount()); host.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  });

  it.each(['left', 'right'])('resizes symmetrically from the %s edge and persists only on release', side => {
    render();
    expect(renderedWidth()).toBe('900px');
    const draft = host.querySelector('textarea');
    pointer('pointerdown', 500, side);
    pointer('pointermove', side === 'left' ? 400 : 600, side); frame();
    expect(renderedWidth()).toBe('1100px');
    expect(flowChatWidthStore.getState().preferredWidth).toBe(900);
    expect(writes).not.toHaveBeenCalled();
    pointer('pointerup', side === 'left' ? 400 : 600, side);
    expect(flowChatWidthStore.getState().preferredWidth).toBe(1100);
    expect(writes).toHaveBeenLastCalledWith(FLOW_CHAT_WIDTH_STORAGE_KEY, '1100');
    expect(resizing.mock.calls).toEqual([[true], [false]]);
    expect(host.querySelector('textarea')).toBe(draft);
    expect(document.body.style.cursor).toBe('');
  });

  it('enforces the minimum and the token-derived pane gap, including a pending final frame', () => {
    render();
    expect(handle().getAttribute('aria-valuemax')).toBe('1116');
    pointer('pointerdown', 0); pointer('pointermove', 1000); pointer('pointerup', 1000);
    expect(renderedWidth()).toBe('1116px');
    pointer('pointerdown', 1000); pointer('pointermove', 0); frame(); pointer('pointerup', 0);
    expect(renderedWidth()).toBe('600px');
  });

  it('clamps each pane without overwriting a wider remembered preference', () => {
    act(() => flowChatWidthStore.getState().setPreferredWidth(1400));
    render();
    expect(renderedWidth()).toBe('1116px');
    paneWidth = 550; act(() => resized());
    expect(renderedWidth()).toBe('466px');
    expect(host.querySelector<HTMLElement>('.flow-chat-width-boundary')!.hidden).toBe(true);
    expect(flowChatWidthStore.getState().preferredWidth).toBe(1400);
    paneWidth = 1700; act(() => resized());
    expect(renderedWidth()).toBe('1400px');
    pointer('pointerdown', 0); pointer('pointerup', 0);
    expect(flowChatWidthStore.getState().preferredWidth).toBe(1400);
  });

  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'inactive', 'resize', 'setting', 'unmount'])('cancels on %s and restores the saved width and host styles', reason => {
    document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text';
    render(); pointer('pointerdown', 0); pointer('pointermove', 80); frame();
    expect(renderedWidth()).toBe('1060px');
    if (reason === 'Escape') key('Escape');
    else if (reason === 'blur') act(() => window.dispatchEvent(new Event('blur')));
    else if (reason === 'inactive') render(false);
    else if (reason === 'resize') { paneWidth = 1300; act(() => resized()); }
    else if (reason === 'setting') act(() => flowChatWidthStore.getState().setPreferredWidth(800));
    else if (reason === 'unmount') act(() => root.render(null));
    else pointer(reason, 80);
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    expect(flowChatWidthStore.getState().preferredWidth).toBe(reason === 'setting' ? 800 : 900);
    if (reason !== 'unmount') expect(renderedWidth()).toBe(reason === 'setting' ? '800px' : '900px');
    expect(resizing).toHaveBeenLastCalledWith(false);
  });

  it('ignores unrelated pointers and supports physical arrows, Shift, Home/End and reset', () => {
    render(); pointer('pointerdown', 0); pointer('pointermove', 100, 'right', 2); pointer('pointerup', 100, 'right', 2); frame();
    expect(renderedWidth()).toBe('900px');
    key('Escape');
    key('ArrowLeft', 'left'); expect(renderedWidth()).toBe('910px');
    key('ArrowLeft', 'right', true); expect(renderedWidth()).toBe('860px');
    key('Home'); expect(renderedWidth()).toBe('600px');
    key('End'); expect(renderedWidth()).toBe('1116px');
    act(() => handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(renderedWidth()).toBe('900px');
  });
});
