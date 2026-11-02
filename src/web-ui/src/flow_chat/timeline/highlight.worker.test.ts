// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = fileURLToPath(new URL('./highlight.worker.ts', import.meta.url));

type WorkerSandbox = {
  self: WorkerSandbox;
  Prism?: { disableWorkerMessageHandler?: boolean };
  onmessage?: (event: { data: unknown }) => void;
  postMessage: (message: unknown) => void;
  addEventListener: (type: string, listener: (event: { data: unknown }) => void) => void;
};

it('uses the app worker protocol without Prism installing its JSON worker handler', async () => {
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict' },
    },
  });
  if ('on' in result) throw new Error('Unexpected watch build');

  const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const worker = output.find(asset => asset.type === 'chunk' && /highlight\.worker-.*\.js$/.test(asset.fileName));
  if (!worker || worker.type !== 'chunk') throw new Error('Highlight worker asset was not emitted');

  const replies: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const sandbox = {
    postMessage: (message: unknown) => replies.push(message),
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === 'message') listeners.push(listener);
    },
  } as unknown as WorkerSandbox;
  runInNewContext(
    'class WorkerGlobalScope {}; globalThis.WorkerGlobalScope = WorkerGlobalScope; globalThis.self = globalThis; Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);',
    sandbox,
  );

  runInNewContext(worker.code, sandbox, { timeout: 2000 });

  expect(sandbox.Prism?.disableWorkerMessageHandler).toBe(true);
  expect(listeners).toHaveLength(0);
  expect(sandbox.onmessage).toBeTypeOf('function');

  const message = { id: 7, content: 'const answer: number = 42;', language: 'typescript' };
  expect(() => {
    for (const listener of listeners) listener({ data: message });
    sandbox.onmessage!({ data: message });
  }).not.toThrow();

  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ id: 7 });
}, 20_000);
