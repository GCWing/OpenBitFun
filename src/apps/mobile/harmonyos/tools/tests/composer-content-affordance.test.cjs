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

const {ChatComposerPolicy: Policy, ComposerPrimaryAction} = load('entry/src/main/ets/services/ChatComposerPolicy.ets');
const composerSource = fs.readFileSync(
  path.join(__dirname, '../../entry/src/main/ets/pages/components/ComposerBar.ets'), 'utf8');

// The composer input is the TextArea in InputField(). Slicing from its
// constructor to its first handler keeps these assertions off the model rows and
// role rows, which legitimately ellipsize their own labels.
function composerInputField(source) {
  const start = source.indexOf('TextArea({ placeholder: this.inputPlaceholder()');
  assert.notEqual(start, -1, 'the composer input must stay a TextArea');
  const end = source.indexOf('.onChange(', start);
  assert.notEqual(end, -1, 'the composer input must keep its onChange handler');
  return source.slice(start, end);
}

// Reads one chained call out of the field so the assertions survive rewrapping.
function call(source, name) {
  const start = source.indexOf(`.${name}(`);
  assert.notEqual(start, -1, `the composer input must keep its .${name}() call`);
  let depth = 0;
  for (let index = start + name.length + 1; index < source.length; index++) {
    if (source[index] === '(') {
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1).replace(/\s+/g, ' ');
      }
    }
  }
  throw new Error(`unbalanced .${name}() call`);
}

// Reads one @Builder out of the component, so an assertion can name the row it
// is about instead of counting occurrences in the whole file.
function builderBody(source, name) {
  const start = source.indexOf(`\n  ${name}() {`);
  assert.notEqual(start, -1, `the composer must keep its ${name}() builder`);
  const end = source.indexOf('\n  @Builder', start);
  assert.notEqual(end, -1, `${name}() must be followed by another builder`);
  return source.slice(start, end);
}

function primaryAction(text, attachments, busy, listening, turnRunning) {
  return Policy.primaryAction(text, attachments, busy, listening, turnRunning, true, true, 'connected', true);
}

test('a draft still earns the supplemental microphone beside Send', () => {
  // The expanded action row is where a draft keeps its second way into
  // dictation: any text or any image asks for the slot, while an empty field
  // does not need it and a listening or voice-less surface must not show it.
  assert.equal(Policy.shouldShowSupplementalVoice('继续补充', 0, false, true), true);
  assert.equal(Policy.shouldShowSupplementalVoice('  ', 0, false, true), false);
  assert.equal(Policy.shouldShowSupplementalVoice('', 1, false, true), true);
  assert.equal(Policy.shouldShowSupplementalVoice('继续补充', 0, true, true), false);
  assert.equal(Policy.shouldShowSupplementalVoice('继续补充', 0, false, false), false);
});

test('an empty field keeps reaching dictation from the primary slot', () => {
  // The pending slot is never the only way in; that is what the empty field's
  // primary action provides.
  assert.equal(primaryAction('', 0, false, false, false), ComposerPrimaryAction.Voice);
  assert.equal(primaryAction('', 0, true, false, false), ComposerPrimaryAction.VoiceBlocked);
  assert.equal(primaryAction('继续补充', 0, false, false, false), ComposerPrimaryAction.Send);
  assert.equal(primaryAction('', 1, false, false, false), ComposerPrimaryAction.Send);
  assert.equal(primaryAction('', 0, false, false, true), ComposerPrimaryAction.Stop);
});

test('the collapsed input truncates with an ellipsis instead of scrolling', () => {
  const field = composerInputField(composerSource);
  assert.equal(call(field, 'textOverflow'),
    '.textOverflow(this.isComposerExpanded() ? TextOverflow.Clip : TextOverflow.Ellipsis)');
  assert.equal(call(field, 'maxLines'),
    '.maxLines(this.isComposerExpanded() ? 4 : 1, ' +
    '{ overflowMode: this.isComposerExpanded() ? MaxLinesMode.SCROLL : MaxLinesMode.CLIP })');
});

test('a collapsed draft keeps the field to itself', () => {
  // The collapsed field is one line tall and the draft has the stronger claim
  // on it, so nothing inside the field may mount a second microphone. Without
  // this the restored policy would put one back beside the truncated text.
  const field = builderBody(composerSource, 'InputField');
  assert.equal(field.indexOf('this.SupplementalVoiceButton()'), -1,
    'the input field must not render the supplemental voice slot');

  const sites = [...composerSource.matchAll(/this\.SupplementalVoiceButton\(\)/g)];
  assert.equal(sites.length, 1,
    'the expanded action row is the only supplemental voice render site');
});

test('the expanded action row keeps the supplemental microphone behind the policy', () => {
  const composer = builderBody(composerSource, 'AdaptiveComposer');
  const expanded = composer.indexOf('if (this.isComposerExpanded()) {');
  assert.notEqual(expanded, -1, 'the composer must keep its expanded action row');
  const row = composer.slice(expanded);
  const site = row.indexOf('this.SupplementalVoiceButton()');
  assert.notEqual(site, -1,
    'the expanded action row must render the supplemental voice slot once the draft has content');
  assert.match(row.slice(Math.max(0, site - 200), site),
    /if \(this\.shouldShowSupplementalVoice\(\)/,
    'the expanded supplemental voice render site must stay gated by the composer policy');
});
