/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MiniAppAgentBridge } from './miniAppAgentBridge';
import {
  MINIAPP_AGENT_BRIDGE_READY_TYPE,
  MINIAPP_AGENT_BRIDGE_RESPONSE_TYPE,
  MINIAPP_AGENT_SCHEMA_VERSION,
  MiniAppAgentSurfaceError,
} from './miniAppAgentProtocol';

function createBridge() {
  const posts: Record<string, unknown>[] = [];
  const contentWindow = {
    postMessage: (payload: Record<string, unknown>) => posts.push(payload),
  } as unknown as Window;
  const iframe = { contentWindow } as unknown as HTMLIFrameElement;
  const bridge = new MiniAppAgentBridge({ appId: 'demo', iframe });
  bridge.start();
  return { bridge, contentWindow, posts };
}

function announce(source: unknown, data: Record<string, unknown>) {
  const event = new MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: source });
  window.dispatchEvent(event);
}

function respond(source: unknown, data: Record<string, unknown>) {
  announce(source, { type: MINIAPP_AGENT_BRIDGE_RESPONSE_TYPE, ...data });
}

function ready(capabilities: string[] = ['observe', 'act'], appId = 'demo') {
  return {
    type: MINIAPP_AGENT_BRIDGE_READY_TYPE,
    appId,
    schemaVersion: MINIAPP_AGENT_SCHEMA_VERSION,
    capabilities,
  };
}

async function rejection(promise: Promise<unknown>): Promise<MiniAppAgentSurfaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MiniAppAgentSurfaceError);
    return error as MiniAppAgentSurfaceError;
  }
  throw new Error('expected the bridge call to fail');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MiniApp agent bridge', () => {
  it('only accepts an announcement from its own frame and app', async () => {
    const { bridge, contentWindow } = createBridge();
    announce({}, ready()); // a different source
    announce(contentWindow, ready(['observe'], 'someone-else'));
    expect(bridge.announced).toBe(false);

    announce(contentWindow, ready([' Observe ', 'observe', 'ACT', 'not ascii ✓']));
    expect(bridge.announced).toBe(true);
    expect(bridge.capabilities).toEqual(['observe', 'act']);
  });

  it('rejects an unknown schema version instead of guessing capabilities', () => {
    const { bridge, contentWindow } = createBridge();
    announce(contentWindow, { ...ready(), schemaVersion: 'agent.v0' });
    expect(bridge.announced).toBe(false);
    expect(bridge.capabilities).toEqual([]);
  });

  it('pairs a response by requestId and forwards the action payload', async () => {
    const { bridge, contentWindow, posts } = createBridge();
    announce(contentWindow, ready());
    const pending = bridge.act('req-1', { type: 'restart' });
    expect(posts[0]).toMatchObject({
      requestId: 'req-1',
      method: 'act',
      schemaVersion: MINIAPP_AGENT_SCHEMA_VERSION,
      action: { type: 'restart' },
    });

    respond(contentWindow, { requestId: 'req-1', ok: true, value: { running: true } });
    await expect(pending).resolves.toEqual({
      result: { running: true },
      capabilities: ['observe', 'act'],
      actions: [],
    });
  });

  it('rejects oversized UTF-8 and non-JSON responses without losing the next request', async () => {
    const { bridge, contentWindow } = createBridge();
    announce(contentWindow, ready());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of ['x'.repeat(33 * 1024), '界'.repeat(12 * 1024), cyclic]) {
      const pending = bridge.observe('oversized');
      respond(contentWindow, { requestId: 'oversized', ok: true, value });
      expect((await rejection(pending)).code).toBe('BRIDGE_REJECTED');
    }
    const next = bridge.observe('next');
    respond(contentWindow, { requestId: 'next', ok: true, value: { state: { count: 1 } } });
    await expect(next).resolves.toMatchObject({ state: { count: 1 } });
    bridge.stop();
  });

  it('applies the byte bound to outgoing multibyte actions as well', async () => {
    const { bridge, contentWindow, posts } = createBridge();
    announce(contentWindow, ready());
    expect((await rejection(bridge.act('large', { type: 'write', text: '界'.repeat(12 * 1024) }))).code)
      .toBe('INVALID_PARAMS');
    expect(posts).toHaveLength(0);
    bridge.stop();
  });

  it('fails loudly when the app declares no bridge or lacks the capability', async () => {
    const { bridge, contentWindow } = createBridge();
    expect((await rejection(bridge.observe('req-1'))).code).toBe('BRIDGE_UNAVAILABLE');

    announce(contentWindow, ready(['observe']));
    expect((await rejection(bridge.act('req-2', { type: 'restart' }))).code).toBe('BRIDGE_UNAVAILABLE');
  });

  it('observes an app that declares nothing, through automatic observation', async () => {
    const { bridge, contentWindow } = createBridge();
    // The injected runtime always announces auto-observe, so an untouched app is
    // observable without editing its source.
    announce(contentWindow, ready(['auto-observe']));
    const pending = bridge.observe('req-1');
    respond(contentWindow, {
      requestId: 'req-1',
      ok: true,
      value: { state: null, auto: { source: 'auto', canvasText: [{ text: 'SCORE 1200' }], frames: 9 } },
    });

    await expect(pending).resolves.toEqual({
      state: null,
      auto: { source: 'auto', canvasText: [{ text: 'SCORE 1200' }], frames: 9 },
      capabilities: ['auto-observe'],
      actions: [],
    });
    // Automatic observation never implies semantic actions.
    expect((await rejection(bridge.act('req-2', { type: 'restart' }))).code).toBe('BRIDGE_UNAVAILABLE');
  });

  it('reports the action vocabulary the app declared, case preserved', async () => {
    const { bridge, contentWindow } = createBridge();
    announce(contentWindow, {
      ...ready(['observe', 'act']),
      // Apps name their own actions, so cased names must survive; malformed,
      // duplicate and over-long entries are dropped instead of forwarded.
      actions: [' start ', 'Autoplay', 'start', 42, { type: 'pause' }, 'x'.repeat(60), 'не ascii'],
    });
    expect(bridge.actions).toEqual(['start', 'Autoplay', 'pause']);

    const pending = bridge.act('req-1', { type: 'autoplay', maxSteps: 200 });
    respond(contentWindow, { requestId: 'req-1', ok: true, value: { running: true } });
    await expect(pending).resolves.toEqual({
      result: { running: true },
      capabilities: ['observe', 'act'],
      actions: ['start', 'Autoplay', 'pause'],
    });

    // An app that declares nothing reports an empty list, which means unknown
    // rather than "accepts nothing".
    const fresh = createBridge();
    announce(fresh.contentWindow, ready(['observe', 'act']));
    expect(fresh.bridge.actions).toEqual([]);
  });

  it('keeps declared state authoritative while still reporting automatic observation', async () => {
    const { bridge, contentWindow } = createBridge();
    announce(contentWindow, ready(['auto-observe', 'observe', 'act']));
    const pending = bridge.observe('req-1');
    respond(contentWindow, {
      requestId: 'req-1',
      ok: true,
      value: { state: { score: 1300 }, auto: { source: 'declared', frames: 4 } },
    });

    await expect(pending).resolves.toMatchObject({
      state: { score: 1300 },
      auto: { source: 'declared' },
    });
  });

  it('times out instead of waiting forever, and surfaces app rejections', async () => {
    const { bridge, contentWindow } = createBridge();
    announce(contentWindow, ready());
    expect((await rejection(bridge.observe('req-1', 5))).code).toBe('BRIDGE_TIMEOUT');

    const rejected = bridge.observe('req-2');
    respond(contentWindow, { requestId: 'req-2', ok: false, error: 'the game is paused' });
    const error = await rejection(rejected);
    expect(error.code).toBe('BRIDGE_REJECTED');
    expect(error.message).toContain('the game is paused');
  });

  it('rejects pending calls when the surface detaches', async () => {
    const { bridge, contentWindow } = createBridge();
    announce(contentWindow, ready());
    const pending = bridge.observe('req-1');
    bridge.stop();
    expect((await rejection(pending)).code).toBe('SURFACE_UNAVAILABLE');
  });
});
