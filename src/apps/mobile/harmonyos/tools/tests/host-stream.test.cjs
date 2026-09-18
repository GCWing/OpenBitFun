const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/HostSessionStream.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exportsObject = {};
new Function('require', 'exports', compiled)(() => ({}), exportsObject);
const { HostSessionStream, parseHostStreamHint, checkHostStreamPage, HostStreamUnsupportedError, HOST_STREAM_CHANGED_EVENT } = exportsObject;

async function settle(predicate, label = 'stream did not settle') {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(predicate(), label);
}
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

/** An in-memory desktop: one stream log with an epoch, paged like `HostStreamHub`. */
function fakeHost(streamId, pageSize = 2) {
  const host = {
    epoch: 1, events: [], reads: [], unsubscribed: 0, hints: new Set(), reconnects: new Set(), failNext: null,
    append(event, payload = {}) { host.events.push({ seq: host.events.length + 1, event, payload }); return host.events[host.events.length - 1].seq; },
    restart() { host.epoch++; host.events = []; },
    hint() { for (const fn of host.hints) fn({ sourceDeviceId: 'desktop', streamId, epoch: host.epoch, cursor: host.events.length }); },
    reconnect() { for (const fn of host.reconnects) fn(); },
    page(request) {
      const cursor = host.events.length;
      const base = { resp: 'stream_page', stream_id: streamId, epoch: host.epoch, cursor, oldest_seq: 1, truncated: false };
      if (request.before !== undefined) {
        const rows = host.events.filter(row => row.seq < request.before);
        const events = rows.slice(Math.max(0, rows.length - pageSize));
        return { ...base, events, has_more: rows.length > events.length };
      }
      if (request.after !== undefined) {
        const rows = host.events.filter(row => row.seq > request.after);
        const events = rows.slice(0, pageSize);
        return { ...base, events, has_more: rows.length > events.length };
      }
      const events = host.events.slice(Math.max(0, host.events.length - pageSize));
      return { ...base, events, has_more: host.events.length > events.length };
    },
    source: {
      target: 'desktop',
      read: async request => {
        host.reads.push({ ...request });
        if (host.failNext) { const failure = host.failNext; host.failNext = null; throw failure; }
        return host.page(request);
      },
      unsubscribe: async () => { host.unsubscribed++; },
      onHint: fn => { host.hints.add(fn); return () => host.hints.delete(fn); },
      onReconnect: fn => { host.reconnects.add(fn); return () => host.reconnects.delete(fn); }
    }
  };
  return host;
}
function callbacks() {
  const c = { applied: [], errors: [], caught: 0, resumed: 0, gaps: 0, history: [], historyState: [] };
  c.hooks = {
    onEvent: async event => { c.applied.push(event); },
    onCaughtUp: async () => { c.caught++; },
    onResumed: async () => { c.resumed++; },
    onGap: async () => { c.gaps++; c.applied.length = 0; },
    onError: error => { c.errors.push(error); },
    onHistory: hasMore => { c.history.push(hasMore); },
    onHistoryState: (loading, failed) => { c.historyState.push([loading, failed]); }
  };
  return c;
}

test('opens on the latest page, applies hints forward and ignores stale or foreign hints', async () => {
  const host = fakeHost('session');
  host.append('session-record', { id: 'a' }); host.append('session-record', { id: 'b' }); host.append('session-record', { id: 'c' });
  const c = callbacks();
  const stream = new HostSessionStream('session', host.source, c.hooks);
  try {
    await settle(() => c.caught === 1);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['b', 'c']);
    assert.deepEqual(c.applied.map(e => e.session_id), ['session', 'session']);
    assert.deepEqual(c.history, [true]);
    assert.deepEqual(host.reads, [{}]);

    host.hint(); await tick();
    assert.equal(host.reads.length, 1, 'a hint at the known cursor issues no read');
    for (const fn of host.hints) fn({ sourceDeviceId: 'other-desktop', streamId: 'session', epoch: 1, cursor: 99 });
    for (const fn of host.hints) fn({ sourceDeviceId: 'desktop', streamId: 'other', epoch: 1, cursor: 99 });
    await tick();
    assert.equal(host.reads.length, 1, 'hints for other hosts or streams issue no read');

    host.append('session-record', { id: 'd' }); host.hint();
    await settle(() => c.caught === 2);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['b', 'c', 'd']);
    assert.deepEqual(host.reads.slice(1), [{ after: 3, epoch: 1 }]);
  } finally { stream.close(); }
  assert.equal(host.unsubscribed, 1);
});

test('loadOlder walks history backwards while the forward cursor stays monotonic', async () => {
  const host = fakeHost('session');
  for (const id of ['1', '2', '3', '4', '5']) host.append('session-record', { id });
  const c = callbacks();
  const stream = new HostSessionStream('session', host.source, c.hooks);
  try {
    await settle(() => c.caught === 1);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['4', '5']);
    stream.loadOlder();
    await settle(() => c.applied.length === 4);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['4', '5', '2', '3']);
    assert.deepEqual(host.reads.at(-1), { before: 4, epoch: 1 });
    assert.deepEqual(c.historyState, [[true, false], [false, false]]);
    stream.loadOlder();
    await settle(() => c.applied.length === 5);
    assert.deepEqual(c.history, [true, true, false]);
    stream.loadOlder(); await tick();
    assert.equal(host.reads.length, 3, 'no older pages remain to request');

    host.append('session-record', { id: '6' }); host.reconnect();
    await settle(() => c.caught === 2);
    assert.equal(c.resumed, 1);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['4', '5', '2', '3', '1', '6']);
    assert.deepEqual(host.reads.at(-1), { after: 5, epoch: 1 }, 'reconnect catches up forward, never replaying history');
  } finally { stream.close(); }
});

test('a host restart is announced as a gap and replayed from the latest page', async () => {
  const host = fakeHost('session');
  host.append('session-record', { id: 'old' });
  const c = callbacks();
  const stream = new HostSessionStream('session', host.source, c.hooks);
  try {
    await settle(() => c.caught === 1);
    host.restart(); host.append('session-record', { id: 'fresh' }); host.hint();
    await settle(() => c.caught === 2);
    assert.equal(c.gaps, 1);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['fresh']);
    assert.deepEqual(host.reads.slice(1), [{ after: 1, epoch: 1 }, {}]);
    host.append('session-record', { id: 'next' }); host.hint();
    await settle(() => c.caught === 3);
    assert.deepEqual(host.reads.at(-1), { after: 1, epoch: 2 }, 'the new epoch is adopted');
  } finally { stream.close(); }
});

test('transient failures back off and retry; an older host stops the stream with an unsupported error', async () => {
  const host = fakeHost('session');
  host.append('session-record', { id: 'a' });
  host.failNext = new Error('relay hiccup');
  const c = callbacks();
  const stream = new HostSessionStream('session', host.source, c.hooks);
  try {
    await settle(() => c.errors.length === 1);
    assert.equal(c.errors[0].message, 'relay hiccup');
    assert.equal(c.caught, 0);
    stream.wake();
    await settle(() => c.caught === 1);
    assert.deepEqual(c.applied.map(e => e.payload.id), ['a']);
  } finally { stream.close(); }

  const legacy = fakeHost('session');
  legacy.failNext = new Error('Could not parse device command: unknown variant `read_stream`');
  const d = callbacks();
  const stopped = new HostSessionStream('session', legacy.source, d.hooks);
  await settle(() => d.errors.length === 1);
  assert.ok(d.errors[0] instanceof HostStreamUnsupportedError);
  assert.ok(stopped.isClosed(), 'an unsupported host is not polled again');
  assert.equal(legacy.unsubscribed, 0, 'nothing was subscribed, nothing to unsubscribe');
  await tick(20);
  assert.equal(legacy.reads.length, 1);
});

test('closing mid-read drops the page and no callbacks fire afterwards', async () => {
  const host = fakeHost('session');
  host.append('session-record', { id: 'a' });
  let release;
  host.source.read = async request => { host.reads.push(request); await new Promise(resolve => { release = resolve; }); return host.page(request); };
  const c = callbacks();
  const stream = new HostSessionStream('session', host.source, c.hooks);
  await settle(() => host.reads.length === 1);
  stream.close(); release();
  await tick();
  assert.equal(c.applied.length, 0); assert.equal(c.caught, 0); assert.equal(c.errors.length, 0);
});

test('wire parsers reject foreign pages, invalid shapes, and non-hint device events', () => {
  assert.deepEqual(parseHostStreamHint('desktop', { cmd: 'device_event', event: HOST_STREAM_CHANGED_EVENT, payload: { stream_id: 's', epoch: 2, cursor: 9 } }),
    { sourceDeviceId: 'desktop', streamId: 's', epoch: 2, cursor: 9 });
  assert.equal(parseHostStreamHint('desktop', { cmd: 'device_event', event: 'session-updated', payload: { session_id: 's' } }), undefined);
  assert.equal(parseHostStreamHint('desktop', { cmd: 'device_event', event: HOST_STREAM_CHANGED_EVENT, payload: { stream_id: 's', epoch: '2', cursor: 9 } }), undefined);
  const page = { resp: 'stream_page', stream_id: 's', epoch: 1, events: [{ seq: 1, event: 'x', payload: {} }], has_more: false, cursor: 1, oldest_seq: 1 };
  assert.equal(checkHostStreamPage('s', page), page);
  assert.throws(() => checkHostStreamPage('other', page), /Invalid stream page/);
  assert.throws(() => checkHostStreamPage('s', { ...page, events: [{ seq: 'one', event: 'x' }] }), /Invalid stream event/);
  assert.throws(() => checkHostStreamPage('s', { resp: 'error', message: 'stream is closed' }), /stream is closed/);
  assert.throws(() => checkHostStreamPage('s', { resp: 'error', message: 'invalid RPC command' }), HostStreamUnsupportedError);
  assert.throws(() => checkHostStreamPage('s', { resp: 'ok' }), /Unexpected stream response/);
});
