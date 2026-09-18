import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const load = (file, dependencies = {}) => {
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported = {};
  new Function('exports', 'require', code)(exported, name => dependencies[name] ?? {});
  return exported;
};
const { InvalidationSync } = load('../../shared/relay-transport/InvalidationSync.ts');
const { HOST_CATALOG_ID } = load('../../shared/relay-transport/HostStream.ts');
const { subscribeHostCatalog } = load('../src/services/HostCatalogSubscription.ts', {
  '../../../shared/relay-transport/InvalidationSync': { InvalidationSync },
  '../../../shared/relay-transport/HostStream': { HOST_CATALOG_ID },
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(read) {
  let callbacks, closed = false;
  const source = { async subscribeSessionStream(id, {onEvent: event, onError: error, onCaughtUp: caughtUp, onResumed: resumed, onGap: gap}) {
    assert.equal(id, '@host/catalog'); callbacks = {event, error, caughtUp, resumed, gap};
    return {close(){closed = true;}, wake(){}, async loadOlder(){}};
  }};
  const errors = [];
  const subscription = subscribeHostCatalog(source, read, error => errors.push(error));
  return {subscription, callbacks, errors, get closed(){return closed;}};
}
test('initial replay and reconnect each refresh once; idle wakes do not poll', async()=>{
  let reads = 0; const f = fixture(async()=>{reads++;});
  for (let i=0;i<100;i++) f.callbacks.event({event:'host-catalog-changed', payload:{sessionsRevision:i}});
  f.callbacks.resumed(); f.callbacks.caughtUp(); await tick(); assert.equal(reads,1);
  f.callbacks.caughtUp(); await tick(); assert.equal(reads,1);
  f.callbacks.resumed(); f.callbacks.event({event:'host-catalog-changed',payload:{sessionsRevision:0}});
  f.callbacks.caughtUp(); await tick(); assert.equal(reads,2);
  f.subscription.close(); assert.equal(f.closed,true);
});
test('events and foreground refresh coalesce while the directory request is pending', async()=>{
  let reads=0, release; const f=fixture(async()=>{reads++; if(reads===1) await new Promise(resolve=>{release=resolve;});});
  f.callbacks.caughtUp(); await tick();
  for(let i=0;i<50;i++) { f.callbacks.event({event:'host-catalog-changed'}); f.callbacks.caughtUp(); void f.subscription.refresh(); }
  assert.equal(reads,1); release(); await tick(); assert.equal(reads,2);
  f.subscription.close(); f.callbacks.resumed(); f.callbacks.caughtUp(); await f.subscription.refresh(); assert.equal(reads,2);
});
test('target retirement closes a late key-grant subscription and suppresses old errors', async()=>{
  let resolveGrant, closed=0, reads=0, errors=0;
  const source={ subscribeSessionStream(){ return new Promise(resolve=>{resolveGrant=resolve;}); }};
  const sub=subscribeHostCatalog(source,async()=>{reads++;},()=>{errors++;});
  sub.close(); resolveGrant({close(){closed++;},wake(){},async loadOlder(){}}); await tick();
  await sub.refresh(); assert.equal(closed,1); assert.equal(reads,0); assert.equal(errors,0);
});
test('a host restart marks the catalog dirty so the list is re-read, not trusted',async()=>{
  let reads=0; const f=fixture(async()=>{reads++;});
  f.callbacks.caughtUp(); await tick(); assert.equal(reads,1);
  f.callbacks.gap('host stream restarted'); f.callbacks.caughtUp(); await tick(); assert.equal(reads,2);
  f.subscription.close();
});
test('page uses catalog subscription without timer-based session requests',()=>{
  const page=fs.readFileSync(new URL('../src/pages/SessionListPage.tsx',import.meta.url),'utf8');
  assert.ok(page.includes('subscribeHostCatalog(sessionMgr'));
  assert.ok(page.includes('Promise.all([refreshData(), loadWorkspaceList()])'));
  assert.equal(page.includes('setInterval('),false);
});

test('foreground retry recovers a failed initial stream grant without replaying a mutation', async()=>{
  let grants=0, errors=0, closed=0;
  const source={async subscribeSessionStream(){grants++;if(grants===1)throw Error('offline');return {close(){closed++;},wake(){},async loadOlder(){}};}};
  const sub=subscribeHostCatalog(source,async()=>{},()=>{errors++;});await tick();assert.equal(errors,1);
  await sub.refresh();await tick();assert.equal(grants,2);sub.close();assert.equal(closed,1);
});
