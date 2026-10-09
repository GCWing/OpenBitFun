const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The staged rollback is a client-only preview: entering it sends nothing to the
// host, the timeline shows ghost rows, and the composer is refilled with the
// withdrawn prompt. Gating and the three exits are frozen in
// .openbitfun/plans/mobile-copy-rollback.plan.md (decision 4) and mirrored from
// src/web-ui/src/flow_chat/services/SessionRollbackService.ts:78-140. Only the
// pure policy is covered here; the bar, the ghost rows and the wire call stay
// device-level checks.
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

const {
  RollbackEntryDenyReason,
  SessionRollbackEffectType,
  SessionRollbackEventType,
  SessionRollbackPolicy,
  SessionRollbackStage
} = load('pages/policy/SessionRollbackPolicy');

const IDLE = { stage: SessionRollbackStage.Idle };
const STAGING = { stage: SessionRollbackStage.Staging };

/** Every rollback destination is reached through the one reducer entry point. */
function reduce(state, event) {
  return SessionRollbackPolicy.reduce(state, event);
}

/** Effect types in emission order, which is the order the viewmodel applies them. */
function effectTypes(transition) {
  return transition.effects.map((effect) => effect.type);
}

function gating(overrides = {}) {
  return SessionRollbackPolicy.resolveRollbackEntry(Object.assign({
    isUserMessage: true,
    hostCapabilities: ['harness_profiles_v1', 'session_rollback_v1'],
    sessionBusy: false,
    isDispatchSession: false
  }, overrides));
}

function enterStaging(targetTurnId = 'turn-7', targetText = 'withdraw me', composerSnapshot = 'draft in progress') {
  return {
    type: SessionRollbackEventType.EnterStaging,
    targetTurnId,
    targetText,
    composerSnapshot
  };
}

test('the entry is offered for a user message on an idle session with a capable host', () => {
  assert.deepEqual(gating(), { allowed: true, reason: RollbackEntryDenyReason.None });
});

test('assistant messages are never a rollback target', () => {
  const decision = gating({ isUserMessage: false });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RollbackEntryDenyReason.NotUserMessage);
});

test('a dispatch session is denied because its history lives on the target host', () => {
  // Mirrors SessionRollbackService.ts:81-83 ("History rollback is unavailable
  // for a detached remote session").
  const decision = gating({ isDispatchSession: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RollbackEntryDenyReason.DispatchSession);
});

test('a session with a running turn is denied until it is idle', () => {
  // Mirrors SessionRollbackService.ts:53-60 (idle check before a history mutation).
  const decision = gating({ sessionBusy: true });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RollbackEntryDenyReason.SessionBusy);
});

test('a host that does not advertise session_rollback_v1 is denied', () => {
  const decision = gating({ hostCapabilities: ['harness_profiles_v1', 'dialog_steer_v1'] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, RollbackEntryDenyReason.HostUnsupported);
  assert.equal(gating({ hostCapabilities: undefined }).reason, RollbackEntryDenyReason.HostUnsupported);
  assert.equal(gating({ hostCapabilities: [] }).reason, RollbackEntryDenyReason.HostUnsupported);
});

test('the capability is matched as the exact advertised string', () => {
  assert.equal(gating({ hostCapabilities: ['session_rollback_v1'] }).allowed, true);
  // No prefix, case or suffix tolerance: a different string is a different
  // promise from the host.
  for (const capability of ['session_rollback', 'SESSION_ROLLBACK_V1', 'session_rollback_v1_extra', '']) {
    assert.equal(gating({ hostCapabilities: [capability] }).allowed, false, capability);
  }
});

test('the denial order puts the user-actionable reason first', () => {
  // A non-user message is not an entry point at all, a dispatch session cannot
  // be rolled back by anyone, a busy session just needs to finish, and only an
  // otherwise-usable session meets the host-version wall.
  assert.equal(gating({ isUserMessage: false, isDispatchSession: true, sessionBusy: true, hostCapabilities: [] }).reason,
    RollbackEntryDenyReason.NotUserMessage);
  assert.equal(gating({ isDispatchSession: true, sessionBusy: true, hostCapabilities: [] }).reason,
    RollbackEntryDenyReason.DispatchSession);
  assert.equal(gating({ sessionBusy: true, hostCapabilities: [] }).reason,
    RollbackEntryDenyReason.SessionBusy);
});

test('staging begins idle and entering it fills the composer from the target prompt', () => {
  assert.equal(SessionRollbackPolicy.initial().stage, SessionRollbackStage.Idle);
  const transition = reduce(IDLE, enterStaging());
  assert.equal(transition.state.stage, SessionRollbackStage.Staging);
  assert.equal(transition.state.targetTurnId, 'turn-7');
  assert.equal(transition.state.targetText, 'withdraw me');
  assert.deepEqual(effectTypes(transition), [
    SessionRollbackEffectType.RefillComposer,
    SessionRollbackEffectType.ShowGhostRows
  ]);
  assert.equal(transition.effects[0].text, 'withdraw me');
  assert.equal(transition.effects[1].targetTurnId, 'turn-7');
  // Entering staging is local: no wire command leaves the client.
  assert.equal(effectTypes(transition).includes(SessionRollbackEffectType.SendRollbackCommand), false);
});

test('entering staging snapshots the composer as it was before staging', () => {
  const transition = reduce(IDLE, enterStaging('turn-7', 'withdraw me', 'half-typed reply'));
  assert.equal(transition.state.composerSnapshot, 'half-typed reply');
});

test('closing staging restores the pre-staging composer and drops the ghosts', () => {
  const staging = reduce(IDLE, enterStaging('turn-7', 'withdraw me', 'half-typed reply')).state;
  const transition = reduce(staging, { type: SessionRollbackEventType.CloseStaging });
  assert.equal(transition.state.stage, SessionRollbackStage.Idle);
  assert.deepEqual(effectTypes(transition), [
    SessionRollbackEffectType.ClearGhostRows,
    SessionRollbackEffectType.RestoreComposerSnapshot
  ]);
  // The refilled prompt is not kept, so the draft goes back to what it was.
  assert.equal(transition.effects[1].text, 'half-typed reply');
});

test('closing staging entered from an empty composer restores an empty draft', () => {
  const staging = reduce(IDLE, enterStaging('turn-7', 'withdraw me', '')).state;
  const transition = reduce(staging, { type: SessionRollbackEventType.CloseStaging });
  assert.equal(transition.effects[1].text, '');
});

test('confirming keeps the edited composer text and sends the rollback command', () => {
  const staging = reduce(IDLE, enterStaging('turn-7', 'withdraw me', 'half-typed reply')).state;
  const transition = reduce(staging, { type: SessionRollbackEventType.ConfirmRollback });
  assert.equal(transition.state.stage, SessionRollbackStage.Idle);
  assert.deepEqual(effectTypes(transition), [
    SessionRollbackEffectType.SendRollbackCommand,
    SessionRollbackEffectType.ClearGhostRows,
    SessionRollbackEffectType.KeepComposerText
  ]);
  assert.equal(transition.effects[0].targetTurnId, 'turn-7');
  // Nothing rewrites the composer here: the draft stays whatever the user left.
  assert.equal(transition.effects.some((effect) => effect.type === SessionRollbackEffectType.RestoreComposerSnapshot), false);
});

test('sending while staging rolls back first, then sends the new text', () => {
  const staging = reduce(IDLE, enterStaging('turn-7', 'withdraw me', 'half-typed reply')).state;
  const transition = reduce(staging, { type: SessionRollbackEventType.SendWhileStaging, text: 'edited prompt' });
  assert.equal(transition.state.stage, SessionRollbackStage.Idle);
  // Two steps, in this order: the host must retire the turn before the new
  // message is appended to it.
  assert.deepEqual(effectTypes(transition), [
    SessionRollbackEffectType.SendRollbackCommand,
    SessionRollbackEffectType.SendMessageAfterRollback,
    SessionRollbackEffectType.ClearGhostRows
  ]);
  assert.equal(transition.effects[0].targetTurnId, 'turn-7');
  assert.equal(transition.effects[1].text, 'edited prompt');
  assert.equal(transition.effects.some((effect) => effect.type === SessionRollbackEffectType.KeepComposerText), false);
});

test('a stale view exits staging and asks for an authoritative resync', () => {
  const staging = reduce(IDLE, enterStaging()).state;
  const transition = reduce(staging, { type: SessionRollbackEventType.StaleViewDetected });
  assert.equal(transition.state.stage, SessionRollbackStage.Idle);
  assert.deepEqual(effectTypes(transition), [
    SessionRollbackEffectType.ClearGhostRows,
    SessionRollbackEffectType.ResyncTimeline
  ]);
});

test('a failed rollback exits staging, resyncs and degrades loudly', () => {
  const staging = reduce(IDLE, enterStaging()).state;
  const transition = reduce(staging, { type: SessionRollbackEventType.RollbackFailed });
  assert.equal(transition.state.stage, SessionRollbackStage.Idle);
  assert.deepEqual(effectTypes(transition), [
    SessionRollbackEffectType.ClearGhostRows,
    SessionRollbackEffectType.ResyncTimeline,
    SessionRollbackEffectType.ShowDegradeNotice
  ]);
});

test('a host outcome still matters after the exit, because confirm leaves staging first', () => {
  // Confirm and send exit staging before the host answers, so the failure and
  // the stale guard arrive in Idle and must still repair the transcript instead
  // of being swallowed.
  assert.deepEqual(effectTypes(reduce(IDLE, { type: SessionRollbackEventType.StaleViewDetected })), [
    SessionRollbackEffectType.ResyncTimeline
  ]);
  assert.deepEqual(effectTypes(reduce(IDLE, { type: SessionRollbackEventType.RollbackFailed })), [
    SessionRollbackEffectType.ResyncTimeline,
    SessionRollbackEffectType.ShowDegradeNotice
  ]);
});

test('staging twice replaces the target but keeps the first composer snapshot', () => {
  const first = reduce(IDLE, enterStaging('turn-7', 'withdraw me', 'half-typed reply')).state;
  const second = reduce(first, enterStaging('turn-3', 'earlier question', 'ignored'));
  assert.equal(second.state.stage, SessionRollbackStage.Staging);
  assert.equal(second.state.targetTurnId, 'turn-3');
  assert.equal(second.state.targetText, 'earlier question');
  // Closing must still restore the composer as it was before staging began, not
  // as it was before the second entry.
  assert.equal(second.state.composerSnapshot, 'half-typed reply');
  assert.deepEqual(effectTypes(second), [
    SessionRollbackEffectType.RefillComposer,
    SessionRollbackEffectType.ShowGhostRows
  ]);
  assert.equal(second.effects[0].text, 'earlier question');
  assert.equal(second.effects[1].targetTurnId, 'turn-3');
  assert.equal(reduce(second.state, { type: SessionRollbackEventType.CloseStaging }).effects[1].text,
    'half-typed reply');
});

test('the staging-only exits do nothing while idle', () => {
  for (const event of [
    { type: SessionRollbackEventType.CloseStaging },
    { type: SessionRollbackEventType.ConfirmRollback },
    { type: SessionRollbackEventType.SendWhileStaging, text: 'edited prompt' }
  ]) {
    const transition = reduce(IDLE, event);
    assert.equal(transition.state.stage, SessionRollbackStage.Idle, event.type);
    assert.deepEqual(effectTypes(transition), [], event.type);
  }
});

test('the reducer is pure: it never mutates the state it was handed', () => {
  const staging = reduce(IDLE, enterStaging('turn-7', 'withdraw me', 'half-typed reply')).state;
  const snapshotBefore = { ...staging };
  reduce(staging, { type: SessionRollbackEventType.CloseStaging });
  reduce(staging, { type: SessionRollbackEventType.ConfirmRollback });
  assert.deepEqual({ ...staging }, snapshotBefore);
  // An idle no-op hands back the same instance, so a busy UI cannot flicker.
  assert.equal(reduce(IDLE, { type: SessionRollbackEventType.CloseStaging }).state, IDLE);
});
