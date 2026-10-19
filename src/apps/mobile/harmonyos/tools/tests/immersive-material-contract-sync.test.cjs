const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The material recipe table has two owners, and they are edited on different
// sides of a language boundary:
//
//   1. `mobile-tokens.json` `surfaces` is the shared mobile design contract the
//      Android, iOS and HarmonyOS projections are generated from;
//   2. `ImmersiveMaterialPolicy.ets` `ImmersiveSurfaceRecipes` is what the phone
//      actually asks the platform for.
//
// Nothing at runtime reads both, so a thickness or a fallback colour can move on
// one side only and still ship: the HarmonyOS surface keeps a thinner material
// than the contract names, or paints a floor colour the other platforms do not.
// This runner holds the pair together — every field of every role, in both
// directions — so drift is a red build rather than a difference nobody sees.
const ENTRY = path.join(__dirname, '../../entry/src/main');
const POLICY = path.join(ENTRY, 'ets/pages/policy/ImmersiveMaterialPolicy.ets');
const SUPPORT = path.join(ENTRY, 'ets/pages/components/ImmersiveSurfaceSupport.ets');
const THEME = path.join(ENTRY, 'ets/pages/components/Theme.ets');
const COMPONENTS = path.join(ENTRY, 'ets/pages/components');
const TOKENS = path.join(__dirname, '../../../design-system/tokens/mobile-tokens.json');

// The token contract names the fields in snake_case and the policy names them in
// camelCase. The mapping is the contract, so it is written out rather than
// derived: a rename on either side has to be made here too.
const FIELDS = {
  level: 'level',
  fallbackBlur: 'fallback_blur',
  floorColor: 'floor_color',
  hairlineColor: 'hairline_color'
};
const LEVELS = ['ultra_thin', 'thin', 'regular', 'thick', 'ultra_thick'];
const FALLBACK_BLURS = ['thin', 'thick', 'none'];

function transpile(source) {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
}

function loadPolicy() {
  const exported = {};
  new Function('exports', transpile(fs.readFileSync(POLICY, 'utf8')))(exported);
  return exported;
}

const policy = loadPolicy();
const Scene = policy.ImmersiveSurfaceScene;
const Recipes = policy.ImmersiveSurfaceRecipes;
const tokens = JSON.parse(fs.readFileSync(TOKENS, 'utf8'));

/** The recipe the token contract declares for one surface role. */
function tokenRecipe(role, surface) {
  return {
    level: surface[FIELDS.level],
    fallbackBlur: surface[FIELDS.fallbackBlur],
    floorColor: surface[FIELDS.floorColor],
    hairlineColor: surface[FIELDS.hairlineColor]
  };
}

test('the token contract and the policy declare the same surface roles', () => {
  // The role name is the scene value on one side and the `surfaces` key on the
  // other; a role added to one side only would otherwise be silently unmapped and
  // fall back to the thickest modal recipe on the phone.
  const scenes = Object.values(Scene).sort();
  const roles = Object.keys(tokens.surfaces).sort();
  assert.deepEqual(roles, scenes, 'the token roles and the policy scenes must be the same set');
});

test('every surface role carries exactly the four recipe fields', () => {
  // A field the policy reads but the token contract does not declare (or the
  // other way around) is the drift this runner exists for, and it is invisible in
  // the value comparison below because the missing side reads `undefined`.
  const declared = Object.values(FIELDS).sort();
  for (const role of Object.keys(tokens.surfaces)) {
    assert.deepEqual(Object.keys(tokens.surfaces[role]).sort(), declared,
      `${role} must declare exactly ${declared.join(', ')}`);
  }
});

test('each role keeps the recipe the shared mobile contract declares', () => {
  for (const role of Object.values(Scene)) {
    assert.deepEqual(Recipes.recipeFor(role), tokenRecipe(role, tokens.surfaces[role]),
      `${role} must match the token contract field for field`);
  }
});

test('the recipes stay inside the levels and blurs the two contracts define', () => {
  // Guards the two closed vocabularies: a typo would reach the platform service
  // as an unknown style and silently take the regular material.
  for (const role of Object.values(Scene)) {
    const recipe = Recipes.recipeFor(role);
    assert.ok(LEVELS.includes(recipe.level), `${role} level ${recipe.level} is not a platform style`);
    assert.ok(FALLBACK_BLURS.includes(recipe.fallbackBlur),
      `${role} fallback blur ${recipe.fallbackBlur} is not a fallback blur`);
  }
});

/**
 * Every colour name the recipe table uses, in both fallback fields.
 *
 * The two lists are what the phone resolves and what it paints: the recipes carry
 * names, and the colour behind a name is a second contract, so this is the set
 * that has to exist on all three sides.
 */
function recipeColourKeys() {
  const keys = new Set();
  for (const role of Object.values(Scene)) {
    const recipe = Recipes.recipeFor(role);
    keys.add(recipe.floorColor);
    keys.add(recipe.hairlineColor);
  }
  return [...keys].sort();
}

/** `Theme.ets` constant name -> the contract colour it carries, read from source. */
function themeColours() {
  const source = fs.readFileSync(THEME, 'utf8');
  const colours = new Map();
  for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]*): ResourceColor = \$r\('app\.color\.([a-z0-9_]+)'\);/g)) {
    colours.set(match[1], match[2]);
  }
  return colours;
}

test('every colour the recipes name is a colour of the same shared contract', () => {
  // A name the token contract does not declare would resolve to whatever the
  // resolver's default happens to be, which is exactly the silent colour nobody
  // reviews.
  const declared = Object.keys(tokens.colors);
  for (const key of recipeColourKeys()) {
    assert.ok(declared.includes(key), `${key} must be a colour of the shared mobile contract`);
  }
});

test('Theme.ets and the wiring helper carry every colour the recipes name', () => {
  // The name a recipe carries is only half the trip: `Theme.ets` has to export the
  // constant, and the helper has to map the name onto it. Both are source reads,
  // because the HAP's own asset pipeline — not a unit test — is what resolves
  // `$r` to a value.
  const colours = themeColours();
  const support = fs.readFileSync(SUPPORT, 'utf8');
  for (const key of recipeColourKeys()) {
    const constant = key.toUpperCase();
    assert.match(fs.readFileSync(THEME, 'utf8'),
      new RegExp(`export const ${constant}: ResourceColor = \\$r\\('app\\.color\\.${key}'\\);`),
      `Theme.ets must export ${constant} as app.color.${key}`);
    assert.equal(colours.get(constant), key,
      `${constant} must carry the contract colour ${key}`);
    assert.match(support, new RegExp(`case '${key}':\\s*return ${constant};`),
      `the wiring helper must resolve the contract colour ${key} to ${constant}`);
  }
});

test('every fallback colour a material-aware surface paints is one the contract names', () => {
  // Each such surface keeps a colour of its own for the path where no material is
  // rendered. That colour has to be a theme constant over a contract colour, so a
  // contract rename cannot leave the phone painting a name the other platforms and
  // the generators no longer declare.
  const colours = themeColours();
  const declared = Object.keys(tokens.colors);
  const files = [];
  for (const entry of fs.readdirSync(COMPONENTS, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of fs.readdirSync(path.join(COMPONENTS, entry.name))) {
        if (nested.endsWith('.ets')) files.push(path.join(COMPONENTS, entry.name, nested));
      }
    } else if (entry.name.endsWith('.ets')) {
      files.push(path.join(COMPONENTS, entry.name));
    }
  }
  const found = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/immersiveMaterial \? TRANSPARENT : ([A-Z][A-Z0-9_]*)/g)) {
      found.push([path.basename(file), match[1]]);
    }
  }
  // A floor, so a rewrite that stops matching this pattern cannot quietly turn the
  // runner into a no-op. Sites are expected to migrate to the resolver form
  // (`surfaceFill(scene)`), which intentionally lowers this count; the
  // per-constant assertions below carry the real weight.
  assert.ok(found.length >= 1,
    `the material-aware fallbacks must still be found (found ${found.length})`);
  for (const [file, constant] of found) {
    assert.ok(colours.has(constant),
      `${file} must paint a Theme.ets colour on its fallback path, not ${constant}`);
    const key = colours.get(constant);
    assert.ok(declared.includes(key),
      `${file} falls back to ${constant} (app.color.${key}), which the shared contract must declare`);
  }
});
