const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}
  }).outputText;
  const exported = {};
  new Function('require', 'exports', js)(() => ({}), exported);
  return exported;
}

const {
  CommandPalettePolicy: Policy,
  CommandPaletteAvailability,
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteNoticeKind
} = load('entry/src/main/ets/services/CommandPalettePolicy.ets');

// A session with the probe answered and nothing running: the row's baseline.
function available(overrides = {}) {
  return new CommandPaletteAvailability(
    overrides.probeReady ?? true,
    overrides.hasSession ?? true,
    overrides.isBusy ?? false,
    overrides.runningCommand ?? '',
    overrides.goalPending ?? false
  );
}

function chip(policyChips, kind) {
  const found = policyChips.find((entry) => entry.kind === kind);
  assert.ok(found, `the row must always carry the ${kind} chip`);
  return found;
}

test('an answered probe enables the verbs and keeps the skills chip opening', () => {
  const chips = Policy.chips(available());
  for (const kind of [CommandPaletteChipKind.Compact, CommandPaletteChipKind.Init,
    CommandPaletteChipKind.Usage, CommandPaletteChipKind.Skills]) {
    assert.equal(chip(chips, kind).state, CommandPaletteChipState.Ready, `${kind} must be ready`);
    assert.equal(chip(chips, kind).runsAction, true, `${kind} must reach the host`);
    assert.equal(chip(chips, kind).badgeKey, '', `${kind} must not carry the upgrade badge`);
    assert.equal(chip(chips, kind).reasonKey, '', `${kind} owes the user no reason`);
  }
  assert.equal(chip(chips, CommandPaletteChipKind.Skills).showsChevron, true,
    'only the skills chip opens a surface, which is what its chevron says');
  assert.equal(Policy.rowReasonKey(available()), '',
    'a healthy row must not explain itself');
});

test('a refused probe degrades the row and badges it as needing an upgrade', () => {
  // The probe is the skill catalog read; a host that will not serve it will not
  // serve the verbs either. The row stays on screen and stays explainable.
  const state = available({probeReady: false, runningCommand: ''});
  const chips = Policy.chips(state);
  for (const kind of [CommandPaletteChipKind.Compact, CommandPaletteChipKind.Init,
    CommandPaletteChipKind.Usage]) {
    assert.equal(chip(chips, kind).state, CommandPaletteChipState.Dimmed, `${kind} must grey out`);
    assert.equal(chip(chips, kind).runsAction, false, `${kind} must not reach the host`);
    assert.equal(chip(chips, kind).badgeKey, Policy.upgradeBadgeKey, `${kind} must carry the badge`);
    assert.equal(chip(chips, kind).reasonKey, Policy.degradedReasonKey, `${kind} must carry the reason`);
  }
  // The picker is where the reason, the host's own text and the re-check live, so
  // its chip is the one control that keeps working on a degraded row.
  const skills = chip(chips, CommandPaletteChipKind.Skills);
  assert.equal(skills.state, CommandPaletteChipState.Dimmed, 'the skills chip still reads grey');
  assert.equal(skills.runsAction, true, 'the skills chip must still open the picker');
  assert.equal(skills.badgeKey, Policy.upgradeBadgeKey, 'the skills chip carries the same badge');
  assert.equal(Policy.rowReasonKey(state), Policy.degradedReasonKey,
    'the row must say why it is grey');
});

test('a greyed chip still explains itself when tapped', () => {
  // "Nothing happened" is not an answer: every chip that cannot run has to carry
  // the sentence the row shows for it.
  const degraded = Policy.chips(available({probeReady: false}));
  const busy = Policy.chips(available({isBusy: true}));
  const sessionless = Policy.chips(available({hasSession: false}));
  for (const chips of [degraded, busy, sessionless]) {
    for (const entry of chips) {
      if (entry.runsAction) {
        continue;
      }
      assert.notEqual(entry.reasonKey, '', `${entry.kind} must explain why it cannot run`);
    }
  }
});

test('a busy session gates the verbs but never the draft', () => {
  // Compact, init and usage all act on the host's session, so a running turn
  // holds them back. Picking a skill only edits the draft, and the goal chip
  // writes `/goal ` locally, so neither waits for the session.
  const chips = Policy.chips(available({isBusy: true}));
  for (const kind of [CommandPaletteChipKind.Compact, CommandPaletteChipKind.Init,
    CommandPaletteChipKind.Usage]) {
    assert.equal(chip(chips, kind).state, CommandPaletteChipState.Dimmed, `${kind} must wait`);
    assert.equal(chip(chips, kind).runsAction, false, `${kind} must not start while busy`);
    assert.equal(chip(chips, kind).reasonKey, Policy.busyReasonKey, `${kind} must say the session is busy`);
    assert.equal(chip(chips, kind).badgeKey, '', 'busy is not a version problem');
  }
  assert.equal(chip(chips, CommandPaletteChipKind.Skills).runsAction, true,
    'picking a skill must stay available while the host is busy');
  assert.equal(chip(chips, CommandPaletteChipKind.Goal).runsAction, true,
    'the goal prefill is local and must stay available while the host is busy');
  assert.equal(Policy.rowReasonKey(available({isBusy: true})), '',
    'a busy single chip is not a degraded row');
});

test('a verb in flight owns its chip and holds the others back', () => {
  // One palette verb at a time: the host would otherwise act on a context the
  // user has not seen the result of yet.
  const chips = Policy.chips(available({runningCommand: Policy.compactWireAction}));
  const compact = chip(chips, CommandPaletteChipKind.Compact);
  assert.equal(compact.state, CommandPaletteChipState.InFlight, 'the running chip shows its spinner');
  assert.equal(compact.runsAction, false, 'a running verb must not be tapped again');
  assert.equal(compact.reasonKey, '', 'an in-flight chip is not a refusal');
  for (const kind of [CommandPaletteChipKind.Init, CommandPaletteChipKind.Usage]) {
    assert.equal(chip(chips, kind).state, CommandPaletteChipState.Dimmed, `${kind} must wait its turn`);
    assert.equal(chip(chips, kind).reasonKey, Policy.busyReasonKey, `${kind} must say why it waits`);
  }
  assert.equal(chip(chips, CommandPaletteChipKind.Skills).runsAction, true,
    'the picker does not collide with a running verb');
});

test('the goal chip is not gated by the probe or by a capability', () => {
  // `/goal <objective>` is plain message text the desktop already parses on its
  // send path, so this chip is honest about working on a host whose verbs this
  // app cannot call. It is the one chip that stays lit on a degraded row.
  const degraded = Policy.chips(available({probeReady: false}));
  const goal = chip(degraded, CommandPaletteChipKind.Goal);
  assert.equal(goal.state, CommandPaletteChipState.Ready, 'the goal chip must stay lit');
  assert.equal(goal.runsAction, true, 'the goal chip must still toggle its prefill');
  assert.equal(goal.badgeKey, '', 'a goal is not a version problem');
  assert.equal(goal.reasonKey, '', 'the goal chip owes no reason');

  const pending = chip(Policy.chips(available({goalPending: true})), CommandPaletteChipKind.Goal);
  assert.equal(pending.state, CommandPaletteChipState.Pending, 'a prefilled goal reads as pending');
  assert.equal(pending.runsAction, true, 'a pending goal must be tappable to take the prefill back');
});

test('the row needs a session and hides itself without one', () => {
  const state = available({hasSession: false});
  assert.equal(Policy.visible(false), false, 'the row cannot act on a conversation that is not open');
  assert.equal(Policy.visible(true), true);
  for (const entry of Policy.chips(state)) {
    assert.equal(entry.state, CommandPaletteChipState.Dimmed, `${entry.kind} must wait for a session`);
    assert.equal(entry.runsAction, false, `${entry.kind} must not act without a session`);
    assert.equal(entry.reasonKey, Policy.sessionReasonKey(), `${entry.kind} must ask for a session`);
  }
  assert.equal(Policy.rowReasonKey(state), Policy.sessionReasonKey());
});

test('only a settled failure earns a retry, and only for a runnable verb', () => {
  assert.equal(Policy.canRetry(CommandPaletteNoticeKind.Failed, Policy.compactWireAction), true);
  assert.equal(Policy.canRetry(CommandPaletteNoticeKind.Failed, Policy.initWireAction), true);
  assert.equal(Policy.canRetry(CommandPaletteNoticeKind.Failed, ''), false,
    'a failed chip with no verb has nothing to repeat');
  assert.equal(Policy.canRetry(CommandPaletteNoticeKind.Failed, 'goal'), false,
    'the retry affordance repeats a host verb, not a draft edit');
  assert.equal(Policy.canRetry(CommandPaletteNoticeKind.Done, Policy.compactWireAction), false,
    'a completion line is not an error to retry');
  assert.equal(Policy.canRetry(CommandPaletteNoticeKind.Busy, Policy.compactWireAction), false);
});

test('each verb has its own in-flight, completion and failure line', () => {
  const compact = Policy.compactWireAction;
  const init = Policy.initWireAction;
  for (const [wireAction, suffix] of [[compact, 'compact'], [init, 'init']]) {
    assert.equal(Policy.busyNoticeKey(wireAction), `commands.${suffix}Running`);
    assert.equal(Policy.doneNoticeKey(wireAction), `commands.${suffix}Done`);
    assert.equal(Policy.failedNoticeKey(wireAction), `commands.${suffix}Failed`);
  }
  assert.notEqual(Policy.busyNoticeKey(compact), Policy.busyNoticeKey(init),
    'two verbs must not share one line');
  assert.equal(Policy.isRunnable(compact), true);
  assert.equal(Policy.isRunnable(init), true);
  assert.equal(Policy.isRunnable('goal'), false, 'a draft edit is not a host verb');
  assert.equal(Policy.wireAction(CommandPaletteChipKind.Goal), '',
    'the chips that only shape the draft start nothing');
  assert.equal(Policy.wireAction(CommandPaletteChipKind.Usage), '');
  assert.equal(Policy.wireAction(CommandPaletteChipKind.Compact), compact);
  assert.equal(Policy.wireAction(CommandPaletteChipKind.Init), init);
});

test('the completion line dwells and a failure does not', () => {
  assert.ok(Policy.noticeDwellMs(CommandPaletteNoticeKind.Done) > 0,
    'a completion is a moment, not a state, so it needs a dwell time');
  assert.equal(Policy.noticeDwellMs(CommandPaletteNoticeKind.Failed), 0,
    'a failure stays until it is acted on');
});

test('completing a line with no argument is not a message yet', () => {
  const goal = Policy.goalPrefillText();
  assert.equal(goal, '/goal ');
  assert.equal(Policy.isBareGoalCommand('/goal'), true);
  assert.equal(Policy.isBareGoalCommand('/goal '), true, 'the prefill alone is still bare');
  assert.equal(Policy.isBareGoalCommand('  /goal  '), true);
  assert.equal(Policy.isBareGoalCommand('/goal fix login'), false);
  assert.equal(Policy.blocksSend('/goal'), true);
  assert.equal(Policy.blocksSend('/goal fix login'), false);
  assert.equal(Policy.blocksSend(''), false, 'an empty draft is blocked by the composer, not here');
  assert.equal(Policy.blocksSend('//goal'), false, 'only the real command is a command');
});

test('the goal prefill only ever fills an empty draft', () => {
  // One tap must not be a way to lose typed text.
  const first = Policy.toggleGoal('', false);
  assert.equal(first.draft, '/goal ');
  assert.equal(first.pending, true);
  assert.equal(Policy.canPrefillGoal(''), true);
  assert.equal(Policy.canPrefillGoal('   '), true);
  assert.equal(Policy.canPrefillGoal('draft'), false);
  assert.equal(Policy.canPrefillGoal('/goal fix'), false,
    'a draft that already carries the command is not empty');

  const takenBack = Policy.toggleGoal('/goal ', true);
  assert.equal(takenBack.draft, '', 'a second tap takes the untouched prefill back off');
  assert.equal(takenBack.pending, false);

  const typed = Policy.toggleGoal('/goal fix login', true);
  assert.equal(typed.draft, '/goal fix login', 'an argument typed after the prefill is user text');
  assert.equal(typed.pending, false, 'the chip only stops being pending');

  const occupied = Policy.toggleGoal('fix login', false);
  assert.equal(occupied.draft, 'fix login', 'a draft with content is left alone');
  assert.equal(occupied.pending, false);
});

test('a skill token survives the operator keeping or replacing it', () => {
  assert.equal(Policy.skillTokenLabel('plan'), '[$plan]');
  assert.equal(Policy.skillTokenLabel('  plan  '), '[$plan]');
  assert.equal(Policy.skillTokenLabel(''), '', 'no pick draws no token');
  assert.equal(Policy.applySkillSelection('', 'plan'), 'plan');
  assert.equal(Policy.applySkillSelection('plan', 'review'), 'review',
    'one token at a time: a new pick replaces the old one');
  assert.equal(Policy.applySkillSelection('plan', 'plan'), 'plan', 're-picking is a no-op');
  assert.equal(Policy.applySkillSelection('plan', '   '), 'plan',
    'an empty pick must not clear the token it did not ask to change');
});

test('the token becomes message content in front of free text', () => {
  assert.equal(Policy.composeSubmissionText('fix login', 'plan'), '[$plan] fix login');
  assert.equal(Policy.composeSubmissionText('  fix login  ', 'plan'), '[$plan] fix login');
  assert.equal(Policy.composeSubmissionText('', 'plan'), '[$plan]',
    'a token with no draft is the whole message');
  assert.equal(Policy.composeSubmissionText('fix login', ''), 'fix login',
    'no token leaves the draft exactly as typed');
  assert.equal(Policy.composeSubmissionText('[$plan] fix login', 'plan'), '[$plan] fix login',
    'the token is written once, so a repeated pick cannot stack it');
  assert.equal(Policy.composeSubmissionText('', ''), '');
});

test('a host command keeps the head of the message', () => {
  // The desktop parses the objective out of the message head
  // (`goal_objective_from_prompt` refuses anything that does not start with
  // `/goal `), so a token in front of it would silently turn a goal into an
  // ordinary message. The token is appended for these drafts instead.
  assert.equal(Policy.startsWithHostCommand('/goal fix login'), true);
  assert.equal(Policy.startsWithHostCommand('/goal'), true);
  assert.equal(Policy.startsWithHostCommand('  /goal fix'), true);
  assert.equal(Policy.startsWithHostCommand('/goals'), false);
  assert.equal(Policy.startsWithHostCommand('fix login'), false);

  assert.equal(Policy.composeSubmissionText('/goal fix login', 'plan'),
    '/goal fix login [$plan]');
  assert.equal(Policy.composeSubmissionText('  /goal fix login  ', 'plan'),
    '/goal fix login [$plan]');
  assert.equal(Policy.composeSubmissionText('/goal', 'plan'), '/goal [$plan]',
    'a bare command is never sent on its own; if it ever reached here the token must not become the objective head');
});
