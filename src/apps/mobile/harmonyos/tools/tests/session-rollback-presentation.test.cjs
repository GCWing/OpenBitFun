const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// What the staged rollback looks like is decided by pure policies, away from the
// pane that draws it: which rows the local preview weakens, what the bar above the
// composer shows, which copy a refusal is said with, and which of the host's two
// refusal shapes a thrown error is. The rendering itself, the system selection
// menu item and the wire call stay device-level checks.
//
// Sources of truth: `.openbitfun/plans/mobile-copy-rollback.plan.md` (decision 4)
// and the approved artboard `artifacts/ui-drafts/copy-rollback/v2.html` (H).
const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const RESOURCES = path.join(__dirname, '../../entry/src/main/resources');
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
  RollbackEntryFacts,
  RollbackGhostRow,
  RollbackPresentationPolicy
} = load('pages/policy/RollbackPresentationPolicy');
const {
  RollbackEntryDenyReason,
  SessionRollbackEventType,
  SessionRollbackPolicy
} = load('pages/policy/SessionRollbackPolicy');
const { RollbackFailureKind, RollbackOutcomePolicy } = load('services/RollbackOutcomePolicy');
const { UserMessageMenuPolicy, UserMessageMenuAction } = load('pages/policy/UserMessageMenuPolicy');

/** One timeline row as the pane derives it: render key plus the row's turn. */
function row(key, turnId) {
  return new RollbackGhostRow(key, turnId);
}

/** The transcript of the frozen example: two user turns, each with an answer. */
function timeline() {
  return [
    row('user_message:m1', 'turn-1'),
    row('assistant_turn:turn-1', 'turn-1'),
    row('user_message:m2', 'turn-3'),
    row('assistant_turn:turn-3', 'turn-3'),
    row('user_message:m3', 'turn-5')
  ];
}

function catalog(locale) {
  const source = fs.readFileSync(path.join(RESOURCES, locale, 'element/string.json'), 'utf8');
  const values = new Map();
  for (const entry of JSON.parse(source).string) {
    values.set(entry.name, entry.value);
  }
  return values;
}

/* --------------------------------------------------------------- the bar */

test('the bar exists only while a rollback is staged', () => {
  const idle = RollbackPresentationPolicy.bar(SessionRollbackPolicy.initial());
  assert.equal(idle.visible, false);
  // An idle bar has no payload at all, so a stale preview cannot leak into the
  // next staging through a value nobody cleared.
  assert.equal(idle.preview, '');

  const staging = SessionRollbackPolicy.reduce(SessionRollbackPolicy.initial(), {
    type: SessionRollbackEventType.EnterStaging,
    targetTurnId: 'turn-3',
    targetText: 'withdraw me',
    composerSnapshot: ''
  }).state;
  const bar = RollbackPresentationPolicy.bar(staging);
  assert.equal(bar.visible, true);
  assert.equal(bar.titleKey, RollbackPresentationPolicy.ROLLBACK_TO_KEY);
  assert.equal(bar.preview, 'withdraw me');
});

test('the bar preview is one line, because the layout is what ellipsizes it', () => {
  const staging = SessionRollbackPolicy.reduce(SessionRollbackPolicy.initial(), {
    type: SessionRollbackEventType.EnterStaging,
    targetTurnId: 'turn-3',
    targetText: 'first line\n\n   second   line\tthird',
    composerSnapshot: ''
  }).state;
  assert.equal(RollbackPresentationPolicy.bar(staging).preview, 'first line second line third');
});

test('a staged rollback with no prompt still has a bar and no preview', () => {
  const staging = SessionRollbackPolicy.reduce(SessionRollbackPolicy.initial(), {
    type: SessionRollbackEventType.EnterStaging,
    targetTurnId: 'turn-3',
    targetText: '   ',
    composerSnapshot: ''
  }).state;
  const bar = RollbackPresentationPolicy.bar(staging);
  assert.equal(bar.visible, true, 'the exit controls exist even for an empty prompt');
  assert.equal(bar.preview, '');
});

/* ---------------------------------------------------------- ghost rows */

test('the ghost preview covers the target turn and every row after it', () => {
  assert.deepEqual(
    RollbackPresentationPolicy.ghostRowKeys(timeline(), 'turn-3'),
    ['user_message:m2', 'assistant_turn:turn-3', 'user_message:m3']
  );
});

test('the last turn ghosts only itself, and the first turn ghosts the transcript', () => {
  assert.deepEqual(RollbackPresentationPolicy.ghostRowKeys(timeline(), 'turn-5'), ['user_message:m3']);
  assert.deepEqual(
    RollbackPresentationPolicy.ghostRowKeys(timeline(), 'turn-1'),
    ['user_message:m1', 'assistant_turn:turn-1', 'user_message:m2', 'assistant_turn:turn-3', 'user_message:m3']
  );
});

test('a target this timeline does not contain ghosts nothing instead of everything', () => {
  // A transcript that already moved on must not be grayed from an arbitrary
  // point: the cut is only meaningful where the target actually is.
  assert.deepEqual(RollbackPresentationPolicy.ghostRowKeys(timeline(), 'turn-9'), []);
  assert.deepEqual(RollbackPresentationPolicy.ghostRowKeys(timeline(), ''), []);
  assert.deepEqual(RollbackPresentationPolicy.ghostRowKeys(timeline(), '   '), []);
  assert.deepEqual(RollbackPresentationPolicy.ghostRowKeys([], 'turn-1'), []);
});

test('rows that carry no turn of their own are ghosted by position, not by turn', () => {
  // A live assistant row and a row with no message have no turn id; what places
  // them inside or outside the preview is their position in the list.
  const rows = [
    row('user_message:m1', 'turn-1'),
    row('assistant_live_turn:active', ''),
    row('user_message:m2', 'turn-3')
  ];
  assert.deepEqual(RollbackPresentationPolicy.ghostRowKeys(rows, 'turn-3'), ['user_message:m2']);
  assert.deepEqual(
    RollbackPresentationPolicy.ghostRowKeys(rows, 'turn-1'),
    ['user_message:m1', 'assistant_live_turn:active', 'user_message:m2']
  );
});

/* ------------------------------------------------------------- refusals */

test('each denial reason is answered with the copy for that reason', () => {
  const keys = {
    [RollbackEntryDenyReason.HostUnsupported]: RollbackPresentationPolicy.UNSUPPORTED_KEY,
    [RollbackEntryDenyReason.SessionBusy]: RollbackPresentationPolicy.SESSION_BUSY_KEY,
    [RollbackEntryDenyReason.DispatchSession]: RollbackPresentationPolicy.DISPATCH_DENIED_KEY
  };
  for (const [reason, key] of Object.entries(keys)) {
    assert.equal(RollbackPresentationPolicy.denyMessageKey(reason), key, reason);
  }
});

test('the two combinations no entry surface can produce still say something', () => {
  // `none` is an allowed entry and `not_user_message` cannot be raised by an
  // entry that only exists on a user message. Both fall back to the loud failure
  // copy rather than to silence, so an unreachable path is still audible.
  assert.equal(RollbackPresentationPolicy.denyMessageKey(RollbackEntryDenyReason.None),
    RollbackPresentationPolicy.FAILED_KEY);
  assert.equal(RollbackPresentationPolicy.denyMessageKey(RollbackEntryDenyReason.NotUserMessage),
    RollbackPresentationPolicy.FAILED_KEY);
});

test('the tap gate judges the session as it is now, not as the row was drawn', () => {
  const capable = ['harness_profiles_v1', 'session_rollback_v1'];
  assert.equal(new RollbackEntryFacts(capable, false, false).resolve().allowed, true);
  assert.equal(new RollbackEntryFacts(capable, true, false).resolve().reason,
    RollbackEntryDenyReason.SessionBusy);
  assert.equal(new RollbackEntryFacts([], false, false).resolve().reason,
    RollbackEntryDenyReason.HostUnsupported);
  // The local General Chat pane has no host behind it at all.
  assert.equal(RollbackEntryFacts.none().resolve().reason, RollbackEntryDenyReason.HostUnsupported);
});

/* --------------------------------------------------------- host outcomes */

test('the host catalog marks a moved-on target as stale and everything else as failed', () => {
  // The three markers are the host's own words for the one case that is repaired
  // quietly (coordinator.rs:8760/8768/8773).
  for (const message of [
    'Session rollback target is stale',
    'Session rollback target storage identity is stale',
    'Session rollback target was not found',
    'request failed: session rollback target is stale'
  ]) {
    assert.equal(RollbackOutcomePolicy.failureKind(new Error(message)), RollbackFailureKind.StaleView, message);
  }
});

test('an unclassified refusal stays a failure instead of a silent resync', () => {
  for (const message of [
    'Rollback is unsupported for remote workspaces',
    'Session is busy',
    'transport closed',
    ''
  ]) {
    assert.equal(RollbackOutcomePolicy.failureKind(new Error(message)), RollbackFailureKind.Failed, message);
  }
  // A rejection that is not an Error at all is still reported, not swallowed.
  assert.equal(RollbackOutcomePolicy.failureKind('boom'), RollbackFailureKind.Failed);
  assert.equal(RollbackOutcomePolicy.messageOf(new Error('boom')), 'boom');
  assert.equal(RollbackOutcomePolicy.messageOf({ code: 7 }), '{"code":7}');
});

/* ---------------------------------------------------------------- copy */

test('this package adds its rollback copy to every locale catalog', () => {
  const expected = {
    chat_rollbackTo: { en_US: 'Roll back to', zh_CN: '回滚到' },
    chat_rollbackItem: { en_US: 'Roll back to this message', zh_CN: '回滚到此消息' },
    chat_rolledBackNotice: {
      en_US: 'Rolled back %1$s messages · %2$s files restored',
      zh_CN: '已回滚 %1$s 条消息 · %2$s 个文件已还原'
    },
    chat_rollbackUnsupported: {
      en_US: 'This host version does not support rollback',
      zh_CN: '当前 host 版本不支持回滚'
    },
    chat_rollbackSessionBusy: { en_US: 'Session is busy, try again later', zh_CN: '会话进行中，稍后再试' },
    chat_rollbackDispatchDenied: {
      en_US: 'Rollback is not supported for this session',
      zh_CN: '此类会话不支持回滚'
    },
    chat_rollbackFailed: { en_US: 'Rollback failed, try again', zh_CN: '回滚失败，请重试' }
  };
  for (const [name, values] of Object.entries(expected)) {
    for (const [locale, value] of Object.entries(values)) {
      assert.equal(catalog(locale).get(name), value, `${name} in ${locale}`);
    }
  }
});

test('every key this package asks for resolves to a resource, in both locales', () => {
  const keys = [
    RollbackPresentationPolicy.ROLLBACK_TO_KEY,
    RollbackPresentationPolicy.ROLLBACK_ITEM_KEY,
    RollbackPresentationPolicy.ROLLED_BACK_NOTICE_KEY,
    RollbackPresentationPolicy.UNSUPPORTED_KEY,
    RollbackPresentationPolicy.SESSION_BUSY_KEY,
    RollbackPresentationPolicy.DISPATCH_DENIED_KEY,
    RollbackPresentationPolicy.FAILED_KEY
  ];
  // The selection-menu item and the truncated bubble's item are the same key, so
  // one rename is one missed surface.
  assert.equal(UserMessageMenuPolicy.items()
    .filter((item) => item.action === UserMessageMenuAction.RollbackToMessage)[0].labelKey,
    RollbackPresentationPolicy.ROLLBACK_ITEM_KEY);
  for (const locale of ['en_US', 'zh_CN']) {
    const values = catalog(locale);
    for (const key of keys) {
      const resourceName = key.replace(/\./g, '_');
      assert.equal(values.has(resourceName), true, `${resourceName} in ${locale}`);
      assert.ok(values.get(resourceName).length > 0, `${resourceName} in ${locale} is empty`);
    }
  }
});

test('the only templated rollback copy is the notice, and it takes both counts', () => {
  for (const locale of ['en_US', 'zh_CN']) {
    const notice = catalog(locale).get('chat_rolledBackNotice');
    assert.ok(notice.includes('%1$s'), `${locale} notice counts the messages`);
    assert.ok(notice.includes('%2$s'), `${locale} notice counts the restored files`);
    for (const name of ['chat_rollbackTo', 'chat_rollbackItem', 'chat_rollbackUnsupported',
      'chat_rollbackSessionBusy', 'chat_rollbackDispatchDenied', 'chat_rollbackFailed']) {
      assert.equal(catalog(locale).get(name).includes('%'), false, `${name} in ${locale} is not templated`);
    }
  }
});

test('the two locale catalogs stay in key lockstep', () => {
  assert.equal(catalog('en_US').size, catalog('zh_CN').size);
});
