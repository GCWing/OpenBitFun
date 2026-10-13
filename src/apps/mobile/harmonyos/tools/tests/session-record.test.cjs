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

function turnEvent(turnId, turnIndex, revision, text, status = 'completed') {
  return { session_id: 'session', event: 'session-record', payload: {
    sessionId: 'session', id: `item/${turnId}-text`, revision,
    turn: { turnId, turnIndex, sessionId: 'session', timestamp: 1,
      userMessage: { id: `${turnId}-user`, content: 'question', timestamp: 1 }, status },
    round: { id: `${turnId}-round`, turnId, roundIndex: 0, timestamp: 2, status: 'completed' },
    item: { type: 'text', data: { id: `${turnId}-text`, content: text, orderIndex: 0, timestamp: 3 } }
  } };
}

test('an untouched turn keeps its rendered messages and a changed turn does not', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(turnEvent('turn-a', 0, 1, 'first'));
  const first = reducer.messages();
  assert.equal(first.length, 2);
  reducer.apply(turnEvent('turn-b', 1, 1, 'second'));
  const second = reducer.messages();
  assert.equal(second.length, 4);
  assert.equal(second[0], first[0], 'an untouched turn keeps its user message instance');
  assert.equal(second[1], first[1], 'an untouched turn keeps its answer instance');
  assert.notEqual(second[1], second[3]);
  reducer.apply(turnEvent('turn-a', 0, 2, 'first done'));
  const third = reducer.messages();
  assert.equal(third[1].text, 'first done');
  assert.notEqual(third[1], second[1], 'a changed turn is rendered again');
  assert.equal(third[3], second[3], 'its neighbour is still reused');
});

test('an item record repeating a parent header still refreshes its own turn', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(turnEvent('turn-a', 0, 5, 'first'));
  reducer.apply(turnEvent('turn-b', 1, 1, 'other'));
  const before = reducer.messages();
  assert.equal(before[1].items.length, 1);
  // A round or item record repeats its parent turn as a header, and that header
  // never overwrites an authoritative turn: the turn's own revision stays 5 while
  // its items move on, so the cache must count arrivals rather than revisions.
  const item = turnEvent('turn-a', 0, 6, 'second');
  item.payload.id = 'item/turn-a-tool';
  item.payload.item = { type: 'text', data: { id: 'turn-a-tool', content: 'second', orderIndex: 1, timestamp: 4 } };
  reducer.apply(item);
  const after = reducer.messages();
  assert.equal(after[1].items.length, 2, 'the new item is visible');
  assert.notEqual(after[1], before[1], 'the changed turn is rendered again');
  assert.equal(after[3], before[3], 'the untouched turn is still reused');
});

test('a dropped turn stops being cached', () => {
  const reducer = new DurableSessionReducer();
  reducer.apply(turnEvent('turn-a', 0, 1, 'first'));
  reducer.apply(turnEvent('turn-b', 1, 1, 'second'));
  assert.equal(reducer.messages().length, 4);
  reducer.apply({ session_id: 'session', event: 'session-record', payload: {
    sessionId: 'session', id: 'turn/turn-a', revision: 2, deleted: true } });
  const after = reducer.messages();
  assert.equal(after.length, 2);
  assert.equal(after[0].turnId, 'turn-b');
});


test('history publishes user and assistant together after reduction, including a concurrent model read', async () => {
  const { ChatSessionController } = load('ChatSessionController', { './DurableSessionReducer': reducerModule, './InteractionMailboxStore': mailboxModule });
  let callbacks, resolveCatalog;
  const snapshots = [];
  const manager = {
    getModelCatalog: () => new Promise(resolve => { resolveCatalog = resolve; }),
    subscribeSession: (_id, next) => { callbacks = next; return { close() {} }; }
  };
  const controller = new ChatSessionController(manager, { canPoll: () => true,
    onSnapshot: value => snapshots.push(value), onError: error => { throw error; } });
  controller.start('session', { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
  await callbacks.onCaughtUp();
  callbacks.onHistoryState(true, false);
  callbacks.onHistoryReplay(true);
  const count = snapshots.length;
  const turn = record(1, '', 'completed');
  turn.payload.id = 'turn/turn'; delete turn.payload.item; delete turn.payload.round;
  await callbacks.onEvent(turn);
  assert.equal(snapshots.length, count, 'turn header must not expose a lone user bubble');
  resolveCatalog({ version: 1, models: [], default_models: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.length, count, 'model hydration must not publish a partially reduced page');
  await callbacks.onEvent(record(2, 'complete answer', 'completed'));
  assert.equal(snapshots.length, count);
  callbacks.onHistory(false);
  callbacks.onHistoryReplay(false);
  callbacks.onHistoryState(false, false);
  assert.equal(snapshots.length, count + 1);
  assert.deepEqual(snapshots.at(-1).messageSnapshot.map(row => row.text), ['question', 'complete answer']);
  assert.equal(snapshots.at(-1).modelCatalog.version, 1);
  assert.equal(snapshots.at(-1).historyLoading, false);
  await callbacks.onEvent(record(3, 'live update', 'inprogress'));
  assert.equal(snapshots.length, count + 2, 'realtime must still publish immediately');
  controller.stop();
});

const { ChatTimelineStore } = load('ChatTimelineStore', { './RemoteUiState': load('RemoteUiState') });
async function durableTimelineHarness() {
  const timeline = new ChatTimelineStore();
  timeline.reset('session');
  let stream;
  const { ChatSessionController } = load('ChatSessionController', {
    './DurableSessionReducer': reducerModule, './InteractionMailboxStore': mailboxModule
  });
  const controller = new ChatSessionController({
    getModelCatalog: async () => ({ version: 1, models: [], default_models: {} }),
    subscribeSession: (_id, callbacks) => { stream = callbacks; return { wake() {}, close() {} }; }
  }, { onSnapshot: snapshot => timeline.applySnapshot(snapshot), canPoll: () => true,
    onError: error => { throw error; } });
  controller.start('session', { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
  await stream.onCaughtUp();
  return { timeline, stream, controller };
}
function orderedRecord(revision, id, type, order, content) {
  const event = record(revision, content, 'inprogress', id);
  event.payload.item.type = type;
  event.payload.item.data.orderIndex = order;
  if (type === 'tool') Object.assign(event.payload.item.data, {
    toolName: 'Read', toolCall: { id, input: {} }, status: 'running'
  });
  return event;
}
test('durable controller to timeline: late insertion and repeated publications are idempotent', async () => {
  const { timeline, stream } = await durableTimelineHarness();
  await stream.onEvent(orderedRecord(1, 'think', 'thinking', 0, 'reason'));
  await stream.onEvent(orderedRecord(2, 'answer', 'text', 2, 'answer'));
  await stream.onEvent(orderedRecord(3, 'tool', 'tool', 1, ''));
  for (let i = 0; i < 30; i++) {
    await stream.onCaughtUp();
    const active = timeline.snapshot().activeTurn;
    assert.deepEqual(active.items.map(item => item.type), ['thinking', 'tool', 'text']);
    assert.equal(active.items[2].content, 'answer');
  }
});
test('durable controller to timeline: authoritative corrections replace text and thinking', async () => {
  const { timeline, stream } = await durableTimelineHarness();
  await stream.onEvent(orderedRecord(1, 'think', 'thinking', 0, 'old long reasoning'));
  await stream.onEvent(orderedRecord(2, 'answer', 'text', 1, 'old long answer'));
  await stream.onEvent(orderedRecord(3, 'think', 'thinking', 0, 'new'));
  await stream.onEvent(orderedRecord(4, 'answer', 'text', 1, 'fixed'));
  const active = timeline.snapshot().activeTurn;
  assert.equal(active.text, 'fixed'); assert.equal(active.thinking, 'new');
  assert.deepEqual(active.items.map(item => item.content), ['new', 'fixed']);
});
test('durable controller to timeline: tombstones and superseded records remove visible content', async () => {
  for (const removal of ['deleted', 'superseded', 'retry_superseded']) {
    const { timeline, stream } = await durableTimelineHarness();
    const first = orderedRecord(1, 'answer', 'text', 0, 'obsolete');
    await stream.onEvent(first);
    const removed = orderedRecord(2, 'answer', 'text', 0, 'obsolete');
    if (removal === 'deleted') { removed.payload.deleted = true; delete removed.payload.item; }
    else removed.payload.item.data.status = removal;
    await stream.onEvent(removed);
    await stream.onEvent(first);
    assert.deepEqual(timeline.snapshot().activeTurn.items, [], removal);
    assert.equal(timeline.snapshot().activeTurn.text, '', removal);
  }
});
test('durable controller to timeline: gap replay discards old active content', async () => {
  const { timeline, stream } = await durableTimelineHarness();
  await stream.onEvent(record(5, 'old epoch'));
  await stream.onGap();
  await stream.onEvent(record(1, 'new epoch'));
  await stream.onCaughtUp();
  assert.equal(timeline.snapshot().activeTurn.text, 'new epoch');
  await stream.onGap(); await stream.onCaughtUp();
  assert.equal(timeline.snapshot().activeTurn, undefined);
  assert.deepEqual(timeline.snapshot().persistedMessages, []);
});
test('durable controller to timeline: completion replaces active row without carrying obsolete blocks', async () => {
  const { timeline, stream } = await durableTimelineHarness();
  await stream.onEvent(record(1, 'draft'));
  await stream.onEvent(record(2, 'final', 'completed'));
  await stream.onCaughtUp();
  assert.equal(timeline.snapshot().activeTurn, undefined);
  const assistants = timeline.snapshot().persistedMessages.filter(row => row.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, 'final'); assert.equal(assistants[0].items.length, 1);
});
test('durable snapshot retains pending local messages until their host record arrives', async () => {
  const { timeline, stream } = await durableTimelineHarness();
  timeline.appendOptimisticMessage({ id: 'local', turnId: 'turn', role: 'user', text: 'question' });
  await stream.onCaughtUp();
  assert.equal(timeline.snapshot().optimisticMessages.length, 1);
  await stream.onEvent(record(1, 'answer'));
  assert.equal(timeline.snapshot().optimisticMessages.length, 0);
  assert.equal(timeline.snapshot().persistedMessages.filter(row => row.role === 'user').length, 1);
});
test('legacy partial snapshots still preserve omitted active content', () => {
  const timeline = new ChatTimelineStore();
  timeline.reset('session');
  const active = { id: 'active-turn', turnId: 'turn', role: 'assistant', status: 'active',
    text: 'answer', items: [{ type: 'text', content: 'answer' }] };
  timeline.setActiveTurn(active);
  timeline.applySnapshot({ sessionId: 'session', cursor: {
    pollVersion: 1, knownMessageCount: 0, knownModelCatalogVersion: 0
  }, newMessages: [], activeTurn: { ...active, text: '', items: [] } });
  assert.equal(timeline.snapshot().activeTurn.text, 'answer');
  assert.deepEqual(timeline.snapshot().activeTurn.items, active.items);
});
test('host restart terminal record settles active turn without reporting successful completion', async () => {
  const { ChatSessionController } = load('ChatSessionController', { './DurableSessionReducer': reducerModule, './InteractionMailboxStore': mailboxModule });
  let stream, snapshot;
  const timeline = new ChatTimelineStore(); timeline.reset('session');
  const controller = new ChatSessionController({ getModelCatalog: async () => ({version:1,models:[],default_models:{}}),
    subscribeSession: (_id, callbacks) => { stream=callbacks; return {wake(){},close(){}}; }
  }, { onSnapshot: value => { snapshot=value; timeline.applySnapshot(value); }, canPoll:()=>true, onError:error=>{throw error;} });
  controller.start('session',{pollVersion:0,knownMessageCount:0,knownModelCatalogVersion:0});
  await stream.onEvent(record(1,'partial')); await stream.onCaughtUp();
  assert.ok(timeline.snapshot().activeTurn);
  await stream.onGap();
  await stream.onEvent(record(1,'partial','cancelled')); await stream.onCaughtUp();
  assert.equal(timeline.snapshot().activeTurn,undefined);
  assert.equal(timeline.snapshot().persistedMessages.at(-1).text,'partial');
  assert.equal(timeline.snapshot().persistedMessages.at(-1).status,'cancelled');
  assert.equal(snapshot.completedTurnId,'');
  assert.equal(snapshot.sessionState,'idle');
});
test('after host restart the same conversation sends a new turn instead of steering the dead turn', async () => {
  const { timeline, stream } = await durableTimelineHarness();
  await stream.onEvent(record(1, 'partial'));
  await stream.onGap(); await stream.onEvent(record(1, 'partial', 'cancelled')); await stream.onCaughtUp();
  const ui = load('RemoteUiState');
  const i18n = { RemoteI18n: { t: key => key } };
  const logger = { RemoteLogger: { info() {} } };
  const { RemoteChatCommandController } = load('RemoteChatCommandController', { '../i18n/RemoteI18n': i18n, './RemoteLogger': logger });
  const requests = [];
  const command = new RemoteChatCommandController({
    sendMessage: async (sessionId, text) => { requests.push([sessionId, text]); return 'new-turn'; },
    steerTurn: async () => { throw Error('Must not steer the interrupted turn'); }
  }, { onBusy(){}, onStatusText(){}, onSendSucceeded(){}, onSendFailed(error){throw Error(error);}, onPollRequested(){} }, {});
  const { RemoteTranscriptController } = load('../pages/viewmodel/RemoteTranscriptController', {
    '../../services/ChatTimelineStore': { ChatTimelineStore }, '../../services/RemoteUiState': ui,
    '../../services/RemoteLogger': logger, '../../i18n/RemoteI18n': i18n,
    '../../services/Encoding': { Encoding: { randomId: () => 'new-turn' } },
    './ConversationRuntime': { requireRemoteRuntime: value => value, shortSessionId: value => value }
  });
  const remote = { chatInput:'continue after restart', selectedImages:[], isBusy:false, isVoiceListening:false,
    connectionState:'connected', activeSession:{sessionId:'session',agentType:'code'}, activeTurnMessage:timeline.activeTurnOrEmpty(),
    supportsHostCapability:()=>true, clearRollbackNotice:()=>{} };
  const controller = new RemoteTranscriptController(remote, {
    timeline, chat:command, connection:{ensureAvailable:()=>true}, polling:{nudge(){}}, hooks:{}
  }, ()=>{});
  controller.syncRemoteTimeline = () => { remote.activeTurnMessage=timeline.activeTurnOrEmpty(); };
  controller.startRemotePolling = () => {};
  remote.connectionState = 'reconnecting';
  await controller.sendRemoteMessage();
  assert.deepEqual(requests, []);
  assert.equal(remote.chatInput, 'continue after restart');
  assert.equal(timeline.snapshot().optimisticMessages.length, 0);
  remote.connectionState = 'connected';
  await controller.sendRemoteMessage();
  assert.deepEqual(requests,[['session','continue after restart']]);
  assert.equal(timeline.snapshot().persistedMessages.at(-1).text,'partial');
});
