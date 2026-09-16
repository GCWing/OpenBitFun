const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/DurableSessionStream.ets'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exportsObject = {};
const Encoding = {
  base64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
  bytesToUtf8: value => Buffer.from(value).toString('utf8'),
  parseJsonObject: value => JSON.parse(value)
};
new Function('require', 'exports', compiled)(() => ({ Encoding }), exportsObject);
const { DurableSessionStream } = exportsObject;
async function settle(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(predicate(), 'stream did not settle');
}
function harness(events) {
  let update, reconnect;
  const pages = [];
  for (const [index, event] of events.entries()) {
    const bytes = Buffer.from(JSON.stringify({ nonce: 'nonce', data: JSON.stringify(event) }));
    const chunks = [bytes.subarray(0, 10), bytes.subarray(10)];
    for (const [fragmentIndex, chunk] of chunks.entries()) {
      pages.push({ seq: pages.length + 1, content: { t: 'encrypted', c: JSON.stringify({ v: 1, eventId: `e${index}`, index: fragmentIndex, count: 2, data: chunk.toString('base64') }) } });
    }
  }
  let readCount = 0;
  const applied = [], errors = [];
  let caught = 0;
  const transport = {
    grant: async () => ({ session_id: 'session', relay_session_id: 'opaque', key: Buffer.alloc(32).toString('base64') }),
    read: async (_id, after) => { readCount++; return { messages: pages.filter(row => row.seq > after).slice(0, 1), hasMore: pages.some(row => row.seq > after + 1) }; },
    decrypt: async cipher => JSON.parse(cipher.data),
    onUpdate: fn => { update = fn; return () => { update = undefined; }; },
    onReconnect: fn => { reconnect = fn; return () => { reconnect = undefined; }; }
  };
  const callbacks = { onEvent: async event => { applied.push(event); }, onCaughtUp: async () => { caught++; }, onError: error => errors.push(error) };
  return { transport, callbacks, applied, errors, pages, get reads() { return readCount; }, get caught() { return caught; }, deliver: message => update?.('update', { body: { sid: 'opaque', message } }), wake: () => update?.('update', { body: { sid: 'opaque' } }), reconnect: () => reconnect?.(), unrelated: () => update?.('update', { body: { sid: 'other' } }) };
}
test('reassembles across pages, commits once, and idle unrelated updates issue no reads', async () => {
  const h = harness([{ session_id: 'session', event: 'delta', payload: { text: 'hello' } }]);
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    assert.equal(h.applied.length, 1);
    assert.equal(h.reads, 2);
    h.unrelated(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.reads, 2);
    h.reconnect(); await settle(() => h.caught === 2);
    assert.equal(h.applied.length, 1);
    assert.equal(h.reads, 3);
  } finally { stream.close(); }
});
test('wakeups during an in-flight read are coalesced and catch up without concurrent readers', async () => {
  const h = harness([]);
  let active = 0, peak = 0;
  h.transport.read = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { messages: [], hasMore: false }; };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => active === 1);
    for (let i = 0; i < 30; i++) h.wake();
    await settle(() => h.caught === 2);
    assert.equal(peak, 1);
  } finally { stream.close(); }
});
test('rejects session substitution and sequence gaps without application', async () => {
  for (const gap of [false, true]) {
    const h = harness([{ session_id: gap ? 'session' : 'other', event: 'delta', payload: {} }]);
    if (gap) h.pages[0].seq = 2;
    const stream = new DurableSessionStream('session', h.transport, h.callbacks);
    try { await settle(() => h.errors.length === 1); assert.equal(h.applied.length, 0); }
    finally { stream.close(); }
  }
});

test('continuous WS messages apply directly with zero additional HTTP requests', async () => {
  const h = harness([]);
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    const rows = harness([{ session_id: 'session', event: 'session-message', payload: { id: 'stable' } }]).pages;
    for (const row of rows) h.deliver(row);
    await settle(() => h.applied.length === 1);
    assert.equal(h.reads, 1, 'only initial catchup may request HTTP');
    for (const row of rows) h.deliver(row);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.applied.length, 1);
    assert.equal(h.reads, 1);
  } finally { stream.close(); }
});
test('latest-page initialization and backward history keep forward cursor monotonic', async () => {
  const h = harness([
    { session_id: 'session', event: 'session-record', payload: { id: 'old' } },
    { session_id: 'session', event: 'session-record', payload: { id: 'new' } }
  ]);
  const beforeCalls = [];
  h.transport.readBefore = async (_id, before) => {
    beforeCalls.push(before);
    const rows = h.pages.filter(row => row.seq < before).reverse();
    return { messages: rows.slice(0, 2), hasMore: rows.length > 2 };
  };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new']);
    assert.equal(h.reads, 0);
    stream.loadOlder(); await settle(() => h.applied.length === 2);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new', 'old']);
    h.reconnect(); await settle(() => h.reads === 1);
    assert.equal(h.applied.length, 2, 'forward catchup must not replay old history');
    assert.deepEqual(beforeCalls, [Number.MAX_SAFE_INTEGER, 3]);
  } finally { stream.close(); }
});
test('latest page beginning inside a fragmented event fetches its prefix', async () => {
  const h = harness([{ session_id: 'session', event: 'session-record', payload: { id: 'split' } }]);
  let beforeReads = 0;
  h.transport.readBefore = async (_id, before) => {
    beforeReads++;
    const rows = h.pages.filter(row => row.seq < before).reverse();
    return { messages: rows.slice(0, 1), hasMore: rows.length > 1 };
  };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.applied.length === 1);
    assert.equal(beforeReads, 2);
    assert.equal(h.applied[0].payload.id, 'split');
  } finally { stream.close(); }
});

test('backward pagination rejects a repeated fragment page instead of looping', async () => {
  const h = harness([{ session_id: 'session', event: 'session-record', payload: { id: 'split' } }]);
  let reads = 0;
  h.transport.readBefore = async () => {
    if (++reads > 2) throw Error('Unexpected additional history read');
    return { messages: [h.pages[1]], hasMore: true };
  };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.errors.length === 1);
    assert.equal(reads, 2);
    assert.match(h.errors[0].message, /pagination did not advance/);
    assert.deepEqual(h.applied, []);
  } finally { stream.close(); }
});

test('failure in a fragmented next record resumes after the last committed event without duplicating it', async () => {
  const h = harness([
    { session_id: 'session', event: 'session-record', payload: { id: 'committed' } },
    { session_id: 'session', event: 'session-record', payload: { id: 'interrupted' } },
  ]);
  const cursors = [];
  const read = h.transport.read;
  let failOnce = true;
  h.transport.read = async (id, after) => {
    cursors.push(after);
    if (after === 3 && failOnce) { failOnce = false; throw new Error('Connection interrupted between fragments'); }
    return read(id, after);
  };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.errors.length === 1);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['committed']);
    h.reconnect();
    await settle(() => h.caught === 1);
    assert.deepEqual(cursors, [0, 1, 2, 3, 2, 3]);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['committed', 'interrupted']);
  } finally { stream.close(); }
});

test('live records queued during backward history resume without losing the forward cursor', async () => {
  const h = harness([
    { session_id: 'session', event: 'session-record', payload: { id: 'old' } },
    { session_id: 'session', event: 'session-record', payload: { id: 'new' } }
  ]);
  let releaseHistory;
  let historyStarted = false;
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  h.transport.readBefore = async (_id, before) => {
    if (before !== Number.MAX_SAFE_INTEGER) { historyStarted = true; await historyGate; }
    const rows = h.pages.filter(row => row.seq < before).reverse();
    return { messages: rows.slice(0, 2), hasMore: rows.length > 2 };
  };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    stream.loadOlder(); await settle(() => historyStarted);
    const incoming = harness([{ session_id: 'session', event: 'session-record', payload: { id: 'live-final' } }]);
    for (const row of incoming.pages) {
      const fragment = JSON.parse(row.content.c); fragment.eventId = 'live-final';
      const next = { seq: row.seq + 4, content: { t: 'encrypted', c: JSON.stringify(fragment) } };
      h.pages.push(next); h.deliver(next);
    }
    releaseHistory();
    await settle(() => h.applied.length === 3);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new', 'old', 'live-final']);
    h.reconnect(); await settle(() => h.caught >= 3);
    assert.equal(h.applied.length, 3);
    assert.deepEqual(h.errors, []);
  } finally { releaseHistory(); stream.close(); }
});

test('history failure exposes retry state and manual retry resumes the same cursor', async () => {
  const h = harness([
    { session_id: 'session', event: 'session-record', payload: { id: 'old' } },
    { session_id: 'session', event: 'session-record', payload: { id: 'new' } }
  ]);
  const states = [], cursors = [];
  let reject = true;
  h.callbacks.onHistoryState = (loading, failed) => states.push([loading, failed]);
  h.transport.readBefore = async (_id, before) => {
    cursors.push(before);
    if (before !== Number.MAX_SAFE_INTEGER && reject) throw new Error('History request failed');
    const rows = h.pages.filter(row => row.seq < before).reverse();
    return { messages: rows.slice(0, 2), hasMore: rows.length > 2 };
  };
  const stream = new DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    stream.loadOlder(); await settle(() => h.errors.length === 1);
    assert.deepEqual(states.at(-1), [false, true]);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new']);
    reject = false;
    stream.loadOlder();
    assert.deepEqual(states.at(-1), [true, false]);
    await settle(() => h.applied.length === 2 && states.at(-1)[0] === false);
    assert.deepEqual(states.at(-1), [false, false]);
    assert.deepEqual(cursors, [Number.MAX_SAFE_INTEGER, 3, 3]);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new', 'old']);
  } finally { stream.close(); }
});

test('older prefetch starts after the latest page and coalesces manual requests', async () => {
  const timers = new Map(); let timerId = 0;
  const module = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', compiled)(
    () => ({ Encoding }), module,
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    id => timers.delete(id));
  const h = harness([
    { session_id: 'session', event: 'session-record', payload: { id: 'old' } },
    { session_id: 'session', event: 'session-record', payload: { id: 'new' } }
  ]);
  const cursors = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.transport.readBefore = async (_id, before) => {
    cursors.push(before);
    if (before !== Number.MAX_SAFE_INTEGER) await gate;
    const rows = h.pages.filter(row => row.seq < before).reverse();
    return { messages: rows.slice(0, 2), hasMore: rows.length > 2 };
  };
  const stream = new module.DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new']);
    const timer = [...timers.entries()].find(([, value]) => value.delay === 250);
    assert.ok(timer, 'latest page must schedule older prefetch');
    timers.delete(timer[0]); timer[1].callback();
    await settle(() => cursors.length === 2);
    stream.loadOlder(); stream.loadOlder();
    assert.equal(cursors.length, 2, 'manual clicks share the background history read');
    release(); await settle(() => h.applied.length === 2);
    assert.deepEqual(h.applied.map(event => event.payload.id), ['new', 'old']);
    assert.equal(timers.size, 0, 'exhausted history must not poll');
  } finally { release(); stream.close(); }
});

test('closing a session cancels scheduled history prefetch', async () => {
  const timers = new Map(); let timerId = 0;
  const module = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', compiled)(
    () => ({ Encoding }), module,
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    id => timers.delete(id));
  const h = harness([{ session_id: 'session', event: 'session-record', payload: { id: 'new' } }]);
  h.transport.readBefore = async () => ({ messages: h.pages, hasMore: true });
  const stream = new module.DurableSessionStream('session', h.transport, h.callbacks);
  try {
    await settle(() => h.caught === 1);
    assert.equal(timers.size, 1);
    const staleCallback = [...timers.values()][0].callback;
    stream.close();
    assert.equal(timers.size, 0);
    staleCallback();
    assert.equal(h.caught, 1);
    assert.equal(timers.size, 0);
  } finally { stream.close(); }
});
