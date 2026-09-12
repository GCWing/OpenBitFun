const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { generate } = require('./generate.cjs');
const output = path.resolve(__dirname, '../entry/src/main/resources/rawfile/miniapps');

test('packages three self-contained apps with shared themes and valid executable scripts', () => {
  generate();
  const catalog = JSON.parse(fs.readFileSync(path.join(output, 'catalog.json')));
  assert.deepEqual(catalog.map(app => app.id), ['builtin-gomoku', 'builtin-regex-playground', 'builtin-daily-divination']);
  for (const app of catalog) {
    assert.ok(app.locales['zh-CN'].name && app.locales['en-US'].name);
    const html = fs.readFileSync(path.join(output, `${app.id}.html`), 'utf8');
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /openbitfun-appearance-default/);
    assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)=/);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  }
});

test('bridge routes local storage, ignores foreign replies and updates language and appearance', async () => {
  const listeners = {};
  const attributes = {};
  const messages = [];
  const parent = { postMessage: message => messages.push(message) };
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  const media = { matches: true, addEventListener: (_name, fn) => { listeners.scheme = fn; } };
  const document = { documentElement: { style: {}, setAttribute: (key, value) => { attributes[key] = value; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8'), { window, parent, document, matchMedia: () => media });
  assert.equal(attributes['data-openbitfun-appearance-mode'], 'dark');
  media.matches = false;
  listeners.scheme();
  assert.equal(attributes['data-openbitfun-appearance-mode'], 'light');
  let localeChanged = false;
  window.app.onLocaleChange(() => { localeChanged = true; });
  listeners.message({ source: parent, data: { type: 'openbitfun:event', event: 'localeChange', payload: { locale: 'zh-CN', unsupported: 'Unsupported' } } });
  assert.equal(window.app.locale, 'zh-CN');
  assert.ok(localeChanged);
  const reading = window.app.storage.get('stats');
  const request = messages.at(-1);
  assert.equal(request.method, 'storage.get');
  listeners.message({ source: {}, data: { id: request.id, result: 'attacker' } });
  listeners.message({ source: parent, data: { id: request.id, result: { wins: 2 } } });
  assert.equal((await reading).wins, 2);
  const saving = window.app.storage.set('stats', { wins: 3 });
  listeners.message({ source: parent, data: { id: messages.at(-1).id, error: { message: 'Disk unavailable' } } });
  await assert.rejects(saving, /Disk unavailable/);
  await assert.rejects(window.app.call('shell.exec'), /Unsupported/);
});
