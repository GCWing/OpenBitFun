// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build, resolveConfig } from 'vite';
import { expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const configFile = fileURLToPath(new URL('../../../vite.config.ts', import.meta.url));
const root = path.dirname(configFile);
const entry = fileURLToPath(new URL('./markdownParseCache.ts', import.meta.url));

it('builds a Markdown worker that initializes and parses GFM without a DOM', async () => {
  const config = await resolveConfig({ root, configFile, logLevel: 'silent' }, 'build');
  // Use the product resolver and real new Worker URL, without unrelated app/font builds.
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    resolve: { alias: config.resolve.alias },
    build: {
      write: false,
      minify: true,
      rollupOptions: { input: entry, preserveEntrySignatures: 'strict' },
    },
  });
  if ('on' in result) throw new Error('Unexpected watch build');
  const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const worker = output.find(asset => asset.type === 'asset' && /markdownParse\.worker-.*\.js$/.test(asset.fileName));
  if (!worker || worker.type !== 'asset') throw new Error('Markdown worker asset was not emitted');
  const replies: unknown[] = [];
  const self = {
    postMessage: (message: unknown) => replies.push(message),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  runInNewContext(String(worker.source), { self }, { timeout: 2000 });
  expect(self.onmessage).toBeTypeOf('function');
  for (const source of [
    '# Entities &copy; &amp; &NotEqualTilde; &#x1F680; &unknown;\n\n[link][target]\n\n[target]: https://example.com',
    '| A | B |\n| - | - |\n| ~~x~~ | y |\n\n- [x] done\n\nNote[^1]\n\n[^1]: Footnote',
  ]) {
    self.onmessage!({ data: source });
    expect(replies.pop()).toEqual({ tree: unified().use(remarkParse).use(remarkGfm).parse(source) });
  }
}, 20_000);

it('resolves the DOM-free decoder in development too', async () => {
  const config = await resolveConfig({ root, configFile, logLevel: 'silent' }, 'serve');
  const resolved = await config.createResolver()('decode-named-character-reference', entry);
  expect(resolved).toMatch(/\/decode-named-character-reference\/index\.js$/);
});
