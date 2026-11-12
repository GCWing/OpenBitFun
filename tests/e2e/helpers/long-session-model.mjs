import { createServer } from 'node:http';
import { once } from 'node:events';

/** Text-only loopback Anthropic SSE. No credentials, tools, shell assumptions or product-store mocks. */
export async function createLongSessionModel({ intervalMs = 90, paragraphChars = 480 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || !Number.isInteger(paragraphChars) || paragraphChars < 32) {
    throw new Error('Invalid model workload');
  }
  const streams = new Map(), errors = [];
  const send = (response, data) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  const server = createServer(async (request, response) => {
    try {
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString());
      const last = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
      const marker = JSON.stringify(last?.content).match(/LONG_SESSION_STREAM:([a-z0-9-]+)/)?.[1];
      if (!marker || streams.has(marker)) throw new Error(`Unexpected or duplicate model request: ${marker}`);
      const state = { emitted: 0, bytes: 0, blockedWrites: 0, connected: true, finished: false, startedAt: Date.now(), lastEmittedAt: 0, response, timer: undefined };
      streams.set(marker, state);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      send(response, { type: 'message_start', message: { id: marker, type: 'message', role: 'assistant', model: 'perf-fixture-model', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
      send(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      const emit = () => {
        if (response.writableNeedDrain) { state.blockedWrites++; return; }
        const text = `\n\nLive ${marker} paragraph ${state.emitted}: ` + 'Readable **Markdown** for session rendering. '.repeat(Math.ceil(paragraphChars / 44)).slice(0, paragraphChars)
          + (state.emitted % 8 === 7 ? '\n\n```typescript\nexport const value = 42;\n```\n\n| A | B |\n|---|---|\n| one | two |\n' : '');
        state.emitted++; state.bytes += Buffer.byteLength(text); state.lastEmittedAt = Date.now();
        send(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      };
      emit(); state.timer = setInterval(emit, intervalMs);
      response.on('close', () => { state.connected = false; clearInterval(state.timer); });
    } catch (error) { errors.push(String(error)); response.statusCode = response.headersSent ? 200 : 400; response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const snapshot = marker => {
    const state = streams.get(marker);
    return state ? Object.fromEntries(['emitted', 'bytes', 'blockedWrites', 'connected', 'finished', 'startedAt', 'lastEmittedAt'].map(key => [key, state[key]])) : null;
  };
  return { url: `http://127.0.0.1:${server.address().port}`, errors, snapshot,
    finish(marker) {
      const state = streams.get(marker);
      if (!state || state.finished) return;
      clearInterval(state.timer); state.finished = true;
      send(state.response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `\n\nLONG_SESSION_COMPLETE:${marker}` } });
      send(state.response, { type: 'content_block_stop', index: 0 });
      send(state.response, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: state.emitted * 100 } });
      send(state.response, { type: 'message_stop' }); state.response.end();
    },
    async close() {
      for (const state of streams.values()) { clearInterval(state.timer); state.response.end(); }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    },
  };
}
