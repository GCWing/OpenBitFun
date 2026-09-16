const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/HostCatalogObserver.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS} }).outputText;
const exported = {}; new Function('require', 'exports', js)(() => ({}), exported);
const { HostCatalogObserver } = exported;
function fixture(refresh) {
  const streams = [];
  const manager = { subscribeSession(id, callbacks) {
    assert.equal(id, '@host/catalog');
    const stream = {callbacks, closed:false, isClosed(){return this.closed;}, close(){this.closed=true;}, wake(){}};
    streams.push(stream); return stream;
  }};
  return {observer: new HostCatalogObserver(manager, refresh, error=>{throw error;}), streams};
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
