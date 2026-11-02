const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/HostCatalogObserver.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS} }).outputText;
const exported = {}; new Function('require', 'exports', js)(() => ({ HOST_CATALOG_ID: '@host/catalog' }), exported);
const { HostCatalogObserver } = exported;
function deferred() {
  let resolve;
  const promise = new Promise(yes => {resolve = yes;});
  return {promise, resolve};
}
function fixture(refresh, onError = error=>{throw error;}) {
  const streams = [];
  const manager = { subscribeSession(id, callbacks) {
    assert.equal(id, '@host/catalog');
    const stream = {callbacks, closed:false, isClosed(){return this.closed;}, close(){this.closed=true;}, wake(){}};
    streams.push(stream); return stream;
  }};
  return {observer: new HostCatalogObserver(manager, refresh, onError), streams};
}
test('host catalog bursts coalesce, reconnect resets invalidation and unchanged wakes do not poll', async()=>{
  let reads=0; const f=fixture(async()=>{reads++;}); f.observer.start('host');
  const c=f.streams[0].callbacks;
  for(let i=0;i<100;i++) await c.onEvent({event:'host-catalog-changed',payload:{sessionsRevision:i}});
  await c.onResumed(); await c.onCaughtUp(); assert.equal(reads,1);
  await c.onCaughtUp(); assert.equal(reads,1);
  await c.onResumed(); await c.onCaughtUp(); assert.equal(reads,2);
  f.observer.start('host'); await Promise.resolve(); assert.equal(f.streams.length,1); assert.equal(reads,2);
});
test('a session refresh can ensure catalog observation without scheduling itself again', async()=>{
  let reads=0;
  const f=fixture(async()=>{reads++; if(reads<5) f.observer.start('host');});
  f.observer.start('host');
  await f.streams[0].callbacks.onCaughtUp();
  assert.equal(reads,1);
  await f.streams[0].callbacks.onEvent({event:'host-catalog-changed'});
  await f.streams[0].callbacks.onCaughtUp();
  assert.equal(reads,2);
});
test('switching runtime closes old catalog and ignores late old callbacks', async()=>{
  let reads=0; const f=fixture(async()=>{reads++;}); f.observer.start('a'); const old=f.streams[0];
  f.observer.start('b'); assert.equal(old.closed,true);
  await old.callbacks.onEvent({event:'host-catalog-changed'}); await old.callbacks.onCaughtUp(); assert.equal(reads,0);
  await f.streams[1].callbacks.onCaughtUp(); assert.equal(reads,1);
  f.observer.stop(); await f.streams[1].callbacks.onResumed(); await f.streams[1].callbacks.onCaughtUp(); assert.equal(reads,1);
});
test('revision hints select the affected catalog and duplicate revisions are ignored', async()=>{
  const changes=[]; const f=fixture(async change=>{changes.push(change);}); f.observer.start('host');
  await f.streams[0].callbacks.onCaughtUp();
  assert.deepEqual(changes, [{initial:true}]);
  f.observer.lastRefreshAt=Date.now()-3000;
  await f.streams[0].callbacks.onEvent({event:'host-catalog-changed',payload:{sessionsRevision:4,workspacesRevision:8}});
  await f.streams[0].callbacks.onCaughtUp();
  assert.deepEqual(changes.at(-1), {sessionsRevision:4,workspacesRevision:8});
  f.observer.lastRefreshAt=Date.now()-3000;
  await f.streams[0].callbacks.onEvent({event:'host-catalog-changed',payload:{sessionsRevision:4,workspacesRevision:9}});
  await f.streams[0].callbacks.onCaughtUp();
  assert.deepEqual(changes.at(-1), {workspacesRevision:9});
});

test('a failed refresh retains invalidation for the next caught-up callback', async()=>{
  let attempts=0; const errors=[];
  const f=fixture(async()=>{ if(++attempts===1) throw new Error('offline'); }, e=>errors.push(e));
  f.observer.start('host'); const c=f.streams[0].callbacks;
  await assert.rejects(c.onCaughtUp(), /offline/);
  f.observer.lastRefreshAt=Date.now()-3000;
  await c.onCaughtUp(); assert.equal(attempts,2);
  await c.onCaughtUp(); assert.equal(attempts,2);
});
test('legacy hints survive coalescing with revision hints', async()=>{
  const changes=[]; const f=fixture(async c=>changes.push(c));
  f.observer.start('host'); const c=f.streams[0].callbacks;
  await c.onCaughtUp(); f.observer.lastRefreshAt=Date.now()-3000;
  await c.onEvent({event:'host-catalog-changed'});
  await c.onEvent({event:'host-catalog-changed',payload:{sessionsRevision:1}});
  await c.onCaughtUp(); assert.equal(changes.at(-1).initial,true);
});

test('a new target owns its refresh and errors while the old refresh is pending', async () => {
  const old = deferred(); let attempts = 0;
  const f = fixture(async () => {
    if (++attempts === 1) return old.promise;
    throw Error('New target unavailable');
  });
  f.observer.start('a');
  const oldRefresh = f.streams[0].callbacks.onCaughtUp();
  f.observer.start('b');
  try {
    await assert.rejects(f.streams[1].callbacks.onCaughtUp(), /New target unavailable/);
    const newRefreshAt = f.observer.lastRefreshAt;
    old.resolve(); await oldRefresh;
    assert.equal(f.observer.lastRefreshAt, newRefreshAt, 'old completion cannot change the new target pacing');
  } finally {
    f.observer.stop(); old.resolve(); await oldRefresh;
  }
});
