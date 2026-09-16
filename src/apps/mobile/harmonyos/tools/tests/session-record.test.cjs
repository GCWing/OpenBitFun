const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services', `${name}.ets`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function('require', 'exports', compiled)(name => dependencies[name] || {}, exported);
  return exported;
}
const mailboxModule = load('InteractionMailboxStore', { '../model/InteractionMailbox': load('../model/InteractionMailbox') });
const reducerModule = load('DurableSessionReducer');
const { DurableSessionReducer } = reducerModule;
function record(revision, content, status = 'inprogress', itemId = 'text') {
  return { session_id: 'session', event: 'session-record', payload: {
    sessionId: 'session', id: `item/${itemId}`, revision,
    turn: { turnId: 'turn', turnIndex: 0, sessionId: 'session', timestamp: 1, userMessage: { id: 'user', content: 'question', timestamp: 1 }, status },
    round: { id: 'round', turnId: 'turn', roundIndex: 0, timestamp: 2, status: 'completed' },
    item: { type: 'text', data: { id: itemId, content, orderIndex: 0, timestamp: 3, attemptId: 'attempt-1' } }
  } };
}
test('same item identity replaces content and replay never appends a duplicate', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(record(1, 'hel'));
  reducer.apply(record(2, 'hello'));
  reducer.apply(record(1, 'hel'));
  assert.equal(reducer.messages().length, 2);
  assert.equal(reducer.messages()[1].text, 'hello');
  assert.equal(reducer.messages()[1].items.length, 1);
});
test('late older child cannot regress completed parent, while its own unseen content is retained', () => {
  const reducer = new DurableSessionReducer();
  const complete = record(10, 'done', 'completed');
  complete.payload.id = 'turn/turn'; delete complete.payload.item; delete complete.payload.round;
  reducer.apply(complete);
  reducer.apply(record(9, 'answer', 'inprogress'));
  assert.equal(reducer.messages()[1].status, 'completed');
  assert.equal(reducer.messages()[1].text, 'answer');
  assert.equal(reducer.messages()[1].renderVersion, 10);
});
test('controller hydrates from the same record log without transcript RPC', async () => {
  const { ChatSessionController } = load('ChatSessionController', { './DurableSessionReducer': reducerModule, './InteractionMailboxStore': mailboxModule });
  let callbacks, snapshots = [];
  const manager = { getModelCatalog: async () => ({ version: 1, models: [], default_models: {} }), subscribeSession: (_id, next) => { callbacks = next; return { wake() {}, close() {} }; }, getSessionMessages: () => { throw new Error('Snapshot RPC is forbidden'); } };
  const controller = new ChatSessionController(manager, { onSnapshot: value => snapshots.push(value), canPoll: () => true, onError: error => { throw error; } });
  controller.start('session', { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
  await callbacks.onEvent(record(1, 'partial'));
  assert.equal(snapshots.length, 0);
  await callbacks.onCaughtUp();
  assert.equal(snapshots[0].activeTurn.text, 'partial');
  await callbacks.onEvent(record(2, 'final', 'completed'));
  assert.equal(snapshots.at(-1).activeTurn, undefined);
  assert.equal(snapshots.at(-1).messageSnapshot.filter(row => row.role === 'assistant').length, 1);
  assert.equal(snapshots.at(-1).messageSnapshot.at(-1).text, 'final');
  controller.stop();
});
test('tombstones hide descendants and older replay cannot resurrect them', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(record(1, 'visible'));
  reducer.apply({ session_id: 'session', event: 'session-record', payload: { sessionId: 'session', id: 'turn/turn', revision: 10, deleted: true } });
  reducer.apply(record(9, 'late'));
  assert.equal(reducer.messages().length, 0);
  reducer.apply(record(11, 'restored'));
  assert.equal(reducer.messages()[1].text, 'restored');
  reducer.apply({ session_id: 'session', event: 'session-record', payload: { sessionId: 'session', id: 'item/text', revision: 12, deleted: true } });
  reducer.apply(record(11, 'cannot resurrect'));
  assert.equal(reducer.messages()[1].text, '');
});

test('command history entrypoints delegate to the same durable collection with no snapshot RPC or cache hydrate', async () => {
  const { RemoteChatCommandController } = load('RemoteChatCommandController');
  let rpc = 0, cacheReads = 0;
  const requests = [];
  const controller = new RemoteChatCommandController({ getSessionMessages: async () => { rpc++; throw Error('snapshot forbidden'); } },
    { onHistoryRequested: (id, older) => requests.push([id, older]) }, { load: async () => { cacheReads++; return []; } });
  await controller.loadMessages('s1', () => true);
  await controller.loadMessages('stale', () => false);
  await controller.reloadMessages('s1', () => true);
  await controller.loadOlderMessages('s1', 0, true, false);
  await controller.loadOlderMessages('s1', 0, true, true);
  await controller.loadOlderMessages('s1', 0, false, false);
  await controller.loadOlderMessages('', 0, true, true);
  assert.deepEqual(requests, [['s1', false], ['s1', false], ['s1', true], ['s1', true]]);
  assert.equal(rpc, 0); assert.equal(cacheReads, 0);
});

test('initial and resumed mailbox restores questions independently of transcript lifetime', async () => {
  const { ChatSessionController } = load('ChatSessionController', { './DurableSessionReducer': reducerModule, './InteractionMailboxStore': mailboxModule });
  let callbacks, snapshot, mailbox, mailboxReads = 0;
  const question = { questions: [{question:'Proceed?',options:[{label:'Yes'}]}] };
  const manager = {
    getModelCatalog: async () => ({ version: 1, models: [], default_models: {} }),
    subscribeSession: (_id, next) => { callbacks = next; return {wake(){},close(){}}; },
    hostInvoke: async (command, args) => {
      assert.equal(command, 'get_session_interaction_mailbox'); assert.equal(args.request.sessionId, 'session'); mailboxReads++;
      return {sessionId:'session',permissions:{revision:0,requests:[]},userQuestions:{revision:1,questions:[{toolId:'question-tool',sessionId:'session',questions:question,registeredAtMs:1}]}};
    }
  };
  const controller = new ChatSessionController(manager,{onSnapshot:value=>snapshot=value,onMailbox:value=>mailbox=value,onError:error=>{throw error;},canPoll:()=>true});
  controller.start('session',{pollVersion:0,knownMessageCount:0,knownModelCatalogVersion:0});
  await callbacks.onResumed(); await callbacks.onCaughtUp();
  assert.equal(snapshot.activeTurn,undefined);
  assert.equal(snapshot.cursor.knownMessageCount,0);
  assert.equal(mailbox.questions[0].toolId,'question-tool');
  assert.deepEqual(mailbox.questions[0].questions,question);
  await callbacks.onResumed(); await callbacks.onCaughtUp();
  assert.equal(mailboxReads,2); assert.equal(mailbox.questions.length,1);
  await callbacks.onEvent({session_id:'session',event:'session-interaction-changed',payload:{sessionId:'session',userQuestionsRevision:2}});
  assert.equal(mailboxReads,3); assert.equal(mailbox.questions.length,1);
});

test('restoring a turn header does not restore children older than its tombstone', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(record(1, 'deleted content'));
  reducer.apply({session_id:'session',event:'session-record',payload:{sessionId:'session',id:'turn/turn',revision:10,deleted:true}});
  const header = record(11, '');
  header.payload.id = 'turn/turn'; delete header.payload.round; delete header.payload.item;
  reducer.apply(header);
  assert.equal(reducer.messages()[1].text, '');
  reducer.apply(record(9, 'late old child', 'inprogress', 'old-child'));
  assert.equal(reducer.messages()[1].text, '');
  reducer.apply(record(12, 'new child', 'inprogress', 'new-child'));
  assert.equal(reducer.messages()[1].text, 'new child');
});

test('restoring a round with a new item does not resurrect its deleted siblings', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(record(1, 'deleted sibling'));
  reducer.apply({session_id:'session',event:'session-record',payload:{sessionId:'session',id:'round/round',revision:10,deleted:true}});
  reducer.apply(record(11, 'new sibling', 'inprogress', 'new-child'));
  assert.equal(reducer.messages()[1].text, 'new sibling');
});


test('superseded and retry-superseded text thinking and tools do not reach presentation', () => {
  for (const kind of ['text', 'thinking', 'tool']) for (const status of ['superseded', 'retry_superseded']) {
    const reducer = new DurableSessionReducer();
    const event = record(1, 'obsolete');
    event.payload.item.type = kind; event.payload.item.data.status = status;
    reducer.apply(event);
    const assistant = reducer.messages()[1];
    assert.deepEqual(assistant.items, [], `${kind}/${status}`);
    assert.equal(assistant.text, ''); assert.deepEqual(assistant.tools, []);
  }
});

test('subagent session identity works without the legacy boolean marker', () => {
  const reducer = new DurableSessionReducer();
  const event = record(1, 'child output');
  event.payload.item.data.subagentSessionId = 'child-session';
  reducer.apply(event);
  const assistant = reducer.messages()[1];
  assert.equal(assistant.items[0].is_subagent, true);
  assert.equal(assistant.text, '');
});


test('tool actions use call identity and preserve zero duration', () => {
  const reducer = new DurableSessionReducer();
  const event = record(1, '');
  event.payload.item.type = 'tool';
  Object.assign(event.payload.item.data, {
    toolName:'Read', toolCall:{id:'call-id',input:{path:'/test'}},
    toolResult:{success:true,result:'output',durationMs:9}, startTime:123, durationMs:0
  });
  reducer.apply(event);
  const tool = reducer.messages()[1].tools[0];
  assert.equal(tool.id,'call-id'); assert.equal(tool.status,'completed');
  assert.equal(tool.start_ms,123); assert.equal(tool.duration_ms,0);
});
