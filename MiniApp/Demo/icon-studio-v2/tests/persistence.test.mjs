import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function editor(storage = {}) {
  const elements = new Map(), events = new Map(), timers = new Map(), writes = [];
  let sequence = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, value: '', textContent: '', addEventListener() {} });
    return elements.get(id);
  };
  const window = { app: {
    locale: 'en-US', storage: { get: async () => null, set: async (key, value) => { writes.push({ key, value }); }, ...storage },
  }, addEventListener: (name, fn) => events.set(name, fn) };
  const context = vm.createContext({
    window, navigator: { language: 'en-US' },
    document: { getElementById: element, addEventListener() {} },
    setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  for (const name of ['geometry', 'i18n', 'state', 'io']) vm.runInContext(fs.readFileSync(new URL(`../source/ui/${name}.js`, import.meta.url), 'utf8'), context);
  context.IconStudio.render = () => {};
  return { S: context.IconStudio, G: context.IconGeometry, events, timers, writes };
}

test('an edit closed inside the debounce period flushes the latest host snapshot', async () => {
  const { S, G, events, writes, timers } = editor();
  S.change(() => S.add(G.primitive('rect', { x: 3, y: 3 }, { x: 20, y: 20 })));
  S.change(() => { S.doc.name = 'last edit'; });
  assert.equal(writes.length, 0); assert.equal(timers.size, 1);
  events.get('pagehide')();
  assert.equal(writes.length, 1); assert.equal(writes[0].value.name, 'last edit');
  assert.equal(timers.size, 0);
  await S.flushSave();
});

test('overlapping host saves stay ordered and retain the newest project', async () => {
  const calls = [], release = [];
  const { S } = editor({ set: async (key, value) => {
    calls.push(value.name); await new Promise(resolve => release.push(resolve));
  } });
  S.change(() => { S.doc.name = 'first'; }); const complete = S.flushSave();
  S.change(() => { S.doc.name = 'second'; }); S.flushSave();
  S.change(() => { S.doc.name = 'latest'; }); S.flushSave();
  assert.deepEqual(calls, ['first']);
  release.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['first', 'latest']);
  release.shift()(); await complete;
});

test('duplicating a valid large document cannot produce an unreadable saved document', () => {
  const { S, G, writes, timers } = editor();
  const nodes = Array.from({ length: 10001 }, (_, i) => ({ x: i % 24, y: Math.floor(i / 24) % 24 }));
  S.doc = G.normalizeProject({ schemaVersion: 1, name: 'large', shapes: [{ id: 'large', contours: [{ closed: false, nodes }] }] });
  S.selected = 'large';
  const before = JSON.stringify(S.doc);
  const accepted = S.change(() => S.add(G.copy(S.current())));
  assert.equal(accepted, false);
  assert.equal(JSON.stringify(S.doc), before);
  assert.equal(S.statusKey, 'tooComplex');
  assert.equal(S.undo.length, 0); assert.equal(timers.size, 0); assert.equal(writes.length, 0);
  assert.doesNotThrow(() => G.normalizeProject(S.snapshot()));
});

test('unreadable stored projects remain untouched instead of being reset', async () => {
  const future = { schemaVersion: 99, shapes: [{ preserved: 'user data' }] };
  const { S, writes } = editor({ get: async () => future });
  const before = JSON.stringify(S.doc);
  await S.restore();
  assert.equal(S.statusKey, 'storageInvalid'); assert.equal(JSON.stringify(S.doc), before);
  assert.equal(future.shapes[0].preserved, 'user data'); assert.equal(writes.length, 0);
});
