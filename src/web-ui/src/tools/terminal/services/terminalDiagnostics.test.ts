// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalDiagnostics } from './terminalDiagnostics';

const disposals: Array<() => void> = [];
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose());
  document.body.replaceChildren();
  delete globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__;
  delete globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__;
  vi.unstubAllGlobals();
});

function fixture() {
  const container = document.createElement('div');
  container.dataset.terminalId = 'terminal-a'; container.dataset.sessionId = 'session-a';
  container.append(document.createElement('canvas'));
  document.body.append(container);
  const text = ['first', 'second', 'third', 'last'];
  const getLine = vi.fn((index: number) => ({ translateToString: () => text[index] }));
  const buffer = { type: 'normal', length: 4, baseY: 2, viewportY: 0, cursorX: 4, cursorY: 1, getLine };
  const terminal = { cols: 80, rows: 2, buffer: { active: buffer } } as unknown as Terminal;
  disposals.push(attachTerminalDiagnostics(container, terminal));
  return { container, buffer, text, terminal };
}

describe('read-only terminal diagnostics', () => {
  it('does not expose or read terminal output unless tracing is explicitly enabled', () => {
    const { buffer } = fixture();
    expect(globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__).toBeUndefined();
    expect(buffer.getLine).not.toHaveBeenCalled();
  });
  it('does not retain terminal engines on hosts without weak references', () => {
    globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ = true;
    vi.stubGlobal('WeakRef', undefined);
    const { buffer } = fixture();
    expect(globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__).toBeUndefined();
    expect(buffer.getLine).not.toHaveBeenCalled();
  });
  it('reads only the current viewport and tail, with independent snapshots and current identity', () => {
    globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ = true;
    const { container, buffer, text, terminal } = fixture();
    const first = globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__!.snapshot()[0];
    expect(first).toEqual({ terminalId: 'terminal-a', sessionId: 'session-a', cols: 80, rows: 2,
      bufferType: 'normal', bufferLength: 4, baseY: 2, viewportY: 0, cursorX: 4, cursorY: 1,
      viewportLines: ['first', 'second'], tailLines: ['third', 'last'], rendererCanvases: 1 });
    expect(Object.values(first)).not.toContain(terminal);
    first.viewportLines[0] = 'changed snapshot';
    expect(text[0]).toBe('first');
    buffer.viewportY = 2; container.dataset.sessionId = 'session-b'; container.replaceChildren();
    const second = globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__!.snapshot()[0];
    expect(second.viewportLines).toEqual(['third', 'last']);
    expect(second.sessionId).toBe('session-b'); expect(second.rendererCanvases).toBe(0);
  });
  it('drops diagnostics for disposed or disconnected views', () => {
    globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ = true;
    fixture(); const detached = fixture();
    expect(globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__!.snapshot()).toHaveLength(2);
    disposals.shift()!(); detached.container.remove();
    expect(globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__!.snapshot()).toEqual([]);
    document.body.append(detached.container);
    expect(globalThis.__OPENBITFUN_TERMINAL_DIAGNOSTICS__!.snapshot()).toEqual([]);
  });
});
