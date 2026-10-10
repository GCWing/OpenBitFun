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
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteAvailability
} = load('entry/src/main/ets/services/CommandPalettePolicy.ets');
const composerSource = read('entry/src/main/ets/pages/components/ComposerBar.ets');
const conversationSource = read('entry/src/main/ets/pages/components/ConversationView.ets');
const transcriptSource = read('entry/src/main/ets/pages/viewmodel/RemoteTranscriptController.ets');

test('the composer takes the token and the row as inputs, and gives the removal back', () => {
  // Rule 12 keeps the surface to grouped state plus typed events; the token is
  // one projected string and the row's presence is one boolean.
  for (const declaration of [
    '@Param skillId: string = \'\';',
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
  assert.match(strip, /CommandPalettePolicy\.skillTokenLabel\(this\.skillId\)/,
    'the chip and the wire form must not be able to drift apart');
  assert.equal(strip.includes("RemoteI18n.t('commands.skillToken')"), true,
    'the chip needs an accessibility label of its own');
});

test('the token strip only mounts when a skill is picked', () => {
  const composer = memberBody(composerSource, 'AdaptiveComposer');
  const site = composer.indexOf('this.CommandTokenStrip()');
  assert.notEqual(site, -1, 'the composer must render the token strip');
  assert.match(composer.slice(Math.max(0, site - 120), site),
    /if \(this\.skillId\.length > 0\) \{/,
    'an empty pick must not leave an empty row above the field');
  assert.ok(composer.indexOf('this.SelectedImageStrip()') > site,
    'the token keeps the attachment strip in its established place');
});

test('the token is part of the composer card, so the card grows to hold it', () => {
  // The strip lives inside the card; a card sized for the field alone would clip
  // it, and the pill radius only reads as a pill while the card is one row tall.
  const height = memberBody(composerSource, 'composerHeight');
  assert.match(height, /this\.skillId\.length > 0 \? COMPOSER_TOKEN_STRIP_BLOCK : 0/,
    'the token row must be measured into the composer height');
  const radius = memberBody(composerSource, 'composerRadius');
  assert.match(radius, /this\.skillId\.length > 0/,
    'a card taller than the field must not keep the pill radius');
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
  assert.equal(Policy.composeSubmissionText('fix login', 'plan'), '[$plan] fix login');
  assert.equal(Policy.composeSubmissionText('/goal fix login', 'plan'), '/goal fix login [$plan]');
  assert.equal(Policy.composeSubmissionText('', 'plan'), '[$plan]');
  assert.equal(Policy.composeSubmissionText('fix login', ''), 'fix login');
});

test('the send path is where the token becomes content', () => {
  const send = memberBody(transcriptSource, 'sendRemoteMessage');
  assert.match(send, /CommandPalettePolicy\.composeSubmissionText\(rawText, skillId\)/,
    'the draft the field holds must travel with the token beside it');
  assert.match(send, /const skillId = this\.remote\.commandPalette\.skillId;/);
  assert.match(send, /if \(CommandPalettePolicy\.blocksSend\(rawText\)\) \{\s*\n\s*return;/,
    'a bare `/goal` must stop at the send path even if it got there another way');
});

test('an accepted send consumes the token and a refused one puts it back', () => {
  // The token travels with the draft's own ownership rules: consumed by the
  // commit the host accepted, restored by the rollback that it did not.
  const state = read('entry/src/main/ets/pages/state/RemotePageState.ets');
  const prepare = state.slice(state.indexOf('prepareComposerSubmission('));
  assert.match(prepare, /const skillId = this\.commandPalette\.skillId;/);
  assert.match(prepare, /this\.commandPalette\.clearSkill\(\);/);
  assert.match(prepare, /this\.commandPalette\.setSkill\(skillId\);/,
    'a rollback must return the token the commit would have consumed');
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
  const chips = Policy.chips(new CommandPaletteAvailability(true, true, false, '', true));
  const goal = chips.find((entry) => entry.kind === CommandPaletteChipKind.Goal);
  assert.equal(goal.state, CommandPaletteChipState.Pending,
    'the lit chip is the row saying the argument is still missing');
  assert.equal(Policy.blocksSend('/goal fix login'), false);
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
