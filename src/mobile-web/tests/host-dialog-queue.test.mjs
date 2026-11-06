import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../../shared/dialog-queue/HostDialogQueue.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { HostDialogQueue } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function fixture() {
  const records = new Map(); const calls = []; const receipts = new Map();
  let epoch = 'owner-1'; let loseResponse = false; let executions = 0;
  const storage = {
    list: async scope => [...records.values()].filter(record => record.scope === scope),
    put: async record => { records.set(record.key, structuredClone(record)); },
    remove: async key => { records.delete(key); },
  };
  const snapshot = receipt => ({sessionId:'session-a',queueEpoch:epoch,revision:executions,activeTurnId:'running',items:[...receipts.values()].filter(item=>item.status==='queued'),capacity:20,used:receipts.size,receipt});
  const invoke = async request => {
    calls.push(structuredClone(request));
    if(request.action==='submit') {
      assert.ok([...records.values()].some(record=>record.request.message?.turnId===request.message.turnId),'outbox must commit before RPC');
      if(!receipts.has(request.message.turnId)) { executions++; receipts.set(request.message.turnId,{turnId:request.message.turnId,status:'queued',displayContent:request.message.content}); }
      if(loseResponse) {loseResponse=false;throw new Error('Disconnected after host accepted');}
      return snapshot(receipts.get(request.message.turnId));
    }
    if(request.action==='get')return snapshot(receipts.get(request.turnId)??null);
    if(request.action==='cancel'||request.action==='promote') {
      if(loseResponse) {loseResponse=false;throw new Error('Connection lost');}
      return snapshot(null);
    }
    return snapshot(null);
  };
  return {storage,calls,records,receipts,invoke,create:()=>new HostDialogQueue('account/host/session-a','session-a',invoke,storage),
    lose:()=>{loseResponse=true;},restart:()=>{epoch='owner-2';receipts.clear();},get executions(){return executions;}};
}
const message={content:'continue',agentType:'Standard',attachments:[],metadata:{}};
test('a queue prepared alongside model selection sends without another list and keeps the durable outbox', async () => {
  const f = fixture();
  const queue = f.create();
  const prepared = await queue.refresh();
  await queue.submit(message, { text: 'continue' }, 'prepared-turn', prepared);
  assert.deepEqual(f.calls.map(call => call.action), ['list', 'submit']);
  assert.equal(f.calls[1].queueEpoch, prepared.queueEpoch);
  assert.equal(f.calls[1].message.turnId, 'prepared-turn');
  assert.equal(f.executions, 1);
});

test('a known host restart invalidates an already prepared submission', async () => {
  const f = fixture();
  const queue = f.create();
  const prepared = await queue.refresh();
  f.restart();
  await queue.refresh();
  await assert.rejects(queue.submit(message, {}, 'prepared-turn', prepared), /queue_scope_expired/);
  assert.equal(f.executions, 0);
  assert.equal(f.calls.some(call => call.action === 'submit'), false);
});

test('a prepared submission with an ambiguous receipt still recovers the original turn', async () => {
  const f = fixture();
  const queue = f.create();
  const prepared = await queue.refresh();
  f.lose();
  await assert.rejects(queue.submit(message, {}, 'prepared-turn', prepared));
  const reopened = f.create();
  await reopened.refresh();
  await reopened.retry(reopened.getSnapshot().pending[0]);
  assert.equal(f.executions, 1);
  assert.equal(f.calls.filter(call => call.action === 'submit').length, 1);
});
test('lost acceptance survives page recreation and queries original ID without a duplicate send',async()=>{
 const f=fixture();const first=f.create();f.lose();await assert.rejects(first.submit(message));
 const stored=[...f.records.values()][0];assert.equal(stored.accepted,undefined);
 const reopened=f.create();await reopened.refresh();await reopened.retry(reopened.getSnapshot().pending[0]);
 assert.equal(f.executions,1);assert.equal(f.calls.filter(call=>call.action==='submit').length,1);
 assert.equal(reopened.getSnapshot().pending.length,0);assert.ok(await reopened.savedDraft(stored.request.message.turnId));
});
test('an unreceived request retries with the identical payload and stable ID',async()=>{
 const f=fixture();const q=f.create();f.lose();await assert.rejects(q.submit(message));f.receipts.clear();
 const before=f.calls.find(call=>call.action==='submit');await q.submit(message);
 assert.deepEqual(f.calls.filter(call=>call.action==='submit')[1],before);
});
test('host restart never automatically replays an ambiguous message',async()=>{
 const f=fixture();const q=f.create();f.lose();await assert.rejects(q.submit(message));f.restart();
 await assert.rejects(q.retry(q.getSnapshot().pending[0]),/queue_scope_expired/);
 assert.equal(f.calls.filter(call=>call.action==='submit').length,1);assert.equal(q.getSnapshot().pending.length,1);
});
test('failed local storage prevents any submission',async()=>{
 const f=fixture();const q=new HostDialogQueue('scope','session-a',f.invoke,{...f.storage,put:async()=>{throw new Error('storage full');}});
 await assert.rejects(q.submit(message),/storage full/);assert.equal(f.executions,0);
});
test('a stale revision cannot roll back the replica',async()=>{
 let revision=4;const f=fixture();const q=new HostDialogQueue('scope','session-a',async request=>({...await f.invoke(request),revision}),f.storage);
 await q.refresh();revision=2;await q.refresh();assert.equal(q.getSnapshot().snapshot.revision,4);
});
test('promotion retry preserves operation identity and observed active turn',async()=>{
 const f=fixture();const q=f.create();await q.refresh();f.lose();await assert.rejects(q.act({turnId:'queued'},'promote'));
 const before=f.calls.find(call=>call.action==='promote');await q.retry(q.getSnapshot().pending[0]);
 assert.deepEqual(f.calls.filter(call=>call.action==='promote')[1],before);assert.equal(before.expectedActiveTurnId,'running');
});
test('outbox retry rejects a different target scope',async()=>{
 const f=fixture();const q=f.create();f.lose();await assert.rejects(q.submit(message));
 const other=new HostDialogQueue('other','session-a',f.invoke,f.storage);
 await assert.rejects(other.retry(q.getSnapshot().pending[0]),/Queue target changed/);assert.equal(f.executions,1);
});

test('accepted pending drafts become explicit recovery records after owner restart',async()=>{
 const f=fixture();const q=f.create();await q.submit(message);assert.equal(q.getSnapshot().pending.length,0);
 f.restart();await q.refresh();assert.equal(q.getSnapshot().pending.length,1);
 await assert.rejects(q.retry(q.getSnapshot().pending[0]),/queue_scope_expired/);assert.equal(f.executions,1);
});
test('terminal accepted drafts do not accumulate attachment payloads indefinitely',async()=>{
 const f=fixture();const q=f.create();await q.submit(message);assert.equal(f.records.size,1);
 for(const item of f.receipts.values())item.status='completed';await q.refresh();assert.equal(f.records.size,0);
});

test('an edit intent preserves the complete draft when cancellation succeeds but its response is lost',async()=>{
 const f=fixture();const q=f.create();const accepted=await q.submit(message,{attachments:['original attachment context']});
 const saved=await q.savedDraft(accepted.receipt.turnId);await q.prepareRestore(saved);
 f.receipts.get(accepted.receipt.turnId).status='cancelled';
 // An observer learns of cancellation before the edit caller gets a response.
 const reopened=f.create();await reopened.refresh();
 assert.equal(reopened.getSnapshot().pending.length,1);
 assert.deepEqual(reopened.getSnapshot().pending[0].draft,{attachments:['original attachment context']});
 assert.equal((await reopened.receipt(accepted.receipt.turnId)).status,'cancelled');
 assert.equal(f.calls.filter(call=>call.action==='submit').length,1);
});

test('a serialized promote keeps the turn observed at click time',async()=>{
 const f=fixture();const q=new HostDialogQueue('scope','session-a',async request=>{
  const snapshot=await f.invoke(request);
  return {...snapshot,activeTurnId:request.action==='cancel'?'new-turn':'running'};
 },f.storage);
 await q.refresh();
 const first=q.act({turnId:'a'},'cancel');const second=q.act({turnId:'b'},'promote');
 await Promise.all([first,second]);
 assert.equal(f.calls.find(call=>call.action==='promote').expectedActiveTurnId,'running');
});

function deferred() {
 let resolve, reject;
 const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
 return {promise,resolve,reject};
}

test('a live send never becomes unknown delivery, including observer refreshes before acknowledgement',async()=>{
 const f=fixture();const entered=deferred();const reply=deferred();const views=[];
 const q=new HostDialogQueue('account/host/session-a','session-a',async request=>{
  if(request.action==='submit'){entered.resolve();await reply.promise;}
  return f.invoke(request);
 },f.storage);
 q.subscribe(()=>views.push(q.getSnapshot()));
 const sending=q.submit(message);await entered.promise;
 assert.equal(f.records.size,1,'persist before waiting for the host');
 await q.refresh();await q.refresh();
 assert.ok(views.every(view=>view.pending.length===0 && view.error===null));
 // Another page has no live request and must still recover the committed outbox.
 const reopened=f.create();await reopened.refresh();
 assert.equal(reopened.getSnapshot().pending.length,1);
 reply.resolve();await sending;
 assert.ok(views.every(view=>view.pending.length===0 && view.error===null));
 assert.equal(q.getSnapshot().snapshot.items.length,1,'real host queue remains visible');
});

test('a live send becomes recoverable only when its acknowledgement fails',async()=>{
 const f=fixture();const entered=deferred();const reply=deferred();
 const q=new HostDialogQueue('account/host/session-a','session-a',async request=>{
  if(request.action==='submit'){entered.resolve();await reply.promise;}
  return f.invoke(request);
 },f.storage);
 const sending=q.submit(message);const rejected=assert.rejects(sending,/Connection lost/);
 await entered.promise;await q.refresh();assert.equal(q.getSnapshot().pending.length,0);
 reply.reject(new Error('Connection lost'));await rejected;
 assert.equal(q.getSnapshot().pending.length,1);
 assert.match(q.getSnapshot().error,/Connection lost/);
 const id=q.getSnapshot().pending[0].request.message.turnId;
 const reopened=f.create();await reopened.refresh();await reopened.retry(reopened.getSnapshot().pending[0]);
 assert.equal(f.calls.find(call=>call.action==='submit').message.turnId,id);
 assert.equal(f.executions,1);
});

test('a page without Web Crypto randomUUID still queues a send and an operation',async()=>{
 const f=fixture();const q=f.create();
 // The remote page of LAN mode is served over plain HTTP and older WebViews
 // never expose `randomUUID`, while `getRandomValues` stays available.
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');const original=globalThis.crypto;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:original.getRandomValues.bind(original)}});
 try {
  await q.submit(message);await q.act({turnId:'queued'},'promote');
 } finally {Object.defineProperty(globalThis,'crypto',descriptor);}
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 assert.match(f.calls.find(call=>call.action==='submit').message.turnId,uuid);
 assert.match(f.calls.find(call=>call.action==='promote').operationId,uuid);
 assert.equal(f.executions,1);
});

test('reorder is negotiated before any outbox or transport mutation', async () => {
  const f = fixture(); const queue = f.create(); await queue.refresh();
  await assert.rejects(queue.reorder('a', 'b'), /queue_reorder_unsupported/);
  assert.equal(f.calls.some(c => c.action === 'reorder'), false);
  assert.equal(f.records.size, 0);
});

test('an ambiguous move retries the identical operation rather than applying another move', async () => {
  const f = fixture(); let revision = 4; let ids = ['a', 'b']; let lose = true; const receipts = new Set(); const mutations = [];
  const snapshot = () => ({ sessionId: 'session-a', queueEpoch: 'owner', revision, supportsReorder: true,
    activeTurnId: 'active', items: ids.map(turnId => ({ turnId, status: 'queued', displayContent: turnId })), capacity: 20, used: 2, receipt: null });
  const queue = new HostDialogQueue('scope', 'session-a', async request => {
    if (request.action === 'reorder') {
      mutations.push(structuredClone(request));
      assert.ok([...f.records.values()].some(r => r.request.operationId === request.operationId));
      if (!receipts.has(request.operationId)) {
        assert.equal(request.expectedRevision, revision);
        receipts.add(request.operationId); ids = ['b', 'a']; revision++;
      }
      if (lose) { lose = false; throw new Error('Lost acknowledgement'); }
    }
    return snapshot();
  }, f.storage);
  await queue.refresh();
  await assert.rejects(queue.reorder('b', 'a'));
  assert.equal(queue.getSnapshot().pending.length, 1);
  await queue.retry(queue.getSnapshot().pending[0]);
  assert.deepEqual(mutations[1], mutations[0]);
  assert.equal(revision, 5);
  assert.deepEqual(queue.getSnapshot().snapshot.items.map(i => i.turnId), ['b', 'a']);
  assert.equal(queue.getSnapshot().pending.length, 0);
});

test('a stale move is explicitly rejected and is not retained for replay', async () => {
  const f = fixture(); const queue = new HostDialogQueue('scope', 'session-a', async request => {
    if (request.action === 'reorder') throw new Error('queue_conflict: queue changed');
    return { sessionId: 'session-a', queueEpoch: 'owner', revision: 1, supportsReorder: true,
      activeTurnId: null, items: [], capacity: 20, used: 0, receipt: null };
  }, f.storage);
  await queue.refresh(); await assert.rejects(queue.reorder('b', 'a'), /queue_conflict/);
  assert.equal(f.records.size, 0);
  assert.equal(queue.getSnapshot().pending.length, 0);
  assert.match(queue.getSnapshot().error, /queue_conflict/);
});
