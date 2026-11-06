// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ cols: 100, rows: 30, terminal: null as any }));
const noop = () => ({ dispose() {} });
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(function () {
  const terminal = new Proxy({
    cols: 80, rows: 24, options: {},
    buffer: { normal: { length: 1000 }, active: { type: 'normal', length: 1000, viewportY: 0,
      getLine: () => ({ translateToString: () => 'retained output' }) } },
    open(container: HTMLElement) { container.append(document.createElement('textarea')); },
    resize(cols: number, rows: number) { terminal.cols = cols; terminal.rows = rows; },
  } as any, { get: (target, property) => property in target ? target[property] : noop });
  fixture.terminal = terminal;
  return terminal;
}) }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () {
  return { proposeDimensions: () => ({ cols: fixture.cols, rows: fixture.rows }), dispose() {} };
}) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(function () { return { onContextLoss: noop, dispose() {} }; }) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function () { return { dispose() {} }; }) }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@/infrastructure/appearance/adapters/XtermAppearanceAdapter', () => ({ xtermAppearanceAdapter: {
  getColors: () => ({}), subscribe: () => () => {}, onChange: () => () => {},
} }));

import Terminal, { type TerminalRef } from './Terminal';

describe('terminal geometry across interrupted pane resizing', () => {
  let root: Root, container: HTMLDivElement;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    fixture.cols = 100; fixture.rows = 30;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    class Observer { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal('ResizeObserver', Observer); vi.stubGlobal('IntersectionObserver', Observer);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); frames.clear();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  const frame = () => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now()));
  });

  it.each(['backend-timeout', 'queued-resume'] as const)
  ('resynchronizes the PTY after an accepted local size is interrupted by %s', interruption => {
    const onResize = vi.fn();
    const ref = createRef<TerminalRef>();
    const render = (suspended: boolean) => act(() => root.render(
      <Terminal ref={ref} resizeSuspended={suspended} onResize={onResize} />));
    render(false); frame();
    act(() => vi.advanceTimersByTime(50));
    expect(onResize).toHaveBeenLastCalledWith(100, 30);
    onResize.mockClear();

    fixture.cols = 90;
    act(() => { ref.current!.fit(); vi.advanceTimersByTime(100); });
    expect(fixture.terminal.cols).toBe(90);
    expect(onResize).not.toHaveBeenCalled();
    render(true);
    if (interruption === 'backend-timeout') {
      act(() => vi.advanceTimersByTime(50));
    } else {
      // A pending resume RAF must not lose work if a second drag starts first.
      render(false); render(true); frame();
    }
    expect(onResize).not.toHaveBeenCalled();

    render(false); frame();
    act(() => vi.advanceTimersByTime(150));
    expect(fixture.terminal.cols).toBe(90);
    expect(onResize.mock.calls).toEqual([[90, 30]]);
    act(() => ref.current!.fit());
    act(() => vi.advanceTimersByTime(150));
    expect(onResize.mock.calls).toEqual([[90, 30]]);
  });
});
