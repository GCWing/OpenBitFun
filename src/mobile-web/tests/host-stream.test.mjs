import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../shared/relay-transport/HostStream.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { openHostStream, describeHostStreamError, parseStreamHint, parseStreamPage, UNSUPPORTED_HOST_MESSAGE } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

/** A scripted host: an in-memory stream log with the same paging rules as
 * `host_stream.rs`, plus the ability to "restart" (new epoch, seq from 1). */
class FakeHost {
  constructor(events = []) { this.epoch = 100; this.events = []; this.reads = []; this.unsubscribed = []; this.subscribers = new Set(); for (const event of events) this.append(event); }
  append(payload, event = 'session-record') { const seq = this.events.length + 1; this.events.push({ seq, event, payload }); return seq; }
  restart(events = []) { this.epoch += 1; this.events = []; for (const event of events) this.append(event); }
  get cursor() { return this.events.length; }
  transport(options = {}) {
    return {
      readStream: async request => {
        this.reads.push(request);
        if (options.fail?.(request)) throw new Error(options.fail(request));
        if (request.subscribe) this.subscribers.add(request.stream_id);
        const limit = request.limit ?? 2;
        let events; let hasMore;
        if (request.after !== undefined) { const rest = this.events.filter(e => e.seq > request.after); events = rest.slice(0, limit); hasMore = rest.length > limit; }
        else { const before = request.before ?? Number.MAX_SAFE_INTEGER; const rest = this.events.filter(e => e.seq < before); events = rest.slice(-limit); hasMore = rest.length > limit; }
        return { stream_id: request.stream_id, epoch: this.epoch, events, has_more: hasMore, cursor: this.cursor, oldest_seq: this.events[0]?.seq ?? this.cursor + 1, truncated: false };
      },
      unsubscribeStream: async id => { this.unsubscribed.push(id); },
    };
  }
}
function signals() {
  const hints = new Set(); const reconnects = new Set();
  return {
    onHint: listener => { hints.add(listener); return () => hints.delete(listener); },
    onReconnect: listener => { reconnects.add(listener); return () => reconnects.delete(listener); },
    hint: hint => { for (const listener of hints) listener(hint); },
    reconnect: () => { for (const listener of reconnects) listener(); },
    get size() { return hints.size + reconnects.size; },
  };
}
async function open(host, extra = {}) {
  const seen = []; const errors = []; const history = []; const gaps = []; let caughtUp = 0; let resumed = 0;
  const sig = signals();
  const stream = await openHostStream({
    transport: host.transport(extra), signals: sig, target: 'desktop', streamId: 's1', visibility: null,
    onEvent: event => seen.push(event), onError: error => errors.push(error), onCaughtUp: () => caughtUp++,
    onHistoryState: state => history.push(state), onResumed: () => resumed++, onGap: reason => gaps.push(reason),
  });
  return { stream, seen, errors, history, gaps, sig, get caughtUp() { return caughtUp; }, get resumed() { return resumed; } };
}

test('opening reads the latest page and reports history state; older pages walk backwards', async () => {
  const host = new FakeHost([{ id: 'turn/1' }, { id: 'turn/2' }, { id: 'turn/3' }, { id: 'turn/4' }, { id: 'turn/5' }]);
  const f = await open(host);
  assert.deepEqual(f.seen.map(e => e.payload.id), ['turn/4', 'turn/5']);
  assert.equal(f.seen[0].session_id, 's1');
  assert.equal(f.caughtUp, 1);
  assert.deepEqual(f.history.at(-1), { hasMore: true, oldestSeq: 4, cursor: 5, truncated: false });
  assert.ok(host.reads[0].subscribe, 'the opening read subscribes to hints');
  await f.stream.loadOlder();
  assert.deepEqual(f.seen.map(e => e.payload.id), ['turn/4', 'turn/5', 'turn/2', 'turn/3']);
  assert.equal(host.reads.at(-1).before, 4);
  await f.stream.loadOlder();
  assert.deepEqual(f.seen.map(e => e.payload.id), ['turn/4', 'turn/5', 'turn/2', 'turn/3', 'turn/1']);
  assert.equal(f.history.at(-1).hasMore, false);
  const reads = host.reads.length;
  await f.stream.loadOlder();
  assert.equal(host.reads.length, reads, 'exhausted history is not re-requested');
  f.stream.close();
  await settle();
  assert.deepEqual(host.unsubscribed, ['s1']);
  assert.equal(f.sig.size, 0, 'closing releases hint and reconnect listeners');
});

test('hints for this host and stream trigger a forward catch-up across pages; foreign or stale hints do not', async () => {
  const host = new FakeHost([{ id: 'turn/1' }]);
  const f = await open(host);
  const reads = host.reads.length;
  f.sig.hint({ sourceDeviceId: 'other', stream_id: 's1', epoch: host.epoch, cursor: 99 });
  f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's2', epoch: host.epoch, cursor: 99 });
  f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's1', epoch: host.epoch, cursor: 1 });
  await settle();
  assert.equal(host.reads.length, reads, 'no read for foreign, other-stream or already-seen hints');
  host.append({ id: 'turn/2' }); host.append({ id: 'turn/3' }); host.append({ id: 'turn/4' });
  f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's1', epoch: host.epoch, cursor: host.cursor });
  await settle();
  assert.deepEqual(f.seen.map(e => e.payload.id), ['turn/1', 'turn/2', 'turn/3', 'turn/4']);
  assert.equal(f.caughtUp, 2);
  const after = host.reads.slice(reads).map(r => r.after);
  assert.deepEqual(after, [1, 3], 'catch-up pages continue after the last delivered sequence');
  f.stream.close();
});

test('a host restart is announced as a gap before the latest page is replayed', async () => {
  const host = new FakeHost([{ id: 'turn/1' }, { id: 'turn/2' }]);
  const f = await open(host);
  host.restart([{ id: 'turn/9' }]);
  f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's1', epoch: host.epoch, cursor: 1 });
  await settle();
  assert.deepEqual(f.gaps, ['host stream restarted']);
  assert.deepEqual(f.seen.map(e => e.payload.id), ['turn/1', 'turn/2', 'turn/9']);
  assert.equal(f.history.at(-1).cursor, 1);
  // Later hints compare against the new epoch and cursor.
  const reads = host.reads.length;
  f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's1', epoch: host.epoch, cursor: 1 });
  await settle();
  assert.equal(host.reads.length, reads);
  f.stream.close();
});

test('reconnects re-read the host, are reported as resumed, and read failures retry with backoff', async () => {
  const host = new FakeHost([{ id: 'turn/1' }]);
  let failing = false;
  const f = await open(host, { fail: request => failing && request.after !== undefined ? 'RPC target unavailable' : null });
  failing = true;
  f.sig.reconnect();
  await settle();
  assert.equal(f.resumed, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].message, 'RPC target unavailable');
  failing = false;
  host.append({ id: 'turn/2' });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(f.seen.map(e => e.payload.id), ['turn/1', 'turn/2'], 'the retried catch-up delivers what was missed');
  f.stream.close();
});

test('an older host that rejects read_stream fails the open call with an upgrade message', async () => {
  const host = new FakeHost();
  await assert.rejects(open(host, { fail: () => 'invalid RPC command: unknown variant `read_stream`, expected one of ...' }),
    error => error.message === UNSUPPORTED_HOST_MESSAGE);
  assert.equal(describeHostStreamError(new Error('Could not parse device command')), UNSUPPORTED_HOST_MESSAGE);
  assert.equal(describeHostStreamError(new Error('offline')), 'offline');
});

test('wire parsing rejects malformed pages and hints and keeps remote error text', () => {
  assert.throws(() => parseStreamPage({ resp: 'error', message: 'nope' }), /nope/);
  assert.throws(() => parseStreamPage({ resp: 'pong' }), /Unexpected stream response/);
  assert.throws(() => parseStreamPage({ resp: 'stream_page', stream_id: 's', epoch: 1, events: [{ seq: 'x' }], has_more: false, cursor: 0, oldest_seq: 1 }), /Invalid stream event/);
  const page = parseStreamPage({ resp: 'stream_page', stream_id: 's', epoch: 1, events: [], has_more: false, cursor: 0, oldest_seq: 1 });
  assert.equal(page.truncated, false);
  assert.equal(parseStreamHint('d', 'other-event', { stream_id: 's', epoch: 1, cursor: 2 }), null);
  assert.equal(parseStreamHint('d', 'host-stream-changed', { stream_id: 's', epoch: '1', cursor: 2 }), null);
  assert.deepEqual(parseStreamHint('d', 'host-stream-changed', { stream_id: 's', epoch: 1, cursor: 2 }), { sourceDeviceId: 'd', stream_id: 's', epoch: 1, cursor: 2 });
});

test('loadOlder that lands on a restarted host resyncs and reports the restart', async () => {
  const host = new FakeHost([{ id: 'turn/1' }, { id: 'turn/2' }, { id: 'turn/3' }]);
  const f = await open(host);
  host.restart([{ id: 'turn/7' }]);
  await assert.rejects(f.stream.loadOlder(), /restarted/);
  assert.deepEqual(f.gaps, ['host stream restarted']);
  assert.equal(f.seen.at(-1).payload.id, 'turn/7');
  f.stream.close();
  await assert.doesNotReject(f.stream.loadOlder(), 'a closed stream answers immediately');
});
