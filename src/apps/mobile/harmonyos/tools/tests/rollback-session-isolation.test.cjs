const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const cache = new Map();

function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const source = fs.readFileSync(path.join(ROOT, relative + '.ets'), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  }}).outputText;
  const exported = {};
  cache.set(relative, exported);
  new Function('require', 'exports', js)(name => {
    if (name.endsWith('RemoteLogger')) return {RemoteLogger: {info() {}}};
    if (name.endsWith('Encoding')) return {Encoding: {randomId: () => 'local-turn'}};
    if (name.endsWith('RemoteI18n')) return {RemoteI18n: {t: key => key, f2: (key, a, b) => `${key}:${a}:${b}`}};
    if (name.endsWith('ConversationRuntime')) return {requireRemoteRuntime: value => value, shortSessionId: value => value};
    if (!name.startsWith('.')) return {};
    return load(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, relative)), name)));
  }, exported);
  return exported;
}

const {RemotePageState} = load('pages/state/RemotePageState');
const {RemoteTranscriptController} = load('pages/viewmodel/RemoteTranscriptController');
const {SessionRollbackEventType} = load('pages/policy/SessionRollbackPolicy');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function fixture() {
  const state = new RemotePageState();
  state.setActiveSession({sessionId: 'A', title: 'A', agentType: 'code'});
  state.connectionState = 'connected';
  state.setChatInput('A prompt');
  const rollback = deferred();
  const send = deferred();
  const voice = deferred();
  const sends = [], reloads = [], rows = [];
  const runtime = {
    chat: {rollbackSessionToTurn: () => rollback.promise,
      sendPreparedMessage: async (...args) => {sends.push(args); await send.promise;},
      reloadMessages: async id => reloads.push(id)},
    connection: {ensureAvailable: () => true},
    timeline: {appendOptimisticMessage: row => rows.push(row), setPendingActiveTurn: () => 'pending',
      snapshotState: () => ({persistedMessages: [], optimisticMessages: [], modelCatalog: {models: [], default_models: {}}, selectedModelId: ''}),
      viewState: () => []},
    polling: {startActiveSession() {}, nudge() {}}, chatCache: {forget: async () => {}},
    hooks: {isConversationContext: id => id === state.activeSession.sessionId,
      stopVoiceInput: () => voice.promise}
  };
  return {state, sends, reloads, rows, rollback, send, voice,
    controller: new RemoteTranscriptController(state, runtime, () => {}),
    result: {sessionId: 'A', retiredTurnIds: ['turn-A'], restoredFiles: ['file-A'], changed: true}};
}
function switchSession(f, id = 'B') {
  f.state.setActiveSession({sessionId: id, title: id, agentType: 'code'});
  f.state.setChatInput(`${id} draft`);
}
for (const returnToA of [false, true]) {
  for (const failed of [false, true]) {
    test(`late rollback cannot touch a replacement context (returnToA=${returnToA}, failed=${failed})`, async () => {
      const f = fixture();
      const pending = f.controller.rollbackRemoteSession({targetTurnId: 'turn-A', sendText: 'A prompt'});
      switchSession(f);
      if (returnToA) switchSession(f, 'A');
      const draft = f.state.chatInput;
      f.send.resolve();
      if (failed) f.rollback.reject(Error('rollback failed')); else f.rollback.resolve(f.result);
      await pending;
      assert.deepEqual(f.sends, []);
      assert.deepEqual(f.rows, []);
      assert.deepEqual(f.reloads, []);
      assert.equal(f.state.chatInput, draft);
      assert.equal(f.state.rollbackNotice, '');
      assert.equal(f.state.rollbackOutcome, '');
    });
  }
}
test('same-session rollback still sends to its owner and reports the result', async () => {
  const f = fixture();
  const pending = f.controller.rollbackRemoteSession({targetTurnId: 'turn-A', sendText: 'A prompt'});
  assert.deepEqual(f.sends, []);
  f.rollback.resolve(f.result);
  await Promise.resolve();
  assert.equal(f.sends[0][0], 'A');
  assert.equal(f.sends[0][1], 'A prompt');
  f.send.resolve(); await pending;
  await Promise.resolve();
  assert.match(f.state.rollbackNotice, /:1:1$/);
  assert.deepEqual(f.reloads, ['A']);
});
test('switching during the send acknowledgment cannot publish A notice into B', async () => {
  const f = fixture();
  const pending = f.controller.rollbackRemoteSession({targetTurnId: 'turn-A', sendText: 'A prompt'});
  f.rollback.resolve(f.result); await Promise.resolve();
  assert.equal(f.sends[0][0], 'A');
  switchSession(f);
  f.send.resolve(); await pending;
  assert.equal(f.state.chatInput, 'B draft');
  assert.equal(f.state.rollbackNotice, '');
  assert.deepEqual(f.reloads, []);
});
test('switching while voice input stops cannot retarget the rollback send', async () => {
  const f = fixture(); f.state.setVoiceListening(true);
  const pending = f.controller.rollbackRemoteSession({targetTurnId: 'turn-A', sendText: 'A prompt'});
  f.rollback.resolve(f.result); await Promise.resolve();
  switchSession(f);
  f.voice.resolve(); f.send.resolve(); await pending;
  assert.deepEqual(f.sends, []);
  assert.equal(f.state.chatInput, 'B draft');
  assert.equal(f.state.rollbackNotice, '');
});
test('same-session metadata refresh retains notice; session changes and clears discard it', () => {
  const f = fixture();
  f.state.setRollbackNotice('A history');
  f.state.reportRollbackOutcome(SessionRollbackEventType.RollbackFailed);
  f.state.setActiveSession({sessionId: 'A', title: 'Renamed', agentType: 'code'});
  assert.equal(f.state.rollbackNotice, 'A history');
  switchSession(f);
  assert.equal(f.state.rollbackNotice, '');
  assert.equal(f.state.rollbackOutcome, '');
  f.state.setRollbackNotice('B history'); f.state.clearActiveSession();
  assert.equal(f.state.rollbackNotice, '');
});

// Run the production state monitor without ArkUI's renderer. Native preview
// checks below cover retaining this component across compact/wide projections.
const viewSource = fs.readFileSync(path.join(ROOT, 'pages/components/ConversationView.ets'), 'utf8');
function method(name) {
  const start = viewSource.indexOf(`  ${name}(): void {`);
  assert.ok(start >= 0, `production ${name} method`);
  let depth = 1, end = viewSource.indexOf('{', start) + 1;
  const bodyStart = end;
  while (depth && end < viewSource.length) {
    if (viewSource[end] === '{') depth++;
    if (viewSource[end] === '}') depth--;
    end++;
  }
  const js = ts.transpileModule(`function monitor() {${viewSource.slice(bodyStart, end - 1)}}`,
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  return new Function('SessionRollbackEventType', `${js}; return monitor;`)(SessionRollbackEventType);
}
const monitor = method('onViewStateChanged');
test('a reused wide pane discards A staging and panels without restoring A draft into B', () => {
  const pane = {state: {surface: 'remote', activeSession: {sessionId: 'B'}, sessionContextRevision: 2, rollbackOutcomeSeq: 0, rollbackOutcome: ''},
    rollbackContextIdentity: 'remote:A:1', stagingTargetTurnId: 'turn-A', stagingTargetText: 'A prompt',
    composerSnapshot: 'A draft', handledRollbackOutcomeSeq: 3, showFullText: true, fullTextMessage: 'A text',
    fullTextTurnId: 'turn-A', showHeaderActions: true, applyRollbackEvent() {throw Error('must not restore A composer');}};
  monitor.call(pane);
  assert.equal(pane.stagingTargetTurnId, '');
  assert.equal(pane.stagingTargetText, '');
  assert.equal(pane.composerSnapshot, '');
  assert.equal(pane.showFullText, false);
  assert.equal(pane.handledRollbackOutcomeSeq, 0);
});
test('resizing a reused pane preserves staging; a new session consumes its own failures once', () => {
  const effects = [];
  const pane = {state: {surface: 'remote', activeSession: {sessionId: 'A'}, sessionContextRevision: 1, rollbackOutcomeSeq: 0},
    rollbackContextIdentity: 'remote:A:1', stagingTargetTurnId: 'turn-A', composerSnapshot: 'A draft',
    handledRollbackOutcomeSeq: 0, applyRollbackEvent: event => effects.push(event.type)};
  monitor.call(pane);
  assert.equal(pane.stagingTargetTurnId, 'turn-A');
  assert.equal(pane.composerSnapshot, 'A draft');
  pane.state = {surface: 'remote', activeSession: {sessionId: 'B'}, sessionContextRevision: 2, rollbackOutcomeSeq: 0};
  monitor.call(pane);
  pane.state.rollbackOutcomeSeq = 1;
  pane.state.rollbackOutcome = SessionRollbackEventType.RollbackFailed;
  monitor.call(pane); monitor.call(pane);
  assert.deepEqual(effects, [SessionRollbackEventType.RollbackFailed]);
});
