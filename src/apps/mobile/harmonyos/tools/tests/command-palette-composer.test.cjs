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

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

// Reads one member method or @Builder out of a component, so an assertion can
// name the piece it is about instead of counting occurrences in the file.
function memberBody(source, name) {
  const signature = new RegExp(`^  (?:private |public |protected |async )*${name}\\s*\\([^)]*\\)[^{]*\\{`, 'm');
  const match = signature.exec(source);
  assert.notEqual(match, null, `the component must keep its ${name}() member`);
  const start = match.index;
  const braceStart = start + match[0].length - 1;
  let depth = 0;
  for (let index = braceStart; index < source.length; index++) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`unbalanced ${name}() body`);
}

const {
  CommandPalettePolicy: Policy,
  CommandPaletteAvailability,
  CommandPaletteCatalogStatus,
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteProbeFailure
} = load('entry/src/main/ets/services/CommandPalettePolicy.ets');
const composerSource = read('entry/src/main/ets/pages/components/ComposerBar.ets');
const conversationSource = read('entry/src/main/ets/pages/components/ConversationView.ets');
const transcriptSource = read('entry/src/main/ets/pages/viewmodel/RemoteTranscriptController.ets');

test('the composer takes the token and the row as inputs, and gives the removal back', () => {
  // Rule 12 keeps the surface to grouped state plus typed events; the token is
  // two projected strings — the pick's key and the name it writes — and the row's
  // presence is one boolean.
  for (const declaration of [
    '@Param skillId: string = \'\';',
    '@Param skillLabel: string = \'\';',
    '@Param commandRowActive: boolean = false;',
    '@Event onRemoveSkillToken: () => void'
  ]) {
    assert.ok(composerSource.includes(declaration), `the composer must declare ${declaration}`);
  }
  assert.match(composerSource, /this\.onRemoveSkillToken\(\);/,
    'the token chip must have exactly one way back to the conversation');
});

test('the token draws the exact text the message will carry', () => {
  const strip = memberBody(composerSource, 'CommandTokenStrip');
  assert.match(strip, /CommandPalettePolicy\.skillTokenLabel\(this\.skillLabel\)/,
    'the chip and the wire form must not be able to drift apart');
  assert.equal(strip.includes("RemoteI18n.t('commands.skillToken')"), true,
    'the chip needs an accessibility label of its own');
});

test('the token strip only mounts when a skill is picked', () => {
  const composer = memberBody(composerSource, 'AdaptiveComposer');
  const site = composer.indexOf('this.CommandTokenStrip()');
  assert.notEqual(site, -1, 'the composer must render the token strip');
  assert.match(composer.slice(Math.max(0, site - 120), site),
    /if \(this\.hasSkillToken\(\)\) \{/,
    'an empty pick must not leave an empty row above the field');
  assert.ok(composer.indexOf('this.SelectedImageStrip()') > site,
    'the token keeps the attachment strip in its established place');
});

test('the token is part of the composer card, so the card grows to hold it', () => {
  // The strip lives inside the card; a card sized for the field alone would clip
  // it, and the pill radius only reads as a pill while the card is one row tall.
  const height = memberBody(composerSource, 'composerHeight');
  assert.match(height, /this\.hasSkillToken\(\) \? COMPOSER_TOKEN_STRIP_BLOCK : 0/,
    'the token row must be measured into the composer height');
  const radius = memberBody(composerSource, 'composerRadius');
  assert.match(radius, /this\.hasSkillToken\(\)/,
    'a card taller than the field must not keep the pill radius');
  // The label is the token's own text, so the strip cannot mount over an empty one.
  assert.match(memberBody(composerSource, 'hasSkillToken'), /return this\.skillLabel\.length > 0;/);
});

test('a bare goal withholds Send without changing the local surface', () => {
  // The row is the only thing that can produce a bare `/goal`, and that is a
  // command still waiting for its argument rather than a message.
  const action = memberBody(composerSource, 'primaryAction');
  assert.match(action, /this\.commandRowActive &&\s*\n\s*CommandPalettePolicy\.blocksSend\(this\.inputText\)/,
    'the composer must withhold Send for an argument-less host command');
  assert.match(action, /return ComposerPrimaryAction\.SendBlocked;/);
});

test('the token is prepended on send, and appended after a host command', () => {
  assert.equal(Policy.composeSubmissionText('fix login', 'Plan'), '[$Plan] fix login');
  assert.equal(Policy.composeSubmissionText('/goal fix login', 'Plan'), '/goal fix login [$Plan]');
  assert.equal(Policy.composeSubmissionText('', 'Plan'), '[$Plan]');
  assert.equal(Policy.composeSubmissionText('fix login', ''), 'fix login');
});

test('the send path is where the token becomes content', () => {
  const send = memberBody(transcriptSource, 'sendRemoteMessage');
  assert.match(send, /CommandPalettePolicy\.composeSubmissionText\(rawText, skillLabel\)/,
    'the draft the field holds must travel with the token beside it');
  assert.match(send, /const skillLabel = this\.remote\.commandPalette\.skillLabel;/,
    'the token is built from the skill name, which is what the desktop inserts');
  assert.match(send, /if \(CommandPalettePolicy\.blocksSend\(rawText\)\) \{\s*\n\s*return;/,
    'a bare `/goal` must stop at the send path even if it got there another way');
});

test('an accepted send consumes the token and a refused one puts it back', () => {
  // The token travels with the draft's own ownership rules: consumed by the
  // commit the host accepted, restored by the rollback that it did not. The key
  // and the name are one pick, so both halves return together.
  const state = read('entry/src/main/ets/pages/state/RemotePageState.ets');
  const prepare = state.slice(state.indexOf('prepareComposerSubmission('));
  assert.match(prepare, /const skillId = this\.commandPalette\.skillId;/);
  assert.match(prepare, /const skillLabel = this\.commandPalette\.skillLabel;/);
  assert.match(prepare, /this\.commandPalette\.clearSkill\(\);/);
  assert.match(prepare, /this\.commandPalette\.setSkill\(skillId, skillLabel\);/,
    'a rollback must return the token the commit would have consumed');
});

test('a sent goal stops being pending, and a refused one goes back to pending', () => {
  // The lit chip says the argument is still missing. Leaving it lit over a
  // `/goal` the host just accepted would contradict the conversation behind it.
  const state = read('entry/src/main/ets/pages/state/RemotePageState.ets');
  const prepare = state.slice(state.indexOf('prepareComposerSubmission('),
    state.indexOf('setVoiceListening('));
  assert.match(prepare, /const goalPending = this\.commandPalette\.goalPending;/);
  assert.match(prepare, /if \(goalPending\) \{\s*\n\s*this\.commandPalette\.setGoalPending\(false\);\s*\n\s*\}/,
    'the commit that consumed the draft consumes the lit chip');
  assert.match(prepare, /if \(goalPending && !this\.commandPalette\.goalPending\) \{\s*\n\s*this\.commandPalette\.setGoalPending\(true\);\s*\n\s*\}/,
    'a rollback puts the chip back exactly as the commit found it');
  assert.ok(prepare.indexOf('setGoalPending(false)') < prepare.indexOf('rollback:'),
    'the chip is cleared on commit and only restored by a rollback');
});

test('the goal chip prefills the draft and takes it back on a second tap', () => {
  const dispatch = transcriptSource.slice(
    transcriptSource.indexOf('async dispatchCommandPalette('),
    transcriptSource.indexOf('private commandPaletteModeId()'));
  assert.match(dispatch,
    /CommandPalettePolicy\.toggleGoal\(this\.remote\.chatInput, palette\.goalPending\)/);
  assert.match(dispatch, /this\.remote\.setChatInput\(toggled\.draft\);/);
  assert.match(dispatch, /palette\.setGoalPending\(toggled\.pending\);/);

  const first = Policy.toggleGoal('', false);
  assert.equal(first.draft, '/goal ');
  assert.equal(first.pending, true);
  assert.equal(first.draft, Policy.goalPrefillText(), 'the prefill is the command and one space');
  const takenBack = Policy.toggleGoal(first.draft, first.pending);
  assert.equal(takenBack.draft, '', 'the second tap takes the untouched prefill back off');
  assert.equal(takenBack.pending, false);

  const occupied = Policy.toggleGoal('fix login', false);
  assert.equal(occupied.draft, 'fix login', 'one tap must never overwrite typed text');
  assert.equal(occupied.pending, false);
});

test('a host command with no argument is not sendable from the row either', () => {
  assert.equal(Policy.blocksSend('/goal'), true);
  const chips = Policy.chips(new CommandPaletteAvailability(
    CommandPaletteCatalogStatus.Ready, CommandPaletteProbeFailure.None, true, false, '', true));
  const goal = chips.find((entry) => entry.kind === CommandPaletteChipKind.Goal);
  assert.equal(goal.state, CommandPaletteChipState.Pending,
    'the lit chip is the row saying the argument is still missing');
  assert.equal(Policy.blocksSend('/goal fix login'), false);
});

test('the conversation keeps one sheet binding and names the sheet instead', () => {
  // Found on device: a second `bindSheet` on the same node is dropped, and with
  // it every sheet that node was meant to open. All three of the conversation's
  // sheets therefore take turns on the root's single binding.
  const bindings = [...conversationSource.matchAll(/\.bindSheet\(/g)];
  assert.equal(bindings.length, 1,
    'a node carries exactly one sheet binding, so a second one costs every sheet on it');
  assert.match(conversationSource, /\.bindSheet\(\$\$this\.sheetPresented, this\.ActiveSheet\(\)/);
  for (const kind of ["'full_text'", "'skills'", "'usage'"]) {
    assert.ok(conversationSource.includes(`= ${kind};`), `the sheet kind ${kind} must stay named`);
  }
  const surface = memberBody(conversationSource, 'ActiveSheet');
  assert.match(surface, /if \(this\.activeSheet === CONVERSATION_SHEET_FULL_TEXT\)/);
  assert.match(surface, /else if \(this\.activeSheet === CONVERSATION_SHEET_SKILLS\)/);
  assert.match(surface, /else if \(this\.activeSheet === CONVERSATION_SHEET_USAGE\)/);
  const options = memberBody(conversationSource, 'activeSheetOptions');
  assert.match(options, /this\.skillPickerSheetPlacement/,
    'each sheet keeps its own placement through the shared binding');
  assert.match(options, /this\.usageReportSheetPlacement/);
});

test('the conversation hands the composer both inputs from one projection', () => {
  const composer = conversationSource.slice(conversationSource.indexOf('ComposerBar({'));
  assert.match(composer.slice(0, composer.indexOf('})') + 2),
    /skillId: this\.commandPalette\.skillId,/);
  assert.match(composer.slice(0, composer.indexOf('})') + 2),
    /commandRowActive: this\.commandPalette\.visible,/);
  assert.match(conversationSource,
    /onRemoveSkillToken: \(\) => \{\s*\n\s*this\.onIntent\(ConversationIntents\.commandPalette\(\s*\n\s*new CommandPaletteRequest\(CommandPaletteAction\.ClearSkill\)\)\);/,
    'removing the token must leave as the one typed intent');
});

test('the row mounts once, above the composer, for every posture', () => {
  // Both the compact overlay and the half-folded pane build their composer from
  // the same Composer() subtree, so mounting the row there covers all of them.
  const sites = [...conversationSource.matchAll(/CommandChipRow\(\{/g)];
  assert.equal(sites.length, 1, 'the row must be mounted exactly once');
  const composer = conversationSource.slice(
    conversationSource.indexOf('  Composer() {'),
    conversationSource.indexOf('private onCommandPaletteRequest('));
  assert.ok(composer.indexOf('CommandChipRow({') < composer.indexOf('ComposerBar({'),
    'the chips sit above the composer');
  assert.match(composer, /if \(this\.commandPalette\.visible\) \{/,
    'the row renders only where it has a session to act on');

  const composerSites = [...conversationSource.matchAll(/this\.Composer\(\)/g)];
  assert.ok(composerSites.length >= 2,
    'the same Composer() subtree is what the compact and half-folded panes both build');
});
