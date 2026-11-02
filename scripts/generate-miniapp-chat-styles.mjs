#!/usr/bin/env node
// Compile the actual Hi/FlowChat CSS owners, without bundling their JS runtime.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const generated = resolve(root, 'src/apps/miniapp-shell/src/generated');
export async function buildMiniAppChatStyles() {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'error',
    resolve: { alias: { '@': resolve(root, 'src/web-ui/src') } },
    css: { modules: { generateScopedName: (name, filename) => `miniapp-${basename(filename, '.module.css')}-${name}` } },
    build: {
      write: false, minify: false, cssMinify: false, cssCodeSplit: false, sourcemap: false,
      lib: { entry: resolve(root, 'src/apps/miniapp-shell/styles/chat.js'), formats: ['es'], fileName: 'chat-style-classes', cssFileName: 'chat-styles' },
    },
  });
  const output = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output);
  const script = output.find(file => file.type === 'chunk' && file.isEntry);
  const style = output.find(file => file.type === 'asset' && file.fileName.endsWith('.css'));
  if (!script || !style || script.imports.length || script.dynamicImports.length) throw new Error('MiniApp chat projection must contain only CSS and static class names');
  const header = '/* Generated from the Hi and FlowChat style owners by scripts/generate-miniapp-chat-styles.mjs. */\n';
  return { 'chat-style-classes.js': header + script.code, 'chat-styles.css': header + style.source };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildMiniAppChatStyles();
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(generated, name);
    if (process.argv.includes('--check')) {
      if (readFileSync(path, 'utf8') !== content) throw new Error(`Stale MiniApp chat style projection: ${name}`);
    } else if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      mkdirSync(generated, { recursive: true }); writeFileSync(path, content);
    }
  }
}
