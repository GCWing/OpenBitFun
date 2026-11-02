import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the production injected SDK, including its request lifetime and RPC
// dispatch. Rust's format! only interpolates these five strings and braces.
const template = readFileSync(resolve(process.cwd(), '../crates/contracts/product-domains/src/miniapp/bridge_builder.rs'), 'utf8');
const script = template.slice(template.indexOf('(function() {{'), template.indexOf('\n"#,', template.indexOf('(function() {{')))
  .replace(/\{(?:app_id_esc|app_data_esc|workspace_esc|appearance_mode_esc|platform_esc)\}/g, '"test"')
  .replaceAll('{{', '{').replaceAll('}}', '}');
type Message = { requestId: string; sessionId?: string; imageContexts?: unknown[] };
type Rpc = { id?: string; method: string; params: Record<string, unknown> };
type Sdk = {
  agent: { run: (prompt: string, options?: Record<string, unknown>) => Promise<{ sessionId: string }> };
  chat: { onUserMessage: (handler: (payload: Message) => Promise<unknown>) => void };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness() {
  const handlers = new Set<(event: { data: unknown }) => void>();
  const requests: Rpc[] = [];
  const run = vi.fn(async (params: Record<string, unknown>) => ({ sessionId: params.sessionId || 'new-session', turnId: 'turn-1' }));
  const deliver = (data: unknown) => [...handlers].forEach(handler => handler({ data }));
  const window: { app?: Sdk; [key: string]: unknown } = {
    addEventListener: (_name: string, handler: (event: { data: unknown }) => void) => handlers.add(handler),
    removeEventListener: (_name: string, handler: (event: { data: unknown }) => void) => handlers.delete(handler),
    parent: { postMessage: (request: Rpc) => {
      requests.push(request);
      if (!request.id) return;
      void Promise.resolve().then(() => request.method === 'agent.run' ? run(request.params) : null).then(
        result => deliver({ id: request.id, result }),
        error => deliver({ id: request.id, error: { message: error.message } }),
      );
    } },
  };
  vm.runInNewContext(script, { window, document: { documentElement: { setAttribute() {}, style: { setProperty() {} } } } });
  const send = (payload: Message) => deliver({ type: 'openbitfun:event', event: 'chat:userMessage', payload });
  return { app: window.app!, send, requests, run };
}
const images = Array.from({ length: 5 }, (_, index) => ({
  id: `ref-${index}`, data_url: `data:image/png;base64,${btoa(`image-${index}`)}`, mime_type: 'image/png',
}));

describe('injected MiniApp SDK image message ownership', () => {
  it('preserves all five images for legacy async text-only handlers and releases them after completion', async () => {
    const { app, send, run, requests } = harness();
    app.chat.onUserMessage(async () => {
      await Promise.resolve();
      await app.agent.run('internal prompt', { sessionId: 'deck' });
      await app.agent.run('continue', { sessionId: 'deck' });
    });
    send({ requestId: 'first', sessionId: 'deck', imageContexts: images });
    send({ requestId: 'first', sessionId: 'deck', imageContexts: images });
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toMatchObject({ imageContexts: images, chatRequestId: 'first' });
    expect(run.mock.calls[1][0]).not.toHaveProperty('imageContexts');
    expect(requests.some(request => request.method === 'chat.completeUserMessage' && !request.params.error)).toBe(true);
    await app.agent.run('unrelated', { sessionId: 'deck' });
    expect(run.mock.calls[2][0]).not.toHaveProperty('imageContexts');
    expect(run.mock.calls[2][0]).not.toHaveProperty('chatRequestId');
  });

  it('retains images after a rejected submission, then attaches them to the accepted retry', async () => {
    const { app, send, run } = harness();
    run.mockRejectedValueOnce(new Error('offline'));
    app.chat.onUserMessage(async () => {
      try { await app.agent.run('first', { sessionId: 'deck' }); } catch { /* retry */ }
      await app.agent.run('retry', { sessionId: 'deck' });
    });
    send({ requestId: 'retry-message', sessionId: 'deck', imageContexts: images });
    await flush();
    expect(run.mock.calls.map(call => call[0].imageContexts)).toEqual([images, images]);
  });

  it.each([{ explicitImages: images }, { explicitImages: [] }])('does not re-inherit images after an accepted explicit attachment choice', async ({ explicitImages }) => {
    const { app, send, run } = harness();
    app.chat.onUserMessage(async () => {
      await app.agent.run('first turn', { sessionId: 'deck', imageContexts: explicitImages });
      await app.agent.run('follow-up', { sessionId: 'deck' });
    });
    send({ requestId: 'explicit', sessionId: 'deck', imageContexts: images });
    await flush();
    expect(run.mock.calls[0][0].imageContexts).toEqual(explicitImages);
    expect(run.mock.calls[1][0]).not.toHaveProperty('imageContexts');
  });

  it('does not attach another topic’s images and lets explicit request ids disambiguate concurrent messages', async () => {
    const { app, send, run } = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    app.chat.onUserMessage(async payload => {
      await gate;
      await app.agent.run(payload.requestId, { sessionId: payload.sessionId, chatRequestId: payload.requestId });
    });
    send({ requestId: 'one', sessionId: 'deck', imageContexts: images });
    send({ requestId: 'two', sessionId: 'deck', imageContexts: [{ ...images[0], id: 'two' }] });
    await expect(app.agent.run('ambiguous', { sessionId: 'deck' })).rejects.toThrow('Concurrent MiniApp image messages');
    await app.agent.run('other topic', { sessionId: 'other-deck' });
    expect(run.mock.calls[0][0]).not.toHaveProperty('imageContexts');
    release();
    await flush();
    expect(run.mock.calls[1][0]).toMatchObject({ chatRequestId: 'one', imageContexts: images });
    expect(run.mock.calls[2][0]).toMatchObject({ chatRequestId: 'two', imageContexts: [{ ...images[0], id: 'two' }] });
    await expect(app.agent.run('stale', { chatRequestId: 'one' })).rejects.toThrow('no longer active');
  });

  it('keeps explicit images and text-only legacy messages compatible', async () => {
    const { app, send, run } = harness();
    app.chat.onUserMessage(async payload => {
      await app.agent.run('task', { sessionId: 'deck', imageContexts: payload.imageContexts });
    });
    send({ requestId: 'legacy', sessionId: 'deck' });
    await flush();
    expect(run.mock.calls[0][0].imageContexts).toBeUndefined();
    send({ requestId: 'image', sessionId: 'deck', imageContexts: images });
    await flush();
    expect(run.mock.calls[1][0]).toMatchObject({ imageContexts: images, chatRequestId: 'image' });
  });
});
