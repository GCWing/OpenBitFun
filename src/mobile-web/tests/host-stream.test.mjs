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
        // A forward catch-up can be parked so a test can queue hints behind it.
        if (request.after !== undefined && options.forwardGate) await options.forwardGate;
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
  // One turn per record: every older page shows a turn the transcript does not
  // have yet, so each request reads exactly the page it was asked for.
  const host = new FakeHost([1, 2, 3, 4, 5].map(n => ({ id: `turn/${n}`, turn: { turnId: `t${n}` } })));
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

test('one history request reads past pages of the turn already on screen', async () => {
  const host = new FakeHost([
    ...[1, 2].map(n => ({ id: `a${n}`, turn: { turnId: 't1' } })),
    ...[1, 2, 3, 4, 5, 6].map(n => ({ id: `b${n}`, turn: { turnId: 't2' } })),
  ]);
  const f = await open(host);
  assert.deepEqual(f.seen.map(e => e.payload.id), ['b5', 'b6']);
  await f.stream.loadOlder();
  // The newest pages are more of t2, the turn already on screen: one request
  // reads through them instead of reporting a load that shows nothing new.
  assert.deepEqual(host.reads.slice(1).map(read => read.before), [7, 5, 3]);
  assert.deepEqual(f.seen.map(e => e.payload.turn.turnId), ['t2', 't2', 't2', 't2', 't2', 't2', 't1', 't1']);
  assert.equal(f.history.at(-1).hasMore, false);
  f.stream.close();
});

test('a history request stops at its page budget and the next one continues', async () => {
  const host = new FakeHost([
    ...[1, 2].map(n => ({ id: `a${n}`, turn: { turnId: 't1' } })),
    ...Array.from({ length: 16 }, (_, i) => ({ id: `b${i + 1}`, turn: { turnId: 't2' } })),
  ]);
  const f = await open(host);
  await f.stream.loadOlder();
  assert.deepEqual(host.reads.slice(1).map(read => read.before), [17, 15, 13, 11]);
  assert.equal(f.seen.some(e => e.payload.turn.turnId === 't1'), false, 'the budget stops before t1 is reached');
  assert.equal(f.history.at(-1).hasMore, true);
  await f.stream.loadOlder();
  assert.deepEqual(host.reads.slice(5).map(read => read.before), [9, 7, 5, 3]);
  assert.ok(f.seen.some(e => e.payload.turn.turnId === 't1'), 'the next request continues where the budget stopped');
  assert.equal(f.history.at(-1).hasMore, false);
  f.stream.close();
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

test('a hint burst costs one catch-up and does not delay a queued history request', async t => {
  const host = new FakeHost([1, 2, 3, 4, 5].map(n => ({ id: `turn/${n}`, turn: { turnId: `t${n}` } })));
  const gate = {};
  const forwardGate = new Promise(resolve => { gate.open = resolve; });
  const f = await open(host, { forwardGate });
  t.after(() => f.stream.close());
  // A streaming host fans out one hint per event. Park the catch-up the first
  // hint starts, so the rest pile up behind it exactly as they do while a turn
  // is streaming, and queue a history request behind all of them.
  host.append({ id: 'turn/6', turn: { turnId: 't6' } });
  f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's1', epoch: host.epoch, cursor: host.cursor });
  await tick();
  for (let n = 7; n <= 10; n++) {
    host.append({ id: `turn/${n}`, turn: { turnId: `t${n}` } });
    f.sig.hint({ sourceDeviceId: 'desktop', stream_id: 's1', epoch: host.epoch, cursor: host.cursor });
  }
  await tick();
  assert.equal(host.reads.filter(read => read.after !== undefined).length, 1, 'the hints queue behind one catch-up read');

  const loading = f.stream.loadOlder();
  await tick();
  gate.open();
  await loading;
  await settle();

  const history = host.reads.findIndex(read => read.before !== undefined);
  assert.ok(history > 0, 'the request reached the host');
  // One catch-up over five new events is three pages at this page size, so the
  // history request waits for exactly those reads: the four hints that arrived
  // while it was parked merged into it and into a single later refresh.
  assert.deepEqual(host.reads.slice(0, history).filter(read => read.after !== undefined).map(read => read.after), [5, 7, 9]);
  assert.equal(host.reads[history].before, 4, 'the history request runs right after that catch-up');
  assert.deepEqual(host.reads.slice(history + 1).map(read => read.after), [10], 'the burst left one merged refresh, not one per hint');
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
  assert.throws(() => parseStreamPage({
    resp: 'stream_page', stream_id: 's', epoch: 1_758_260_000_000_000_000, events: [], has_more: false, cursor: 0, oldest_seq: 1,
  }), /Invalid stream page/, 'nanosecond host epochs are not JavaScript-safe integers');
  const nowMs = Date.now();
  assert.equal(parseStreamPage({
    resp: 'stream_page', stream_id: 's', epoch: nowMs, events: [], has_more: false, cursor: 0, oldest_seq: 1,
  }).epoch, nowMs);
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

test('formal steering turns render once with stable message ownership after history replay', async () => {
  async function load(path) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  }
  const {SessionRecordReplica} = await load('../../shared/relay-transport/SessionRecordReplica.ts');
  const {presentSessionTurn} = await load('../src/services/SessionRecordPresentation.ts');
  const turn = (id, index, content) => ({sessionId:'s1',turnId:id,turnIndex:index,status:'completed',timestamp:index,
    userMessage:{id:`user-${id}`,content,timestamp:index}});
  const first=turn('original',0,'Original request'), next=turn('steered',1,'New direction');
  const records=[
    {sessionId:'s1',id:'turn/original',revision:1,turn:first},
    {sessionId:'s1',id:'item/tool-old',revision:2,turn:first,
      round:{id:'round-old',turnId:'original',roundIndex:0},
      item:{type:'tool',data:{id:'tool-old',toolName:'Read',status:'completed',toolCall:{id:'call-old',input:{}},toolResult:{success:true,result:'old result'}}}},
    {sessionId:'s1',id:'turn/steered',revision:3,turn:next},
    {sessionId:'s1',id:'item/text-new',revision:4,turn:next,
      round:{id:'round-new',turnId:'steered',roundIndex:0},
      item:{type:'text',data:{id:'text-new',content:'New answer'}}},
  ];
  function render(events) {
    const replica=new SessionRecordReplica('s1'),turns=new Map();
    for (const record of events) {const change=replica.apply(record);if(change?.turn)turns.set(change.turnId,change.turn);}
    return [...turns.values()].sort((a,b)=>a.turnIndex-b.turnIndex).flatMap(presentSessionTurn);
  }
  const live=render(records);
  assert.deepEqual(live.filter(message=>message.role==='user').map(message=>[message.id,message.content]),
    [['user-original','Original request'],['user-steered','New direction']]);
  assert.equal(live[1].tools[0].id,'call-old');
  assert.equal(live[3].tools.length,0);
  assert.equal(live[3].content,'New answer');
  assert.deepEqual(render([...records].reverse().concat(records)),live,'newest-first reconnect and duplicate replay retain the same transcript');
});


test('streamed user turns project attachment pixels for transcript and draft restore', async () => {
  async function load(path) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  }
  const {presentSessionTurn} = await load('../src/services/SessionRecordPresentation.ts');
  const metadata = {images: [
    {id: 'img-1', name: 'screen.png', mime_type: 'image/png', data_url: ' data:image/png;base64,YQ== '},
    {id: 'img-2', name: 'path-only.png', mime_type: 'image/png'},
    null,
    {data_url: 'data:image/jpeg;base64,YWI='},
  ]};
  const [user] = presentSessionTurn({
    turnId: 'turn-a', turnIndex: 3, status: 'completed', timestamp: 1,
    userMessage: {id: 'user-a', content: '', timestamp: 1, metadata},
    modelRounds: [],
  });
  assert.deepEqual(user.images, [
    {name: 'screen.png', data_url: 'data:image/png;base64,YQ=='},
    {name: 'image', data_url: 'data:image/jpeg;base64,YWI='},
  ], 'only attachments whose pixels arrived reach the composer');
  assert.equal(user.metadata, metadata, 'protocol metadata stays intact for other projections');
  const [withoutImages] = presentSessionTurn({
    turnId: 'turn-b', turnIndex: 4, status: 'completed', timestamp: 2,
    userMessage: {id: 'user-b', content: 'hello', timestamp: 2},
    modelRounds: [],
  });
  assert.equal(withoutImages.images, undefined);
});
