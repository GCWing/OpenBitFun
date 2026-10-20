const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The inventory of framework members a component may only reach through a gate.
//
// A member that ships above the app's floor does not degrade on the device below it:
// the member is *not there*, so reading it is `undefined is not callable` and the
// process dies before the first frame. That is how the wide chat page's top band took
// the app down on API 22 (see `plan.md` §11.1): the band named the component material
// on one chain, and the chain a device below its floor takes reached it too.
//
// Each row below names one such member, the scope it is read in, and the rule that keeps
// a device below its floor from reaching it. The rules stay counting rules — the number
// of member reads in a file may not exceed the number of gate questions in that file —
// because a counting rule cannot be fooled by formatting and cannot drift into a parser.
//
// Scope: `pages/components/**`. The gate owners live one layer down (`services/**`) or
// beside the page (`pages/policy/**`), and those are out of scope by directory rather
// than by an allowlist: a policy answers in its own vocabulary, a service is the one
// place a platform module is touched, and a component reads the answer instead. That
// leaves the scope with **no per-file exemption at all** — every row below passes on the
// whole component tree, so there is nothing for a broad allowlist to hide behind.
//
// A member that cannot be locked by counting is listed and marked instead: an enum whose
// two members sit on different floors, and a type that is erased before anything runs.
// The rows that another test already owns point at that test, and the pointer is
// asserted, so a member cannot be dropped from both places at once.

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

// Comments are not code: an explanation may name a member it warns about, and the P0
// above was found through a comment read as if it were a call.
function codeOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

// The component material is the one member whose call form shares its name with a static
// method (`HdsTitleBarSupport.systemMaterial(decision)`) and with a field write on an
// option object (`options.systemMaterial = …`). Counting the *attribute* therefore needs
// the leading dot and nothing identifier-like before it, or the support class would read
// as two adopters of a member it never takes.
function componentMaterialCalls(text) {
  return [...text.matchAll(/(^|[^A-Za-z0-9_$.])\.systemMaterial\(/g)].length;
}

function etsFilesUnder(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...etsFilesUnder(full));
    } else if (entry.name.endsWith('.ets')) {
      found.push(full);
    }
  }
  return found;
}

const componentRoot = path.join(__dirname, '../../entry/src/main/ets/pages/components');
const etsRoot = path.join(__dirname, '../../entry/src/main/ets');
// `[relative path from the ets tree, comment-stripped source]`, once, for every assertion.
const components = etsFilesUnder(componentRoot)
  .sort()
  .map((file) => [path.relative(etsRoot, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')]);

// Every row is one member, the scope it is read in, and how a device below its floor is
// kept away from it. `count` rows are the counting rule; `forbidden` rows are members
// whose only legal host is the gate owner, so the component scope must not name one at
// all; `owned` rows are locked by the test named, and the pointer is asserted below. A
// `forbidden` row may carry its own `read` when the member's name also occurs in
// something that is not a read of it, and may leave `owner` out when no file may name
// it at all.
//
// The pointer is the owning test's whole gated-member list rather than one word from it:
// a word can be met by a stray mention elsewhere in that file, and the point of the row
// is that the member is still in the list that test iterates.
const POINTER = 'const gatedMembers = [\'ScrollEffectType.IMMERSIVE_GRADIENT_BLUR\', ' +
  '\'systemMaterialEffect\', \'hdsMaterial.\'];';
const INVENTORY = [
  {
    member: '.systemMaterial(',
    floor: 26,
    kind: 'forbidden',
    read: componentMaterialCalls,
    note: 'the component-channel material attribute: no component adopts it any more, because the platform accepts ' +
      'it on a content surface and then draws nothing, so a surface that attaches one gives up the glass it paints'
  },
  {
    member: 'systemMaterialEffect',
    floor: 23,
    kind: 'count',
    gate: 'decision.materialAttached',
    read: (text) => occurrences(text, 'systemMaterialEffect'),
    gateRead: (text) => occurrences(text, 'materialAttached'),
    note: 'the platform band\'s material field, attached only from the gated answer'
  },
  {
    member: 'uiMaterial.',
    floor: 26,
    kind: 'forbidden',
    owner: 'services/ImmersiveMaterialService.ets',
    note: 'the immersive material module: read by the service that owns the level gate'
  },
  {
    member: 'getSystemMaterialTypes(',
    floor: 23,
    kind: 'forbidden',
    owner: 'services/HdsTitleBarMaterialService.ets',
    note: 'the device\'s material types: read by the service that owns the title-bar gate'
  },
  {
    member: 'ScrollEffectType.IMMERSIVE_GRADIENT_BLUR',
    floor: 23,
    kind: 'owned',
    owner: 'tools/tests/immersive-bottom.test.cjs',
    pointer: POINTER,
    note: 'one member of an enum whose other member sits on a lower floor, so the gate is per method'
  },
  {
    member: 'hdsMaterial.',
    floor: 23,
    kind: 'owned',
    owner: 'tools/tests/immersive-bottom.test.cjs',
    pointer: POINTER,
    note: 'the HDS material module: named inside the support class\'s gated mappers'
  },
  {
    members: ['avoidLayoutSafeArea', 'enableComponentSafeArea'],
    floor: 20,
    kind: 'documented',
    note: 'below the app\'s own floor: the root project\'s compatibleSdkVersion is what keeps them away, ' +
      'and a gate here would be a second tier table for something every supported device can name'
  },
  {
    member: 'SystemUiMaterial',
    floor: 26,
    kind: 'documented',
    note: 'a type: it is erased before anything runs, so a component may annotate with it while only the ' +
      'service may construct one — the construction is what the first two rows count'
  }
];

test('every member a component may only reach through a gate is counted against that gate', () => {
  const counting = INVENTORY.filter((row) => row.kind === 'count');
  assert.ok(counting.length >= 1,
    'the inventory must keep the counted member that remains — the platform band\'s field, which is answered once ' +
    'per surface — while the component attribute is a forbidden row rather than a counted one');
  for (const row of counting) {
    for (const [name, text] of components) {
      const body = codeOf(text);
      const reads = row.read(body);
      if (reads === 0) {
        continue;
      }
      const gates = row.gateRead(body);
      assert.ok(gates >= reads,
        `${name} reads ${row.member} (${row.floor}+) ${reads} time(s) but asks ${row.gate} ${gates} time(s): ` +
        `on a device below ${row.floor} the member is not there at all, so every read needs a gate question of ` +
        'its own rather than a shared or unconditional one');
    }
  }
  // The rows are only a gate while the gate question still exists somewhere: a tree with
  // no question left is a tree that has quietly gone back to naming the member outright.
  for (const [name, text] of components) {
    const body = codeOf(text);
    if (componentMaterialCalls(body) > 0) {
      assert.ok(occurrences(body, 'usesMaterial(') > 0,
        `${name} adopts the component material without asking the capability question`);
    }
  }
});

test('the members whose only host is the gate owner are never named by a component', () => {
  const forbidden = INVENTORY.filter((row) => row.kind === 'forbidden');
  assert.ok(forbidden.length >= 3,
    'the inventory must keep the owner-only members and the attribute no component may adopt');
  for (const row of forbidden) {
    // A row may carry its own reader: the attribute's name also appears inside the
    // support class's own mapping method, and a substring test would read that as an
    // adoption. The reader below counts calls at a word boundary, which is the read the
    // counting rule uses as well.
    const reads = (text) => (row.read === undefined
      ? (text.includes(row.member) ? 1 : 0)
      : row.read(text));
    for (const [name, text] of components) {
      assert.equal(reads(codeOf(text)), 0,
        `${name} must not name ${row.member} (${row.floor}+): the member does not exist below ${row.floor}, and ` +
        `the gate that owns it is ${row.owner}`);
    }
    // And the owner is where it lives: a pointer to a file that stopped naming the member
    // is a row nobody owns, which is the state this inventory exists to prevent.
    if (row.owner === undefined) {
      // No file may name this one, so there is no owner to point at: the row's whole
      // content is the prohibition above.
      continue;
    }
    const owner = path.join(__dirname, '../..', 'entry/src/main/ets', row.owner);
    assert.ok(fs.existsSync(owner), `${row.member} must still have its gate owner at ${row.owner}`);
    assert.ok(codeOf(fs.readFileSync(owner, 'utf8')).includes(row.member),
      `${row.owner} must be the file that reads ${row.member}: the inventory names it as the gate owner`);
  }
});

test('the inventory and the tests that own the rows it does not lock move together', () => {
  for (const row of INVENTORY.filter((entry) => entry.kind === 'owned')) {
    const owner = path.join(__dirname, '../..', row.owner);
    assert.ok(fs.existsSync(owner), `${row.member} must still have the test that locks it at ${row.owner}`);
    assert.ok(codeOf(fs.readFileSync(owner, 'utf8')).includes(row.pointer),
      `${row.owner} must still gate ${row.member}: a member that leaves the test named here has left the ` +
      'inventory too, and this row is how the two stay in step');
  }
  // The documented rows carry the reason they cannot be counted, and that reason is a live
  // fact rather than a comment: the app's floor is what keeps the lower one away.
  const belowFloor = INVENTORY.find((row) => row.kind === 'documented' && row.members !== undefined);
  assert.notEqual(belowFloor, undefined, 'the inventory must keep the members below the app\'s floor');
  const buildProfile = source('build-profile.json5');
  const compatible = /"compatibleSdkVersion"\s*:\s*"[^"]*\((\d+)\)"/.exec(buildProfile);
  assert.notEqual(compatible, null, 'the root project must state the API level it is compatible with');
  for (const member of belowFloor.members) {
    assert.ok(Number(compatible[1]) >= belowFloor.floor,
      `${member} starts at ${belowFloor.floor} and the app is compatible with API ${compatible[1]}: below that ` +
      'floor this row is wrong and the member needs a gate of its own');
  }
  // And the two members that share a name with something else are still read the way this
  // file reads them: the support class's own method is not an adoption of the attribute.
  const support = codeOf(source('entry/src/main/ets/pages/components/HdsTitleBarSupport.ets'));
  assert.ok(support.includes('HdsTitleBarSupport.systemMaterial('),
    'the support class must keep its own mapping method: this inventory counts the attribute and not the name');
  assert.equal(componentMaterialCalls(support), 0,
    'the support class answers the material rather than adopting the attribute, so it must not read as an adopter');
});
