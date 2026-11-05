import { readFileSync, writeFileSync } from 'node:fs';
import { compileCatalog } from '../src/shared/generative-ui/library.mjs';
const path = new URL('../src/shared/generative-ui/', import.meta.url);
const output = JSON.stringify(compileCatalog(JSON.parse(readFileSync(new URL('library.json', path), 'utf8'))), null, 2) + '\n';
const target = new URL('catalog.json', path);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('GenUI catalog is stale; run node scripts/generate-genui-contract.mjs');
} else writeFileSync(target, output);
