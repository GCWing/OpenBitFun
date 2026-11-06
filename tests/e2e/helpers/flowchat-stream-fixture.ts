import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

/** Loopback model only. Desktop still owns actual tools, events and persistence. */
export async function createFlowChatStreamFixture(workspace: string, options: {
  initialParagraphs?: number; maxParagraphs?: number; intervalMs?: number; responseDelayMs?: number;
} = {}) {
  const initialParagraphs = options.initialParagraphs ?? Number(process.env.OPENBITFUN_STREAM_INITIAL_PARAGRAPHS || 80);
  const maxParagraphs = options.maxParagraphs ?? Infinity;
  const intervalMs = options.intervalMs ?? 90;
  const responseDelayMs = options.responseDelayMs ?? 0;
  if (!Number.isInteger(initialParagraphs) || initialParagraphs < 0
    || (maxParagraphs !== Infinity && (!Number.isInteger(maxParagraphs) || maxParagraphs < initialParagraphs))
    || !Number.isInteger(intervalMs) || intervalMs <= 0
    || !Number.isInteger(responseDelayMs) || responseDelayMs < 0) throw new Error('Invalid stream fixture workload');
  const errors: string[] = [];
  const results: unknown[] = [];
  let emitted = 0;
  let disconnected = false;
  let stream: ServerResponse | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let beginOutput: (() => void) | undefined;
  const event = (res: ServerResponse, value: { type: string; [key: string]: unknown }) =>
    res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  const start = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { type: 'message_start', message: { id: 'flowchat-perf', type: 'message', role: 'assistant', model: 'flowchat-perf',
      content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
  };
  const finish = (res: ServerResponse, reason = 'end_turn') => {
    event(res, { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 2000 } });
    event(res, { type: 'message_stop' }); res.end();
  };
  for (let index = 0; index < 4; index++) writeFileSync(join(workspace, `flowchat-live-${index}.ts`), 'export const value = 0;\n');
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const blocks = (body.messages ?? []).flatMap((message: { content: unknown }) => Array.isArray(message.content) ? message.content : []);
      const toolResults = blocks.filter((block: { type: string; tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id?.startsWith('flowchat-perf-'));
      if (responseDelayMs > 0) await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, responseDelayMs);
        res.once('close', () => { clearTimeout(timeout); resolve(); });
      });
      if (res.destroyed) return;
      start(res);
      if (!toolResults.length) {
        const names = new Set((body.tools ?? []).map((tool: { name: string }) => tool.name));
        if (!names.has('ExecCommand') || !names.has('Edit')) throw new Error('Fixture requires real ExecCommand and Edit tools');
        for (let index = 0; index < 8; index++) {
          const edit = index >= 4;
          const input = edit ? { file_path: join(workspace, `flowchat-live-${index - 4}.ts`), old_string: 'value = 0', new_string: 'value = 1' }
            : { cmd: "printf 'flowchat shell output\\n%.0s' {1..160}", workdir: workspace };
          event(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `flowchat-perf-${index}`, name: edit ? 'Edit' : 'ExecCommand', input: {} } });
          event(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
          event(res, { type: 'content_block_stop', index });
        }
        finish(res, 'tool_use');
        return;
      }
      const unique = new Map(toolResults.map((result: { tool_use_id: string }) => [result.tool_use_id, result]));
      results.splice(0, results.length, ...unique.values());
      stream = res;
      disconnected = false;
      event(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      const emit = () => {
        if (emitted >= maxParagraphs) return;
        const text = `\n\nStream paragraph ${emitted++}: ${'Readable text with **emphasis** and scrolling continuity. '.repeat(8)}`
          + (emitted % 8 === 0 ? '\n\n```typescript\nexport const streamed = true;\n```\n' : '');
        event(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        if (emitted >= maxParagraphs) { clearInterval(timer); timer = undefined; }
      };
      beginOutput = () => {
        for (let index = 0; index < initialParagraphs; index++) emit();
        if (emitted < maxParagraphs) timer = setInterval(emit, intervalMs);
      };
      res.on('close', () => { disconnected = true; clearInterval(timer); timer = undefined; });
    } catch (error) { errors.push(String(error)); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return {
    url: `http://127.0.0.1:${address.port}`, errors, results,
    get emitted() { return emitted; },
    get disconnected() { return disconnected; },
    get textReady() { return Boolean(beginOutput); },
    begin() { beginOutput?.(); beginOutput = undefined; },
    finish() {
      clearInterval(timer); timer = undefined;
      if (stream && !stream.writableEnded) {
        event(stream, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\nFLOWCHAT_STREAM_COMPLETE' } });
        event(stream, { type: 'content_block_stop', index: 0 }); finish(stream);
      }
    },
    async close() { clearInterval(timer); stream?.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
