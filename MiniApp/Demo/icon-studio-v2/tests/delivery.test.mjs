import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('standalone V2.0.2 includes executable local assets without remote dependencies', () => {
  const html = read('../../../../output/miniapps/icon-studio-v2.0.2.html');
  assert.match(html, /V2\.0\.2/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)\s*=\s*["']https?:/i);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0][1]);
});

test('both locales cover static labels, tools and statuses', () => {
  const context = vm.createContext({}); vm.runInContext(read('../source/ui/i18n.js'), context);
  const messages = context.StudioMessages;
  assert.deepEqual(Object.keys(messages['zh-CN']).sort(), Object.keys(messages['en-US']).sort());
  for (const match of read('../source/index.html').matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) for (const table of Object.values(messages)) assert.equal(typeof table[match[1]], 'string', match[1]);
  for (const match of read('../source/ui.js').matchAll(/\b(?:status|t)\('([^']+)'/g)) for (const table of Object.values(messages)) assert.equal(typeof table[match[1]], 'string', match[1]);
});
