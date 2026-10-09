const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The staged-rollback fixture poses as a host: it answers `rollback_session_to_turn`
// from its own transcript and records the calls it received. Both halves are data,
// so the host runner can hold them to the two facts a device screenshot cannot
// carry on its own: that the canned answer describes the transcript on screen
// (`retired_turn_ids` includes the target turn, `composer_text` is that turn's
// prompt), and that the mock host sees the rollback before the send it was staged
// with. The rendering, the system selection menu and the wire call stay
// device-level checks.
//
// Sources of truth: `.openbitfun/plans/mobile-copy-rollback.plan.md` (decision 4)
// and the production seams the fixture reuses
// (`RemoteChatCommandController.rollbackSessionToTurn` / `sendPreparedMessage`,
// `RollbackOutcomePolicy`).
const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const ENTRY_ABILITY = path.join(ROOT, 'entryability/EntryAbility.ets');
const GALLERY = path.join(ROOT, 'pages/preview/MobileDesignGallery.ets');
const cache = new Map();

/** Loads one .ets module and resolves its relative imports from the source tree. */
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const source = fs.readFileSync(path.join(ROOT, relative + '.ets'), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const exported = {};
  cache.set(relative, exported);
  new Function('require', 'exports', js)(name => {
    // System modules (@ohos.*, @kit.*) are only reached by code paths these tests do not run.
    if (!name.startsWith('.')) return {};
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, relative), '..', name)).split(path.sep).join('/');
    return load(target);
  }, exported);
  return exported;
}

const {
  RollbackPreviewScenario,
  RollbackPreviewTranscript,
  RollbackPreviewTransport,
  RollbackPreviewVariant
} = load('pages/preview/RollbackPreviewScenario');
const { RollbackFailureKind, RollbackOutcomePolicy } = load('services/RollbackOutcomePolicy');
const { SessionRollbackEventType } = load('pages/policy/SessionRollbackPolicy');

/** Every scenario id the fixture is registered under, read from the app itself. */
function registeredScenarioIds() {
  const source = fs.readFileSync(ENTRY_ABILITY, 'utf8');
  return Array.from(new Set(source.match(/scenarioId === '(copy-rollback[^']*)'/g) || []))
    .map(quoted => quoted.replace("scenarioId === '", '').replace("'", ''));
}

test('the app registers the fixture and routes it to its own pane', () => {
  const ids = registeredScenarioIds();
  assert.ok(ids.includes(RollbackPreviewScenario.DEFAULT_ID),
    'the default scenario id has to be one the ability opens');
  assert.ok(ids.length >= 8, `expected the fixture's variants to be registered, got ${ids.length}`);
  for (const id of ids) {
    assert.ok(id.indexOf('-dark') < 0 || ids.includes(id.replace('-dark', '')) ||
      id === 'copy-rollback-dark' || id === 'copy-rollback-send-dark' || id === 'copy-rollback-fail-dark',
      `${id} has no light twin`);
  }
  assert.ok(fs.readFileSync(ENTRY_ABILITY, 'utf8').includes("scenarioId === 'copy-rollback-dark'"),
    'the dark variant has to reach the launch colour mode');
  assert.ok(fs.readFileSync(GALLERY, 'utf8').includes("startsWith('copy-rollback')"),
    'the gallery must mount the fixture for the copy-rollback ids');
});

test('every registered scenario id resolves to a known variant', () => {
  const known = new Set(Object.values(RollbackPreviewVariant));
  for (const id of registeredScenarioIds()) {
    const variant = RollbackPreviewScenario.variant(id);
    assert.ok(known.has(variant), `${id} must resolve to a declared variant`);
    assert.equal(RollbackPreviewScenario.isDark(id), id.endsWith('-dark'),
      `${id} must read its colour mode off its own suffix`);
  }
});

test('the colour-mode suffix never changes what the mock host answers', () => {
  for (const id of registeredScenarioIds()) {
    if (!id.endsWith('-dark')) continue;
    assert.equal(RollbackPreviewScenario.variant(id),
      RollbackPreviewScenario.variant(id.replace('-dark', '')),
      `${id} must answer exactly as its light twin does`);
  }
});

test('an unknown id is the success cell rather than a silent refusal', () => {
  assert.equal(RollbackPreviewScenario.variant(''), RollbackPreviewVariant.Success);
  assert.equal(RollbackPreviewScenario.variant('copy-rollback-typo'), RollbackPreviewVariant.Success);
  assert.equal(RollbackPreviewScenario.baseId(''), RollbackPreviewScenario.DEFAULT_ID);
});

test('only the unsupported host withholds the rollback capability', () => {
  for (const variant of Object.values(RollbackPreviewVariant)) {
    const capabilities = RollbackPreviewScenario.hostCapabilities(variant);
    const advertises = capabilities.includes('session_rollback_v1');
    assert.equal(advertises, variant !== RollbackPreviewVariant.HostUnsupported,
      `${variant} must ${variant === RollbackPreviewVariant.HostUnsupported ? 'not ' : ''}advertise the capability`);
  }
});

test('busy is a fact about the session alone', () => {
  for (const variant of Object.values(RollbackPreviewVariant)) {
    assert.equal(RollbackPreviewScenario.sessionBusy(variant),
      variant === RollbackPreviewVariant.SessionBusy, `${variant} has the wrong busy flag`);
  }
});

test('the transcript carries the three entry shapes and their turns', () => {
  const turns = RollbackPreviewTranscript.turns();
  assert.equal(turns.length, 3, 'three turns: a short prompt, a cut prompt, a tail prompt');
  const messages = RollbackPreviewTranscript.messages();
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].turnId, turns[0].turnId);
  assert.equal(messages[2].turnId, turns[1].turnId);
  for (const message of messages) {
    assert.ok((message.turnId || '').length > 0,
      'every row needs a turn: the ghost cut is expressed in turn order');
  }
  // The second prompt is over the frozen eight-line rule, which is what makes the
  // truncated bubble and its full-text panel reachable in the fixture at all.
  const longPrompt = turns[1].prompt;
  assert.ok(longPrompt.split('\n').length > 8,
    `the cut prompt needs more than eight lines, got ${longPrompt.split('\n').length}`);
  assert.ok(RollbackPreviewTranscript.messages()[2].text === longPrompt,
    'the cut prompt must be the one the timeline draws');
});

test('the canned answer describes the transcript on screen', () => {
  const sessionId = RollbackPreviewTranscript.SESSION_ID;
  const turns = RollbackPreviewTranscript.turns();
  for (let index = 0; index < turns.length; index += 1) {
    const target = turns[index].turnId;
    const result = RollbackPreviewTranscript.cannedResponse(sessionId, target);
    assert.deepEqual(result.retiredTurnIds, turns.slice(index).map(turn => turn.turnId),
      `rolling back to ${target} must retire it and every turn after it`);
    assert.equal(result.composerText, turns[index].prompt,
      'the host hands back the prompt of the turn it retired');
    assert.equal(result.changed, true);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.restoredFiles.length, 2, 'two files, so the notice count is not a constant of the transcript');
  }
  // The rows the pane keeps after a success are exactly the rows before the cut.
  assert.deepEqual(RollbackPreviewTranscript.rowsBefore(turns[1].turnId).map(row => row.id),
    ['preview-user-1', 'preview-answer-1']);
  assert.equal(RollbackPreviewTranscript.rowsBefore('turn-nope').length,
    RollbackPreviewTranscript.messages().length,
    'a target the transcript does not contain retires nothing');
});

test('the mock host sees the rollback before the send it was staged with', async () => {
  const order = [];
  const confirm = new RollbackPreviewTransport(RollbackPreviewVariant.Success);
  order.push(confirm.order());
  await confirm.rollbackSessionToTurn(RollbackPreviewTranscript.SESSION_ID, 'turn-3');
  order.push(confirm.order());
  assert.deepEqual(order, ['(none)', 'rollback'],
    'entering the staging state and confirming it are one rollback and no send');

  const staged = new RollbackPreviewTransport(RollbackPreviewVariant.SendAccepted);
  const result = await staged.rollbackSessionToTurn(RollbackPreviewTranscript.SESSION_ID, 'turn-3');
  await staged.sendMessage(RollbackPreviewTranscript.SESSION_ID, 'edited prompt', 'code', 'preview-sent-0');
  assert.equal(staged.order(), 'rollback→send');
  assert.deepEqual(staged.calls, ['rollback:turn-3', 'send:13'],
    'the rollback precedes the send, and nothing else reaches the host');
  assert.equal(result.composerText, RollbackPreviewTranscript.LONG_PROMPT);
});

test('a refused rollback never reaches the send', async () => {
  for (const variant of [RollbackPreviewVariant.RollbackFailed, RollbackPreviewVariant.StaleTarget]) {
    const transport = new RollbackPreviewTransport(variant);
    await assert.rejects(
      () => transport.rollbackSessionToTurn(RollbackPreviewTranscript.SESSION_ID, 'turn-1'),
      'the mock host must refuse rather than answer a success');
    assert.deepEqual(transport.calls, ['rollback:turn-1'], `${variant} must not send anything`);
  }
  const sendFailure = new RollbackPreviewTransport(RollbackPreviewVariant.SendFailed);
  await sendFailure.rollbackSessionToTurn(RollbackPreviewTranscript.SESSION_ID, 'turn-1');
  await assert.rejects(() => sendFailure.sendMessage(RollbackPreviewTranscript.SESSION_ID, 'draft'),
    'the recoverable cell needs a send the host refuses');
  assert.equal(sendFailure.order(), 'rollback→send',
    'a refused send still follows a rollback the host accepted');
});

test('the fixture\'s two refusals land on the two production paths', async () => {
  // A cell that meant to exercise the quiet stale resync but threw a string the
  // production classifier reads as a failure would silently test the loud path
  // twice, so the fixture's own words are held against the classifier.
  const stale = new RollbackPreviewTransport(RollbackPreviewVariant.StaleTarget);
  const staleError = await stale.rollbackSessionToTurn(RollbackPreviewTranscript.SESSION_ID, 'turn-1')
    .then(() => null, err => err);
  assert.equal(RollbackOutcomePolicy.failureKind(staleError), RollbackFailureKind.StaleView);
  // And the stale outcome is the one the pane resyncs from without a notice.
  assert.equal(SessionRollbackEventType.StaleViewDetected, 'stale_view_detected');

  const failed = new RollbackPreviewTransport(RollbackPreviewVariant.RollbackFailed);
  const failedError = await failed.rollbackSessionToTurn(RollbackPreviewTranscript.SESSION_ID, 'turn-1')
    .then(() => null, err => err);
  assert.equal(RollbackOutcomePolicy.failureKind(failedError), RollbackFailureKind.Failed);
  assert.equal(SessionRollbackEventType.RollbackFailed, 'rollback_failed');
});

test('the fixture starts with a draft it could not have got from the prompt', () => {
  const draft = RollbackPreviewScenario.initialDraft(RollbackPreviewVariant.Success);
  assert.ok(draft.length > 0, 'closing restores a snapshot, so there has to be one to restore');
  for (const turn of RollbackPreviewTranscript.turns()) {
    assert.notEqual(draft, turn.prompt,
      'the pre-staging draft must differ from every prompt, or a screenshot cannot tell them apart');
  }
});
