#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

// Node 25+ exposes its own webstorage globals, which shadow jsdom's
// localStorage/sessionStorage in Vitest environments. Append the disable flag
// instead of replacing NODE_OPTIONS so the caller's heap or tracing flags stay
// intact.
const WEBSTORAGE_FLAG = '--no-experimental-webstorage';
const existing = (process.env.NODE_OPTIONS ?? '').trim();
if (!existing.split(/\s+/).includes(WEBSTORAGE_FLAG)) {
  process.env.NODE_OPTIONS = [existing, WEBSTORAGE_FLAG].filter(Boolean).join(' ');
}

const require = createRequire(import.meta.url);
const vitestPackagePath = require.resolve('vitest/package.json');
const vitestBin = path.join(
  path.dirname(vitestPackagePath),
  require('vitest/package.json').bin.vitest,
);
const child = spawn(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
