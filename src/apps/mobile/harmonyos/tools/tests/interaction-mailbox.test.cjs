const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services', `${name}.ets`), 'utf8');
  const exports = {};
  new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(key => dependencies[key] || {}, exports);
  return exports;
}
const models = load('../model/InteractionMailbox');
const { InteractionMailboxStore } = load('InteractionMailboxStore', { '../model/InteractionMailbox': models });
const { ChatSessionController } = load('ChatSessionController', {
  './InteractionMailboxStore': { InteractionMailboxStore }, './DurableSessionReducer': load('DurableSessionReducer'),
});
const request = (id = 'approval', sessionId = 's') => ({ requestId: id, sessionId,
  toolCallId: 'tool', action: 'write', resources: ['/remote/file'], source: { identity: 'Agent' } });
const snapshot = (requests = [request()], questions = [], sessionId = 's') => ({ sessionId,
  permissions: { revision: 1, requests }, userQuestions: { revision: 1, questions } });
function fixture() {
  const f = { state: null, wire: snapshot(), calls: [], fail: false };
  f.client = {
    async getModelCatalog() { return { version: 1, models: [], default_models: {} }; },
    async hostInvoke(command, args) {
      f.calls.push({ command, args });
      if (f.fail) throw Error('offline');
      if (command === 'get_session_interaction_mailbox') return f.wire;
      f.wire = snapshot([]); return {};
    },
    async startQuestionInteraction(sessionId, toolId) { f.calls.push({ command: 'start', sessionId, toolId }); },
    async answerQuestion(toolId, answers) { f.calls.push({ command: 'answer', toolId, answers }); f.wire = snapshot([]); },
  };
  f.store = new InteractionMailboxStore(f.client, state => { f.state = state; });
  f.store.select('s');
  return f;
}
const action = (type, id = 'approval', extra = {}) => ({ sessionId: 's', type, id, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('mailbox identity preserves distinct requests sharing a tool and filters foreign questions', async () => {
  const f = fixture();
  f.wire = snapshot([request('one'), request('two'), request('foreign', 'other')], [
    { toolId: 'question', sessionId: 's', questions: {} }, { toolId: 'foreign', sessionId: 'other', questions: {} },
  ]);
  await f.store.refresh();
  assert.deepEqual(f.state.requests.map(r => r.requestId), ['one', 'two']);
  assert.deepEqual(f.state.requests[0].resources, ['/remote/file']);
  assert.equal(f.state.requests[0].action, 'write');
  assert.deepEqual(f.state.questions.map(q => q.toolId), ['question']);
});

test('tool completion cannot consume runtime approval or manufacture an active turn', async () => {
  const f = fixture(); let callbacks, mailbox, transcript;
  f.client.subscribeSession = (_id, next) => { callbacks = next; return { close() {}, wake() {} }; };
  const controller = new ChatSessionController(f.client, { canPoll: () => true,
    onSnapshot: value => { transcript = value; }, onMailbox: value => { mailbox = value; }, onError: error => { throw error; } });
  controller.start('s', { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
  await callbacks.onResumed(); await callbacks.onCaughtUp();
  await callbacks.onEvent({ session_id: 's', event: 'agentic://tool-event', payload: {
    turnId: 'turn', toolEvent: { event_type: 'Completed', tool_id: 'tool' },
  } });
  assert.deepEqual(mailbox.requests.map(r => r.requestId), ['approval']);
  assert.equal(transcript.activeTurn, undefined);
  assert.deepEqual(transcript.messageSnapshot, []);
  f.wire = snapshot([]);
  await callbacks.onEvent({ session_id: 's', event: 'session-interaction-changed', payload: {} });
  assert.deepEqual(mailbox.requests, []);
});

test('slow mailbox reads do not hold transcript catch-up or event delivery', async () => {
  for (const trigger of ['resume', 'invalidation']) {
    const f = fixture(), gate = deferred(); let callbacks, finished = false, transcript;
    f.client.hostInvoke = async () => gate.promise;
    f.client.subscribeSession = (_id, next) => { callbacks = next; return { close() {}, wake() {} }; };
    const controller = new ChatSessionController(f.client, { canPoll: () => true,
      onSnapshot: value => { transcript = value; }, onError: error => { throw error; } });
    controller.start('s', { pollVersion: 0, knownMessageCount: 0, knownModelCatalogVersion: 0 });
    const delivery = (trigger === 'resume' ? callbacks.onResumed() :
      callbacks.onEvent({ session_id: 's', event: 'session-interaction-changed', payload: {} }))
      .then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    try {
      assert.equal(finished, true, 'Mailbox RPC must not block the serial transcript stream');
      await callbacks.onCaughtUp();
      assert.ok(transcript);
    } finally {
      gate.resolve(snapshot()); await delivery; controller.stop();
    }
  }
});

test('edit approval sends request identity and object patch then refreshes authority', async () => {
  const f = fixture(); await f.store.refresh();
  await f.store.dispatch(action('approve', 'approval', { updatedInput: { path: '/new' } }));
  assert.deepEqual(f.calls[1], { command: 'respond_permission', args: {
    request: { requestId: 'approval', reply: 'once', updatedInput: { path: '/new' } },
  } });
  assert.deepEqual(f.state.requests, []); assert.equal(f.state.busy, false);
  assert.equal(f.state.ownsToolInteraction('tool'), true);
  assert.equal(f.state.ownsToolInteraction('approval'), false);
  f.store.select('another');
  assert.equal(f.state.ownsToolInteraction('tool'), false);
});

test('scalar and array edits are rejected without a remote mutation', async () => {
  for (const updatedInput of [null, [], true, 3, 'text']) {
    const f = fixture(); await f.store.refresh();
    await f.store.dispatch(action('approve', 'approval', { updatedInput }));
    assert.equal(f.calls.length, 1); assert.equal(f.state.failure, 'reply');
    assert.equal(f.state.requests.length, 1); assert.equal(f.state.busy, false);
  }
});

test('reject ignores an edited payload and duplicate taps cannot submit twice', async () => {
  const f = fixture(); await f.store.refresh(); const gate = deferred();
  const invoke = f.client.hostInvoke;
  f.client.hostInvoke = async (command, args) => { if (command === 'respond_permission') await gate.promise; return invoke(command, args); };
  const first = f.store.dispatch(action('reject', 'approval', { updatedInput: { bad: 'ignored' } }));
  await f.store.dispatch(action('approve'));
  gate.resolve(); await first;
  const replies = f.calls.filter(c => c.command === 'respond_permission');
  assert.equal(replies.length, 1); assert.equal(replies[0].args.request.reply, 'reject');
  assert.equal(replies[0].args.request.updatedInput, undefined);
});

test('reject remains available even when the approval draft is not an object', async () => {
  for (const updatedInput of [null, [], true, 3, 'unfinished draft']) {
    const f = fixture(); await f.store.refresh();
    await f.store.dispatch(action('reject', 'approval', { updatedInput }));
    const reply = f.calls.find(c => c.command === 'respond_permission');
    assert.ok(reply, 'Reject must not validate an unused approval draft');
    assert.equal(reply.args.request.reply, 'reject');
    assert.equal(reply.args.request.updatedInput, undefined);
    assert.equal(f.state.failure, '');
  }
});

test('reconnect refreshes the permission queue and stale request actions stay inert', async () => {
  const f = fixture();
  f.wire = snapshot([request('one'), request('two')]);
  await f.store.refresh();
  f.fail = true;
  await f.store.refresh();
  assert.deepEqual(f.state.requests.map(r => r.requestId), ['one', 'two']);
  // Another controller answers one request while this controller is offline.
  f.wire = snapshot([request('two')]); f.fail = false;
  await f.store.refresh();
  await f.store.dispatch(action('approve', 'one'));
  assert.equal(f.calls.filter(c => c.command === 'respond_permission').length, 0);
  await f.store.dispatch(action('reject', 'two'));
  assert.equal(f.calls.find(c => c.command === 'respond_permission').args.request.requestId, 'two');
  assert.deepEqual(f.state.requests, []);
});

test('read and reply errors retain controls and can recover through retry', async () => {
  const f = fixture(); await f.store.refresh(); f.fail = true;
  await f.store.refresh(); assert.equal(f.state.failure, 'load'); assert.equal(f.state.requests.length, 1);
  await f.store.dispatch(action('approve')); assert.equal(f.state.failure, 'reply'); assert.equal(f.state.requests.length, 1);
  f.fail = false; await f.store.dispatch(action('refresh'));
  assert.equal(f.state.failure, ''); assert.equal(f.state.requests.length, 1);
});

test('session mismatch fails visibly without replacing a known mailbox', async () => {
  const f = fixture(); await f.store.refresh(); f.wire = snapshot([], [], 'other');
  await f.store.refresh(); assert.equal(f.state.failure, 'load'); assert.equal(f.state.requests.length, 1);
});

test('invalidation during a read discards the obsolete result and coalesces a fresh read', async () => {
  const f = fixture(), gate = deferred(); let reads = 0;
  f.client.hostInvoke = async () => ++reads === 1 ? gate.promise : snapshot([request('fresh')]);
  const first = f.store.refresh(); const second = f.store.refresh();
  gate.resolve(snapshot([request('old')])); await Promise.all([first, second]);
  assert.equal(reads, 2); assert.equal(f.state.requests[0].requestId, 'fresh');
});

test('late reads and replies cannot repopulate a switched or signed-out session', async () => {
  for (const operation of ['read', 'reply']) {
    const f = fixture(); await f.store.refresh(); const gate = deferred();
    f.client.hostInvoke = async () => gate.promise;
    const running = operation === 'read' ? f.store.refresh() : f.store.dispatch(action('approve'));
    f.store.select(''); gate.resolve(snapshot()); await running;
    assert.equal(f.state.sessionId, ''); assert.deepEqual(f.state.requests, []); assert.equal(f.state.busy, false);
  }
});

test('question interaction starts once per selection and answers refresh the mailbox', async () => {
  const f = fixture(); f.wire = snapshot([], [{ toolId: 'q', sessionId: 's', questions: {} }]); await f.store.refresh();
  await f.store.dispatch(action('start_question', 'q')); await f.store.dispatch(action('start_question', 'q'));
  assert.equal(f.calls.filter(c => c.command === 'start').length, 1);
  await f.store.dispatch(action('answer', 'q', { answers: { question: 'Yes' } }));
  assert.equal(f.calls.filter(c => c.command === 'answer').length, 1); assert.deepEqual(f.state.questions, []);
  await f.store.dispatch(action('answer', 'q', { answers: {} }));
  assert.equal(f.calls.filter(c => c.command === 'answer').length, 1);
});

test('invalidation queued during a failed read still fetches the current mailbox', async () => {
  const f = fixture(); await f.store.refresh();
  let rejectRead, reads = 0;
  f.client.hostInvoke = async () => {
    reads++;
    if (reads === 1) return new Promise((_resolve, reject) => { rejectRead = reject; });
    return snapshot([request('current')]);
  };
  const pending = f.store.refresh();
  f.store.refresh();
  rejectRead(new Error('Old connection closed'));
  await pending;
  assert.equal(reads, 2);
  assert.deepEqual(f.state.requests.map(item => item.requestId), ['current']);
  assert.equal(f.state.failure, '');
});
