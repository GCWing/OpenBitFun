import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('standalone output embeds its assets and has syntactically valid scripts', () => {
  const html = read('../../../../output/miniapps/background-remover.html');
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('id="openbitfun-appearance-default"'));
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)\s*=\s*["']https?:/i);
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
});

test('both languages cover all static and dynamic message keys', () => {
  const context = vm.createContext({});
  vm.runInContext(read('../source/ui/i18n.js'), context);
  const messages = context.CutoutMessages;
  const keys = Object.keys(messages['zh-CN']).sort();
  assert.deepEqual(Object.keys(messages['en-US']).sort(), keys);
  for (const match of read('../source/index.html').matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) {
    for (const table of Object.values(messages)) assert.equal(typeof table[match[1]], 'string', match[1]);
  }
  for (const match of read('../source/ui/main.js').matchAll(/\b(?:status|t)\('([^']+)'/g)) {
    for (const table of Object.values(messages)) assert.equal(typeof table[match[1]], 'string', match[1]);
  }
});
