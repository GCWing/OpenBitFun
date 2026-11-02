/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import keyContract from '../../../../../../shared/miniapp-agent/keys.json';
import { pressKey } from './miniAppAgentDomRuntime';

// Execute the actual injected template, expanding only Rust format! parameters.
// This catches runtime behavior that Rust's string-presence checks cannot test.
const builder = readFileSync(resolve(process.cwd(), '../crates/contracts/product-domains/src/miniapp/bridge_builder.rs'), 'utf8');
const template = builder.split('r#"')[1].split('"#,')[0];
const values: Record<string, string> = {
  app_id_esc: '"demo"', app_data_esc: '"/data"', workspace_esc: '"/workspace"',
  appearance_mode_esc: '"light"', platform_esc: '"macos"',
  agent_key_contract: JSON.stringify(keyContract),
};
const script = template.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string) => {
  if (match === '{{') return '{';
  if (match === '}}') return '}';
  if (!(name in values)) throw new Error(`Unknown bridge template parameter: ${name}`);
  return values[name];
});

function runtime() {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const win = iframe.contentWindow!;
  const doc = iframe.contentDocument!;
  const replies = vi.spyOn(win.parent, 'postMessage').mockImplementation(() => {});
  class CanvasContext {
    text = '';
    fillText(text: string) { this.text = text; }
    strokeText(text: string) { this.text = text; }
    clearRect() { this.text = ''; }
  }
  const originalDraw = CanvasContext.prototype.fillText;
  new Function('window', 'document', 'KeyboardEvent', 'CanvasRenderingContext2D', script)(
    win, doc, win.KeyboardEvent, CanvasContext,
  );
  const app = (win as unknown as { app: { agent: { expose: (handlers: unknown) => void } } }).app;
  let next = 0;
  const request = (method: string, action?: unknown, source: Window = win.parent, schemaVersion: unknown = 'agent.v1') => {
    const requestId = `test-${++next}`;
    win.dispatchEvent(new win.MessageEvent('message', {
      source, data: { type: 'openbitfun:miniapp-agent-request', requestId, schemaVersion, method, action },
    }));
    return requestId;
  };
  const answer = (id: string) => replies.mock.calls.map(([data]) => data).find(data => data.requestId === id);
  return { iframe, win, doc, app, request, answer, CanvasContext, originalDraw };
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('injected MiniApp Agent runtime', () => {
  it('only accepts the parent window and the supported schema before invoking handlers or input', async () => {
    const rt = runtime();
    const observe = vi.fn(() => ({ count: 1 }));
    const act = vi.fn(() => ({ changed: true }));
    const input = vi.fn();
    rt.app.agent.expose({ observe, act });
    rt.doc.addEventListener('keydown', input);
    for (const method of ['observe', 'act', 'input']) {
      const forged = rt.request(method, { type: 'delete', key: 'w' }, rt.win);
      expect(rt.answer(forged)).toBeUndefined();
      for (const version of ['agent.v2', null]) {
        const unsupported = rt.request(method, { type: 'delete', key: 'w' }, rt.win.parent, version);
        expect(rt.answer(unsupported)).toMatchObject({ ok: false, error: 'Unsupported agent bridge schema version' });
      }
    }
    await flush();
    expect(observe).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    const accepted = rt.request('act', { type: 'save' });
    await flush();
    expect(act).toHaveBeenCalledExactlyOnceWith({ type: 'save' });
    expect(rt.answer(accepted)).toMatchObject({ ok: true, value: { changed: true } });
  });

  it.each([
    ['w', 'w', 'KeyW'], ['W', 'W', 'KeyW'], ['1', '1', 'Digit1'],
    ['Space', ' ', 'Space'], [' ', ' ', 'Space'], ['Left', 'ArrowLeft', 'ArrowLeft'],
    ['Enter', 'Enter', 'Enter'], ['Alt', 'Alt', 'AltLeft'], ['control', 'control', 'ControlLeft'],
  ])('sends equivalent tab and window key events for %s', async (key, expectedKey, code) => {
    const rt = runtime();
    const events: Record<string, unknown>[] = [];
    for (const type of ['keydown', 'keypress', 'keyup']) {
      rt.doc.addEventListener(type, event => {
        const e = event as KeyboardEvent;
        events.push({ type, key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
      });
    }
    const id = rt.request('input', { key, modifiers: ['Control', 'Shift'] });
    await flush();
    expect(rt.answer(id)).toMatchObject({ ok: true });
    const windowEvents = events.splice(0);
    await pressKey({ appId: 'demo', iframe: rt.iframe }, key, { modifiers: ['Control', 'Shift'] });
    expect(events).toEqual(windowEvents);
    expect(events[0]).toMatchObject({ type: 'keydown', key: expectedKey, code, ctrlKey: true, shiftKey: true });
    expect(events.at(-1)?.type).toBe('keyup');
  });

  it('holds a window key before releasing it and completing the request', async () => {
    vi.useFakeTimers();
    const rt = runtime();
    const released = vi.fn();
    rt.doc.addEventListener('keyup', released);
    const id = rt.request('input', { key: 'w', holdMs: 50 });
    await flush();
    await vi.advanceTimersByTimeAsync(49);
    expect(released).not.toHaveBeenCalled();
    expect(rt.answer(id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toHaveBeenCalledOnce();
    expect(rt.answer(id)).toMatchObject({ ok: true });
  });

  it('does not intercept Canvas drawing or report cleared text as live state', async () => {
    const rt = runtime();
    expect(rt.CanvasContext.prototype.fillText).toBe(rt.originalDraw);
    const canvas = new rt.CanvasContext();
    canvas.fillText('Game Over');
    canvas.clearRect();
    const automatic = rt.request('observe');
    await flush();
    expect(rt.answer(automatic)).toMatchObject({
      ok: true, value: { state: null, auto: { canvasText: [], canvasTextUnavailable: true } },
    });
    expect(JSON.stringify(rt.answer(automatic))).not.toContain('Game Over');
    rt.app.agent.expose({ observe: () => ({ phase: 'playing' }) });
    const declared = rt.request('observe');
    await flush();
    expect(rt.answer(declared)).toMatchObject({ ok: true, value: { state: { phase: 'playing' } } });
  });
});
