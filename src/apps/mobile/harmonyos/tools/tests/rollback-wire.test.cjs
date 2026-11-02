const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The rollback wire contract belongs to Rust and the phone is one more
// implementation of it, so every field name is asserted literally here instead
// of being inferred from the app's own types. Sources of truth:
//   src/crates/services/services-integrations/src/remote_connect.rs
//     560          capability string
//     2642-2643    RemoteCommand (serde tag="cmd", rename_all="snake_case")
//     2770-2775    RollbackSessionToTurn
//     2897-2898    RemoteResponse (serde tag="resp", rename_all="snake_case")
//     3012-3024    SessionRolledBack
//     1732-1753    the handler that answers the command
//   src/crates/services/services-integrations/tests/remote_connect_contracts.rs
//     2836-2890    the owner's own wire-shape contract test
const ROOT = path.join(__dirname, '../../entry/src/main/ets');
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

const { RemoteCommandFactory } = load('services/RemoteCommandFactory');
const { RemoteResponseMapper } = load('services/RemoteResponseMapper');
const { REMOTE_CAPABILITY_SESSION_ROLLBACK_V1 } = load('model/RemoteModels');

/** The command payload the owner contract test deserializes (contracts.rs:2837-2842). */
const HOST_COMMAND_WITH_GUARD = {
  cmd: 'rollback_session_to_turn',
  session_id: 'session-1',
  target_turn_id: 'turn-7',
  expected_storage_turn_index: 6
};
/** The pre-guard payload the same test accepts (contracts.rs:2844-2848). */
const HOST_COMMAND_WITHOUT_GUARD = {
  cmd: 'rollback_session_to_turn',
  session_id: 'session-1',
  target_turn_id: 'turn-7'
};

test('the rollback capability constant is the string the host broadcasts', () => {
  // remote_connect.rs:560 / remote_host_capabilities() at 564-575.
  assert.equal(REMOTE_CAPABILITY_SESSION_ROLLBACK_V1, 'session_rollback_v1');
});

test('the rollback command carries the host snake_case field names', () => {
  const command = RemoteCommandFactory.rollbackSessionToTurn('session-1', 'turn-7', 6);
  assert.deepEqual(Object.keys(command).sort(), [
    'cmd', 'expected_storage_turn_index', 'session_id', 'target_turn_id'
  ]);
  assert.deepEqual(command, HOST_COMMAND_WITH_GUARD);
});

test('the serialized command is the exact payload the host contract test parses', () => {
  const command = RemoteCommandFactory.rollbackSessionToTurn('session-1', 'turn-7', 6);
  assert.deepEqual(JSON.parse(JSON.stringify(command)), HOST_COMMAND_WITH_GUARD);
});

test('omitting the stale guard drops the field instead of sending null', () => {
  const command = RemoteCommandFactory.rollbackSessionToTurn('session-1', 'turn-7');
  // `expected_storage_turn_index: null` is not the same statement as an absent
  // guard: the host's field is an optional usize, so the client omits it.
  assert.equal('expected_storage_turn_index' in command, false);
  assert.equal(command.expected_storage_turn_index, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(command)), HOST_COMMAND_WITHOUT_GUARD);
  assert.deepEqual(Object.keys(command).sort(), ['cmd', 'session_id', 'target_turn_id']);
  assert.equal(JSON.stringify(command).includes('expected_storage_turn_index'), false);
});

test('an explicit undefined guard is treated as no guard at all', () => {
  const command = RemoteCommandFactory.rollbackSessionToTurn('session-1', 'turn-7', undefined);
  assert.equal('expected_storage_turn_index' in command, false);
  assert.deepEqual(JSON.parse(JSON.stringify(command)), HOST_COMMAND_WITHOUT_GUARD);
});

test('the rollback reply decodes the host response fields', () => {
  // remote_connect.rs:3012-3024, serialized by contracts.rs:2867-2880.
  const reply = JSON.parse(JSON.stringify({
    resp: 'session_rolled_back',
    session_id: 'session-1',
    retired_turn_ids: ['turn-8', 'turn-9'],
    restored_files: ['src/main.rs'],
    composer_text: 'original question',
    changed: true
  }));
  assert.deepEqual(RemoteResponseMapper.sessionRolledBack(reply), {
    sessionId: 'session-1',
    retiredTurnIds: ['turn-8', 'turn-9'],
    restoredFiles: ['src/main.rs'],
    composerText: 'original question',
    changed: true
  });
});

test('a reply without composer_text leaves the field absent rather than empty', () => {
  // The host skips the key when it has no prompt to offer (contracts.rs:2882-2890).
  const reply = {
    resp: 'session_rolled_back',
    session_id: 'session-1',
    retired_turn_ids: [],
    restored_files: [],
    changed: false
  };
  const decoded = RemoteResponseMapper.sessionRolledBack(reply);
  assert.equal(decoded.composerText, undefined);
  assert.equal(decoded.changed, false);
  assert.deepEqual(decoded.retiredTurnIds, []);
  assert.deepEqual(decoded.restoredFiles, []);
});

test('a reply that is not session_rolled_back is refused instead of read as an empty success', () => {
  // An older host answers an unknown command with resp: "error", and the relay
  // forwards whatever the addressed host sends. Reading a mismatched payload as
  // a successful rollback would be a fake success, so the decoder refuses it.
  for (const resp of ['ok', 'message_sent', '', undefined]) {
    assert.throws(
      () => RemoteResponseMapper.sessionRolledBack({ resp, session_id: 'session-1', changed: true }),
      /Unexpected rollback response/,
      `resp=${String(resp)}`
    );
  }
});

test('a renamed field is not read, so the snake_case names are the contract', () => {
  const reply = {
    resp: 'session_rolled_back',
    sessionId: 'session-1',
    retiredTurnIds: ['turn-8'],
    restoredFiles: ['src/main.rs'],
    composerText: 'original question',
    changed: true
  };
  const decoded = RemoteResponseMapper.sessionRolledBack(reply);
  assert.equal(decoded.sessionId, '');
  assert.deepEqual(decoded.retiredTurnIds, []);
  assert.deepEqual(decoded.restoredFiles, []);
  assert.equal(decoded.composerText, undefined);
  assert.equal(decoded.changed, true);
});
