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
  CommandPaletteCatalogStatus,
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteNoticeKind,
  CommandPaletteProbeFailure,
  commandPaletteProbeReady
} = load('entry/src/main/ets/services/CommandPalettePolicy.ets');

// A session whose skill read answered and which is idle: the row's baseline.
function available(overrides = {}) {
  return new CommandPaletteAvailability(
    overrides.probeStatus ?? CommandPaletteCatalogStatus.Ready,
    overrides.probeFailure ?? CommandPaletteProbeFailure.None,
    overrides.hasSession ?? true,
    overrides.isBusy ?? false,
    overrides.runningCommand ?? '',
    overrides.goalPending ?? false
  );
}

// The session verbs, which no skill read may gate.
const HOST_VERBS = [CommandPaletteChipKind.Compact, CommandPaletteChipKind.Init,
  CommandPaletteChipKind.Usage];

function chip(policyChips, kind) {
  const found = policyChips.find((entry) => entry.kind === kind);
  assert.ok(found, `the row must always carry the ${kind} chip`);
  return found;
}

test('an answered read enables the picker and leaves the verbs alone', () => {
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

test('a failed skill read greys the picker and nothing else', () => {
  // The three session verbs exist on every host this app can reach, and each
  // answers for itself when it runs: refusing them in advance would take away
  // working commands on the strength of a read none of them needed.
  for (const failure of [CommandPaletteProbeFailure.VersionGap, CommandPaletteProbeFailure.Refused,
    CommandPaletteProbeFailure.Unreachable]) {
    const state = available({probeStatus: CommandPaletteCatalogStatus.Failed, probeFailure: failure});
    const chips = Policy.chips(state);
    for (const kind of HOST_VERBS) {
      assert.equal(chip(chips, kind).state, CommandPaletteChipState.Ready,
        `${kind} must keep working when the skill read fails (${failure})`);
      assert.equal(chip(chips, kind).runsAction, true, `${kind} must still reach the host`);
      assert.equal(chip(chips, kind).badgeKey, '', `${kind} is not the chip that failed`);
    }
    const goal = chip(chips, CommandPaletteChipKind.Goal);
    assert.equal(goal.state, CommandPaletteChipState.Ready, 'the goal chip is message text');
    const skills = chip(chips, CommandPaletteChipKind.Skills);
    assert.equal(skills.state, CommandPaletteChipState.Dimmed, 'the picker chip greys');
    assert.equal(skills.runsAction, true, 'the picker must still open: it explains and re-checks');
    assert.equal(Policy.rowReasonKey(state), '',
      'one chip is not a degraded row, and saying so under four working chips would be wrong');
  }
});

test('only a host that named the version gap earns the upgrade badge', () => {
  // The badge sends the user to update a desktop. A refusal for another reason
  // and a connection that never answered are both real failures and neither is
  // evidence about the desktop's version.
  const gap = Policy.chips(available({
    probeStatus: CommandPaletteCatalogStatus.Failed,
    probeFailure: CommandPaletteProbeFailure.VersionGap
  }));
  assert.equal(chip(gap, CommandPaletteChipKind.Skills).badgeKey, Policy.upgradeBadgeKey);
  assert.equal(chip(gap, CommandPaletteChipKind.Skills).reasonKey, Policy.degradedReasonKey);

  const refused = Policy.chips(available({
    probeStatus: CommandPaletteCatalogStatus.Failed,
    probeFailure: CommandPaletteProbeFailure.Refused
  }));
  assert.equal(chip(refused, CommandPaletteChipKind.Skills).badgeKey, '',
    'a refusal the host did not tie to a version is not an upgrade');
  assert.equal(chip(refused, CommandPaletteChipKind.Skills).reasonKey, Policy.probeRefusedReasonKey);

  const unreachable = Policy.chips(available({
    probeStatus: CommandPaletteCatalogStatus.Failed,
    probeFailure: CommandPaletteProbeFailure.Unreachable
  }));
  assert.equal(chip(unreachable, CommandPaletteChipKind.Skills).badgeKey, '',
    'a timeout is not a version problem');
  assert.equal(chip(unreachable, CommandPaletteChipKind.Skills).reasonKey, Policy.probeUnreachableReasonKey);
});

test('a read still in flight waits without claiming anything', () => {
  // The one round trip between opening a session and the host's answer must not
  // read as a degradation while the verbs beside it stay lit.
  for (const status of [CommandPaletteCatalogStatus.Idle, CommandPaletteCatalogStatus.Loading]) {
    const state = available({probeStatus: status});
    const chips = Policy.chips(state);
    const skills = chip(chips, CommandPaletteChipKind.Skills);
    assert.equal(skills.state, CommandPaletteChipState.Dimmed, 'the picker chip waits');
    assert.equal(skills.badgeKey, '', 'waiting is not a version problem');
    assert.equal(skills.reasonKey, Policy.probeWaitReasonKey, 'it says what it is waiting for');
    assert.equal(skills.runsAction, false, 'there is nothing to open until the answer lands');
    assert.equal(skills.showsChevron, true, 'the chip keeps the affordance it will offer');
    for (const kind of HOST_VERBS) {
      assert.equal(chip(chips, kind).runsAction, true, `${kind} does not wait for the skill read`);
    }
    assert.notEqual(skills.reasonKey, Policy.degradedReasonKey,
      'no sentence about the desktop before the desktop has spoken');
  }
});

test('a greyed chip still explains itself when tapped', () => {
  // "Nothing happened" is not an answer: every chip that cannot run has to carry
  // the sentence the row shows for it.
  const waiting = Policy.chips(available({probeStatus: CommandPaletteCatalogStatus.Loading}));
  const busy = Policy.chips(available({isBusy: true}));
  const sessionless = Policy.chips(available({hasSession: false}));
  const failed = Policy.chips(available({
    probeStatus: CommandPaletteCatalogStatus.Failed,
    probeFailure: CommandPaletteProbeFailure.Refused
  }));
  for (const chips of [waiting, busy, sessionless, failed]) {
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
  for (const kind of HOST_VERBS) {
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

test('the goal chip is not gated by the skill read or by a capability', () => {
  // `/goal <objective>` is plain message text the desktop already parses on its
  // send path, so this chip is honest about working on a host whose skill list
  // this app cannot read. It is one of the chips that stays lit throughout.
  const failed = Policy.chips(available({
    probeStatus: CommandPaletteCatalogStatus.Failed,
    probeFailure: CommandPaletteProbeFailure.Unreachable
  }));
  const goal = chip(failed, CommandPaletteChipKind.Goal);
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
  assert.equal(Policy.skillTokenLabel('Plan'), '[$Plan]');
  assert.equal(Policy.skillTokenLabel('  Plan  '), '[$Plan]');
  assert.equal(Policy.skillTokenLabel(''), '', 'no pick draws no token');
  assert.equal(Policy.applySkillSelection('', 'plan'), 'plan');
  assert.equal(Policy.applySkillSelection('plan', 'review'), 'review',
    'one token at a time: a new pick replaces the old one');
  assert.equal(Policy.applySkillSelection('plan', 'plan'), 'plan', 're-picking is a no-op');
  assert.equal(Policy.applySkillSelection('plan', '   '), 'plan',
    'an empty pick must not clear the token it did not ask to change');
});

test('the picker row hints at the token the message will carry', () => {
  // One rule serves both: the row's hint comes from the same call the send path
  // composes the message with, so a hint can never describe a token the message
  // does not use. The name is what the desktop inserts, hence the name here.
  const token = Policy.skillTokenLabel('Plan');
  assert.equal(token, '[$Plan]');
  assert.equal(Policy.composeSubmissionText('draft', 'Plan'), `${token} draft`);
  assert.equal(Policy.composeSubmissionText('/goal ship it', 'Plan'),
    `/goal ship it ${token}`, 'a host command keeps the head it is parsed from');
});

test('a failed skill read is classified by whether the host answered', () => {
  // The classification is the only thing standing between a timeout and a claim
  // that the user's desktop is out of date.
  assert.equal(Policy.probeFailure(false, 'anything'),
    CommandPaletteProbeFailure.Unreachable, 'nothing answered, so nothing is claimed');
  assert.equal(Policy.probeFailure(false, ''),
    CommandPaletteProbeFailure.Unreachable, 'an empty transport error is still a transport error');
  assert.equal(Policy.probeFailure(true, "command 'get_mode_skill_configs' is unknown to this " +
    'OpenBitFun desktop peer host version; upgrade the peer host or check the command name'),
  CommandPaletteProbeFailure.VersionGap,
  "the host's own version-gap sentence is the one thing that licenses the badge");
  assert.equal(Policy.probeFailure(true, 'Command not found: get_mode_skill_configs'),
    CommandPaletteProbeFailure.VersionGap,
    "the desktop's command registry says the same thing in its own words");
  assert.equal(Policy.probeFailure(true, 'workspace not found'),
    CommandPaletteProbeFailure.Refused,
    'a refusal about something else keeps the host text without claiming a version');

  // Every kind has copy of its own, and only the version gap points at an update.
  const kinds = [CommandPaletteProbeFailure.VersionGap, CommandPaletteProbeFailure.Refused,
    CommandPaletteProbeFailure.Unreachable];
  assert.deepEqual(kinds.map((kind) => Policy.probeBadgeKey(kind)),
    [Policy.upgradeBadgeKey, '', '']);
  assert.deepEqual(kinds.map((kind) => Policy.probeReasonKey(kind)),
    [Policy.degradedReasonKey, Policy.probeRefusedReasonKey, Policy.probeUnreachableReasonKey]);
  assert.equal(new Set(kinds.map((kind) => Policy.probeTitleKey(kind))).size, 3,
    'each failure kind says its own thing');
  assert.equal(new Set(kinds.map((kind) => Policy.probeBodyKey(kind))).size, 3);
  for (const key of kinds.map((kind) => Policy.probeTitleKey(kind))
    .concat(kinds.map((kind) => Policy.probeBodyKey(kind)))) {
    assert.ok(key.startsWith('commands.'), `${key} must stay in the palette's namespace`);
  }
  assert.equal(commandPaletteProbeReady(CommandPaletteCatalogStatus.Ready), true);
  assert.equal(commandPaletteProbeReady(CommandPaletteCatalogStatus.Failed), false);
  assert.equal(commandPaletteProbeReady(CommandPaletteCatalogStatus.Loading), false);
});

test('the token becomes message content in front of free text', () => {
  assert.equal(Policy.composeSubmissionText('fix login', 'Plan'), '[$Plan] fix login');
  assert.equal(Policy.composeSubmissionText('  fix login  ', 'Plan'), '[$Plan] fix login');
  assert.equal(Policy.composeSubmissionText('', 'Plan'), '[$Plan]',
    'a token with no draft is the whole message');
  assert.equal(Policy.composeSubmissionText('fix login', ''), 'fix login',
    'no token leaves the draft exactly as typed');
  assert.equal(Policy.composeSubmissionText('[$Plan] fix login', 'Plan'), '[$Plan] fix login',
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

  assert.equal(Policy.composeSubmissionText('/goal fix login', 'Plan'),
    '/goal fix login [$Plan]');
  assert.equal(Policy.composeSubmissionText('  /goal fix login  ', 'Plan'),
    '/goal fix login [$Plan]');
  assert.equal(Policy.composeSubmissionText('/goal', 'Plan'), '/goal [$Plan]',
    'a bare command is never sent on its own; if it ever reached here the token must not become the objective head');
});
