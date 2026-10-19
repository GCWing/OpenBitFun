const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// ImmersiveMaterial (API 26) is the platform's glass material, and the app's
// compatibleSdkVersion is 6.0.1 (21). Three things have to hold across that gap,
// and none of them is visible from a screenshot:
//
//   1. the recipe table is one contract — the thickness, the fallback blur and
//      the colour names a surface keeps when the material is not drawn;
//   2. no `uiMaterial` member is touched on a device below API 26;
//   3. a device that ships the API and still will not draw a material (the
//      capability is defined by the device, not by the version) keeps the surface
//      painted rather than dropping its floor for a material that never arrives.
//
// So the pure policy runs here as the real `.ets` source (it imports nothing),
// and the service runs against a stubbed `@kit.ArkUI` whose members record every
// read, which is what turns "the gate is strict" into an assertion.
const ENTRY = path.join(__dirname, '../../entry/src/main');
const POLICY = path.join(ENTRY, 'ets/pages/policy/ImmersiveMaterialPolicy.ets');
const SERVICE = path.join(ENTRY, 'ets/services/ImmersiveMaterialService.ets');
const THEME = path.join(ENTRY, 'ets/pages/components/Theme.ets');
const lightColors = path.join(ENTRY, 'resources/base/element/color.json');
const darkColors = path.join(ENTRY, 'resources/dark/element/color.json');

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
const resolveImmersiveMaterial = policy.resolveImmersiveMaterial;

const policySource = fs.readFileSync(POLICY, 'utf8');
const serviceSource = fs.readFileSync(SERVICE, 'utf8');

// The contract as this test reads it: one literal per scene, independent of the
// table under test, so a change to either side has to be made in both.
const RECIPES = {};
RECIPES[Scene.TOP_CHROME] =
  { level: 'ultra_thin', fallbackBlur: 'thin', floorColor: 'page_bg_overlay', hairlineColor: 'line' };
RECIPES[Scene.BOTTOM_CHROME] =
  { level: 'thin', fallbackBlur: 'thin', floorColor: 'card_overlay', hairlineColor: 'line' };
RECIPES[Scene.SEARCH_FIELD] =
  { level: 'thin', fallbackBlur: 'thin', floorColor: 'card_overlay', hairlineColor: 'line' };
RECIPES[Scene.FLOATING_MENU] =
  { level: 'thick', fallbackBlur: 'thick', floorColor: 'card', hairlineColor: 'line' };
RECIPES[Scene.MODAL_SHEET] =
  { level: 'ultra_thick', fallbackBlur: 'none', floorColor: 'page_bg', hairlineColor: 'line' };
RECIPES[Scene.TOAST] =
  { level: 'thin', fallbackBlur: 'none', floorColor: 'toast_background', hairlineColor: 'line' };
const SCENES = Object.values(Scene);

// Only these two styles can adapt their content to the complementary colour.
const INVERTIBLE = ['thin', 'ultra_thin'];
const LEVELS = ['ultra_thin', 'thin', 'regular', 'thick', 'ultra_thick'];
const FALLBACK_BLURS = ['thin', 'thick', 'none'];

function snapshot(apiLevel, materialState, reduceMotion) {
  return { apiLevel: apiLevel, materialState: materialState, reduceMotion: reduceMotion };
}

function decision(scene, apiLevel, materialState, reduceMotion) {
  return resolveImmersiveMaterial(scene, snapshot(apiLevel, materialState, reduceMotion));
}

// The service, loaded with a `@kit.ArkUI` whose every member records the read.
// A getter is the only way to see a member the service never should have looked
// at: an accessing getter turns a missing call into a recorded one. `capable`
// answers the device capability query, and defaults to a device that will draw
// the material.
function serviceHarness(options) {
  const accesses = [];
  const built = [];
  const logs = [];
  const apiLevel = options.apiLevel;
  const state = options.state === undefined ? 0 : options.state;
  const styles = { ULTRA_THIN: 0, THIN: 1, REGULAR: 2, THICK: 3, ULTRA_THICK: 4 };
  const materialStates = { DEFAULT: 0, ENABLE: 1, DISABLE: 2 };
  class ImmersiveMaterial {
    constructor(planOptions) {
      if (options.constructionFails === true) {
        throw new Error('material unavailable on this device');
      }
      built.push(planOptions);
    }
  }
  const uiMaterial = {};
  const member = (name, value) => Object.defineProperty(uiMaterial, name, {
    get: () => {
      accesses.push(name);
      return value();
    }
  });
  member('ImmersiveStyle', () => styles);
  member('ImmersiveMaterial', () => ImmersiveMaterial);
  member('MaterialState', () => materialStates);
  member('getMaterialInfo', () => () => {
    if (options.stateReadFails === true) {
      throw new Error('material state unavailable');
    }
    return { state: state, type: 2 };
  });
  // API 26 is necessary and not sufficient. `capable: false` is a device that ships
  // the API and still will not draw a material — the case a construction that
  // succeeds would otherwise hide.
  member('isImmersiveMaterialSupported', () => () => {
    if (options.capabilityReadFails === true) {
      throw new Error('material capability unavailable');
    }
    return options.capable !== false;
  });

  const exported = {};
  new Function('require', 'exports', transpile(serviceSource))(
    (specifier) => {
      if (specifier === '@kit.ArkUI') {
        return { uiMaterial: uiMaterial };
      }
      if (specifier === './DeviceApiLevelService') {
        return { DeviceApiLevelService: { sdkApiVersion: () => apiLevel } };
      }
      if (specifier === './MotionPreference') {
        return { MotionPreference: { reduceMotion: () => options.reduceMotion === true } };
      }
      if (specifier === './RemoteLogger') {
        return {
          RemoteLogger: {
            info(message) { logs.push(message); },
            warn(message) { logs.push(message); },
            error(message) { logs.push(message); }
          }
        };
      }
      throw new Error(`the service must not import ${specifier}`);
    },
    exported);
  return { Service: exported.ImmersiveMaterialService, accesses: accesses, built: built, logs: logs };
}

const STYLES = { ultra_thin: 0, thin: 1, regular: 2, thick: 3, ultra_thick: 4 };

function planOf(overrides) {
  return Object.assign({
    apply: true,
    level: 'thin',
    colorInvert: true,
    interactive: true,
    lightEffect: true
  }, overrides);
}

// The real wiring builds the plan field by field from the decision — the two
// declarations live in different modules, and `ImmersiveSurfaceSupport` names the
// five fields for the same reason. The runner keeps that shape so the pattern a
// reader copies here is the one the app compiles.
function planFromDecision(resolved) {
  return {
    apply: resolved.apply,
    level: resolved.level,
    colorInvert: resolved.colorInvert,
    interactive: resolved.interactive,
    lightEffect: resolved.lightEffect
  };
}

test('the policy stays pure so the decision runs on the host', () => {
  // No import at all: a platform import here would move the gate out of reach of
  // this runner, and a component would reach a kit through a policy file. The
  // file names the platform types in its own comments, so the assertions read the
  // code with the comments taken out.
  const code = policySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^\s*import\b/m);
  assert.doesNotMatch(code, /from '@kit|from '@ohos/);
  assert.doesNotMatch(code, /uiMaterial\s*\./);
});

test('every scene keeps the thickness and colours the recipe contract names', () => {
  for (const scene of SCENES) {
    assert.deepEqual(Recipes.recipeFor(scene), RECIPES[scene], `${scene} must keep its recipe`);
  }
});

test('an unmapped scene degrades to the thickest solid recipe', () => {
  // A scene the table does not know must not be given a thinner material than the
  // surface it replaces: the solid modal recipe can only be more legible.
  assert.deepEqual(Recipes.recipeFor('not_a_scene'), RECIPES[Scene.MODAL_SHEET]);
  assert.deepEqual(Recipes.recipeFor(undefined), RECIPES[Scene.MODAL_SHEET]);
});

test('the recipes only use levels and blurs the policy defines', () => {
  // Guards the two closed vocabularies the service and the consuming surface read:
  // a typo would otherwise reach `uiMaterial.ImmersiveStyle` as an unknown level
  // and silently take the regular material.
  for (const scene of SCENES) {
    const recipe = Recipes.recipeFor(scene);
    assert.ok(LEVELS.includes(recipe.level), `${scene} level ${recipe.level} is not a platform style`);
    assert.ok(FALLBACK_BLURS.includes(recipe.fallbackBlur),
      `${scene} fallback blur ${recipe.fallbackBlur} is not a fallback blur`);
  }
});

test('the API 26 boundary and the material state decide whether a material is asked for', () => {
  // 21 is compatibleSdkVersion, 25 is the level below the first one that ships the
  // material, and 26 is that level itself.
  for (const apiLevel of [21, 25]) {
    for (const state of ['default', 'enable', 'disable']) {
      for (const reduceMotion of [false, true]) {
        for (const scene of SCENES) {
          const resolved = decision(scene, apiLevel, state, reduceMotion);
          assert.equal(resolved.apply, false, `api ${apiLevel} must never ask for a material`);
          assert.equal(resolved.colorInvert, false, `api ${apiLevel} must never invert`);
          assert.equal(resolved.interactive, false, `api ${apiLevel} must never deform`);
          assert.equal(resolved.lightEffect, false, `api ${apiLevel} must never light up`);
        }
      }
    }
  }

  for (const state of ['default', 'enable']) {
    for (const reduceMotion of [false, true]) {
      for (const scene of SCENES) {
        const resolved = decision(scene, 26, state, reduceMotion);
        const level = RECIPES[scene].level;
        assert.equal(resolved.apply, true, `${scene} must ask for a material at API 26 with state ${state}`);
        assert.equal(resolved.colorInvert, INVERTIBLE.includes(level),
          `${scene} inverts only if its ${level} material is thin enough`);
        assert.equal(resolved.interactive, !reduceMotion, `${scene} deform follows reduced motion`);
        assert.equal(resolved.lightEffect, !reduceMotion, `${scene} light feedback follows reduced motion`);
      }
    }
  }
});

test('the state the app switched off forbids every material at API 26', () => {
  for (const reduceMotion of [false, true]) {
    for (const scene of SCENES) {
      const resolved = decision(scene, 26, 'disable', reduceMotion);
      assert.equal(resolved.apply, false, 'a disabled app-level state must forbid the material');
      assert.equal(resolved.colorInvert, false);
      assert.equal(resolved.interactive, false);
      assert.equal(resolved.lightEffect, false);
    }
  }
});

test('an unmeasurable API level is not evidence of API 26', () => {
  const junk = [0, -21, NaN, Infinity, -Infinity, undefined, null, '26', true, {}];
  for (const apiLevel of junk) {
    const resolved = resolveImmersiveMaterial(Scene.TOP_CHROME, snapshot(apiLevel, 'default', false));
    assert.equal(resolved.apply, false, `${String(apiLevel)} must not enable the material`);
    assert.equal(resolved.interactive, false);
  }
});

test('a rejected decision still answers the whole fallback surface', () => {
  // The degradation path is the shipped one on every device below API 26, so it can
  // never depend on the gate having passed.
  for (const apiLevel of [21, 25, NaN]) {
    for (const state of ['default', 'disable']) {
      for (const reduceMotion of [false, true]) {
        for (const scene of SCENES) {
          const resolved = decision(scene, apiLevel, state, reduceMotion);
          assert.deepEqual({
            fallbackBlur: resolved.fallbackBlur,
            floorColor: resolved.floorColor,
            hairlineColor: resolved.hairlineColor
          }, {
            fallbackBlur: RECIPES[scene].fallbackBlur,
            floorColor: RECIPES[scene].floorColor,
            hairlineColor: RECIPES[scene].hairlineColor
          }, `${scene} must keep its full fallback recipe when the material is refused`);
          assert.equal(resolved.level, RECIPES[scene].level,
            'the requested level stays readable even when the material is refused');
        }
      }
    }
  }
});

test('the recipe colours are the theme tokens and resources the surfaces paint with', () => {
  // The policy names colours the way `Theme.ets` does, so the names are checked
  // against the constants and against both appearance overrides: a name that only
  // exists in one theme would leave a fallback surface unreadable in the other.
  const theme = new Map();
  for (const match of fs.readFileSync(THEME, 'utf8')
    .matchAll(/export const ([A-Z][A-Z0-9_]*): ResourceColor = \$r\('app\.color\.([a-z0-9_]+)'\);/g)) {
    theme.set(match[1], match[2]);
  }
  const declared = new Set();
  for (const file of [lightColors, darkColors]) {
    for (const entry of JSON.parse(fs.readFileSync(file, 'utf8')).color) {
      declared.add(entry.name);
    }
  }
  const expected = {
    PAGE_BG: 'page_bg',
    PAGE_BG_OVERLAY: 'page_bg_overlay',
    CARD: 'card',
    CARD_OVERLAY: 'card_overlay',
    TOAST_BACKGROUND: 'toast_background',
    LINE: 'line'
  };
  for (const constant of Object.keys(expected)) {
    assert.equal(theme.get(constant), expected[constant],
      `Theme.ets ${constant} must stay app.color.${expected[constant]}`);
    assert.ok(declared.has(expected[constant]), `${expected[constant]} must exist in both themes`);
  }
  for (const scene of SCENES) {
    const recipe = Recipes.recipeFor(scene);
    for (const name of [recipe.floorColor, recipe.hairlineColor]) {
      assert.ok(declared.has(name), `${scene} names ${name}, which no theme declares`);
    }
  }
});

test('the service reads nothing from a page module', () => {
  // The service and the policy declare the same two contracts instead of sharing
  // them precisely because this import is forbidden by the mobile architecture
  // rules; the parity checks below are what keeps the pair honest.
  assert.doesNotMatch(serviceSource, /from '\.\.\/pages\//);
});

test('the service and the policy declare one contract', () => {
  const fields = (source, name) => {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\}`).exec(text);
    assert.ok(body, `${name} must stay declared`);
    const pairs = new Map();
    for (const line of body[1].split('\n')) {
      const field = /^\s*(\w+):\s*(.+);\s*$/.exec(line.replace(/\/\/.*$/, ''));
      if (field) {
        pairs.set(field[1], field[2]);
      }
    }
    return pairs;
  };
  const serviceSnapshot = fields(serviceSource, 'ImmersiveMaterialSnapshot');
  const policySnapshot = fields(policySource, 'ImmersiveMaterialSnapshot');
  assert.deepEqual([...serviceSnapshot.entries()].sort(), [...policySnapshot.entries()].sort(),
    'the snapshot the service fills must stay the one the policy resolves');

  const plan = fields(serviceSource, 'ImmersiveMaterialPlan');
  const resolved = fields(policySource, 'ImmersiveMaterialDecision');
  assert.deepEqual([...plan.keys()].sort(),
    ['apply', 'colorInvert', 'interactive', 'level', 'lightEffect'],
    'the plan must stay the material-facing projection of the decision');
  for (const [field, type] of plan) {
    assert.equal(resolved.get(field), type, `the plan field ${field} must match the decision's`);
  }

  const threshold = (source) => {
    const match = /IMMERSIVE_MATERIAL_API_LEVEL: number = (\d+)/.exec(source);
    assert.ok(match, 'the threshold must stay declared where a caller can read it');
    return Number(match[1]);
  };
  assert.equal(threshold(policySource), 26);
  assert.equal(threshold(serviceSource), threshold(policySource),
    'the service must gate on the same API level the policy resolves against');
});

test('the service touches no ImmersiveMaterial member below API 26', () => {
  for (const apiLevel of [21, 25, 0]) {
    const harness = serviceHarness({ apiLevel: apiLevel, state: 0, reduceMotion: false });
    assert.equal(harness.Service.supported(), false, `api ${apiLevel} must report no material support`);
    assert.deepEqual(harness.Service.snapshot(),
      { apiLevel: apiLevel, materialState: 'default', reduceMotion: false },
      'an older device reports the default state without asking the platform for one');
    assert.deepEqual(harness.accesses, [],
      `api ${apiLevel} must not touch any uiMaterial member, including the state enum`);
    // A plan built by hand, as a wiring mistake would: the device gate is re-read
    // inside the service, so it cannot reach the material API either.
    assert.equal(harness.Service.materialFor(planOf({})), undefined,
      `api ${apiLevel} must not build a material`);
    assert.deepEqual(harness.built, []);
    assert.deepEqual(harness.accesses, [], `api ${apiLevel} must still not have touched uiMaterial`);
  }
});

test('a device that will not render a material is reported unsupported and builds none', () => {
  // API 26 is necessary and not sufficient. The capability is defined by the device
  // and cannot be modified, and a material handed to a device that refuses it is
  // accepted and then ignored — so a build that succeeds is not evidence that a
  // material will be drawn. Reporting it as support would let a surface drop its
  // painted floor for a material that never arrives, which is the bare floating
  // panel this gate exists to prevent.
  const query = serviceHarness({ apiLevel: 26, state: 0, capable: false, reduceMotion: false });
  assert.equal(query.Service.supported(), false, 'a device without the capability must report unsupported');
  assert.deepEqual(query.accesses, ['isImmersiveMaterialSupported'],
    'the capability query must be the only member the answer is read from');

  const build = serviceHarness({ apiLevel: 26, state: 0, capable: false, reduceMotion: false });
  assert.equal(build.Service.materialFor(planOf({})), undefined,
    'an applying plan must still be refused on a device that will not render a material');
  assert.deepEqual(build.built, [], 'no material may be constructed on such a device');
  assert.deepEqual(build.accesses, ['isImmersiveMaterialSupported'],
    'the refused build must read the capability and nothing else: no style, no state, no material');
});

test('a device that will not render a material keeps the decision on its painted surface', () => {
  // The policy cannot know the device capability — it resolves API level, the app
  // switch and reduced motion — so `apply` stays true here on purpose. The
  // service's answer is what the caller must gate the paint drop on.
  const harness = serviceHarness({ apiLevel: 26, state: 1, capable: false, reduceMotion: false });
  const resolved = resolveImmersiveMaterial(Scene.TOP_CHROME, harness.Service.snapshot());
  assert.equal(resolved.apply, true, 'the decision is about the API level and the app switch alone');
  assert.equal(harness.Service.materialFor(planFromDecision(resolved)), undefined,
    'the material, not the decision, is what says whether a surface may drop its own paint');
  assert.deepEqual(harness.built, []);
  assert.equal(harness.accesses.includes('ImmersiveMaterial'), false,
    'the material constructor must not be reached');
  assert.equal(harness.accesses.includes('ImmersiveStyle'), false,
    'the style of a material that will not be drawn must not be resolved');
});

test('a capability read that fails is treated as unsupported and logged', () => {
  const harness = serviceHarness({ apiLevel: 26, state: 0, capabilityReadFails: true, reduceMotion: false });
  assert.equal(harness.Service.supported(), false, 'a failed capability read must not read as support');
  assert.equal(harness.Service.materialFor(planOf({})), undefined);
  assert.deepEqual(harness.built, []);
  // One entry per failed read: the query is logged where it fails, so a device
  // that cannot answer is diagnosable rather than silently material-less.
  assert.equal(harness.logs.length, 2, 'each failed capability read must be logged');
  for (const entry of harness.logs) {
    assert.match(entry, /^Immersive material capability read failed/);
  }
});

test('the service builds one material from the plan a decision resolves', () => {
  const harness = serviceHarness({ apiLevel: 26, state: 0, reduceMotion: false });
  assert.equal(harness.Service.supported(), true, 'a capable device must report support');
  const filled = harness.Service.snapshot();
  assert.deepEqual(filled, { apiLevel: 26, materialState: 'default', reduceMotion: false });

  // Exactly the wiring sequence a surface will use: one snapshot, one decision,
  // one plan, one material.
  const resolved = resolveImmersiveMaterial(Scene.TOP_CHROME, filled);
  const material = harness.Service.materialFor(planFromDecision(resolved));
  assert.ok(material, 'an applying plan must build a material');
  assert.deepEqual(harness.built, [{
    style: STYLES.ultra_thin,
    interactive: true,
    colorInvert: true,
    lightEffect: {}
  }], 'the options must carry the style, both motion flags and the light feedback only');

  const solid = resolveImmersiveMaterial(Scene.MODAL_SHEET, filled);
  harness.Service.materialFor(planFromDecision(solid));
  assert.deepEqual(harness.built[1], {
    style: STYLES.ultra_thick,
    interactive: true,
    colorInvert: false,
    lightEffect: {}
  }, 'a thick material must not claim the complementary-colour adaptation');
});

test('the service maps every recipe level and never guesses at a thin one', () => {
  for (const level of LEVELS) {
    const harness = serviceHarness({ apiLevel: 26, state: 0, reduceMotion: false });
    harness.Service.materialFor(planOf({ level: level }));
    assert.equal(harness.built.length, 1, `level ${level} must build one material`);
    assert.equal(harness.built[0].style, STYLES[level], `level ${level} must map to its own style`);
  }
  const unknown = serviceHarness({ apiLevel: 26, state: 0, reduceMotion: false });
  unknown.Service.materialFor(planOf({ level: 'soap_bubble', colorInvert: false }));
  assert.equal(unknown.built[0].style, STYLES.regular, 'an unknown level must fall back to the regular style');
  assert.equal(unknown.logs.length, 1, 'an unknown level must be announced');
});

test('reduced motion keeps the material and drops its motion', () => {
  const harness = serviceHarness({ apiLevel: 26, state: 0, reduceMotion: true });
  harness.Service.materialFor(planOf({ interactive: false, lightEffect: false }));
  assert.deepEqual(harness.built[0], {
    style: STYLES.thin,
    interactive: false,
    colorInvert: true,
    lightEffect: null
  }, 'the light feedback must be switched off explicitly, not left undefined');
});

test('a plan that does not apply is not built at all', () => {
  const harness = serviceHarness({ apiLevel: 26, state: 1, reduceMotion: false });
  assert.equal(harness.Service.materialFor(planOf({ apply: false })), undefined);
  assert.deepEqual(harness.built, []);
  assert.deepEqual(harness.accesses, [], 'a refused plan must not reach getMaterialInfo either');
});

test('the material state follows the metadata and a failed read stays the default', () => {
  const expected = { 0: 'default', 1: 'enable', 2: 'disable' };
  for (const state of Object.keys(expected)) {
    const harness = serviceHarness({ apiLevel: 26, state: Number(state), reduceMotion: false });
    assert.equal(harness.Service.snapshot().materialState, expected[state],
      `MaterialState ${state} must report ${expected[state]}`);
  }
  const failed = serviceHarness({ apiLevel: 26, stateReadFails: true, reduceMotion: false });
  assert.equal(failed.Service.snapshot().materialState, 'default',
    'a failed state read must report the default rather than switch materials off');
  assert.equal(failed.logs.length, 1, 'a failed state read must be logged');
  // The app switched the material off: the state reaches the decision, which is
  // what stops every surface from asking for one.
  const disabled = serviceHarness({ apiLevel: 26, state: 2, reduceMotion: false });
  const resolved = resolveImmersiveMaterial(Scene.SEARCH_FIELD, disabled.Service.snapshot());
  assert.equal(resolved.apply, false);
  assert.equal(disabled.Service.materialFor(planFromDecision(resolved)), undefined);
  assert.deepEqual(disabled.built, []);
});

test('a construction the platform refuses stays a fallback surface and is logged', () => {
  const harness = serviceHarness({ apiLevel: 26, state: 0, constructionFails: true, reduceMotion: false });
  assert.equal(harness.Service.materialFor(planOf({})), undefined,
    'a refused construction must leave the caller on its painted surface');
  assert.deepEqual(harness.built, []);
  assert.equal(harness.logs.length, 1, 'a refused construction must be logged in English');
  assert.match(harness.logs[0], /^Immersive material construction failed for level thin/);
});
