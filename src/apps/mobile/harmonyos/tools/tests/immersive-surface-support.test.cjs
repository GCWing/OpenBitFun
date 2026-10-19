const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The wiring helper is where the compatibility floor lives: on every device below
// API 26 it must hand back exactly the options the caller wrote, and only a device
// that can render the material may rewrite them. Neither half is visible from a
// screenshot of a device that supports materials, so both paths run here as the
// real `.ets` source against a stubbed service, with the real (pure) policy.
//
// The helper is transpiled and loaded like the service in
// `immersive-material-policy.test.cjs`; nothing in this file touches `uiMaterial`,
// so the degradation path is exercised on any host.
const ENTRY = path.join(__dirname, '../../entry/src/main');
const SUPPORT = path.join(ENTRY, 'ets/pages/components/ImmersiveSurfaceSupport.ets');
const POLICY = path.join(ENTRY, 'ets/pages/policy/ImmersiveMaterialPolicy.ets');

// One distinct value per theme colour the helper may resolve a contract key to,
// so a mixed-up fallback is a failed identity check rather than a colour that
// happens to match. The names are the ones `Theme.ets` exports for the contract's
// colour names, so this stub is also what proves the resolver picks one of them.
const THEME = {
  TRANSPARENT: 'app.color.transparent',
  PAGE_BG: 'app.color.page_bg',
  PAGE_BG_OVERLAY: 'app.color.page_bg_overlay',
  CARD: 'app.color.card',
  CARD_OVERLAY: 'app.color.card_overlay',
  TOAST_BACKGROUND: 'app.color.toast_background',
  LINE: 'app.color.line',
  SHADOW_SUBTLE: 'app.color.shadow_subtle'
};
const THEME_VALUES = Object.values(THEME);
const TRANSPARENT = THEME.TRANSPARENT;
const PAGE_BG = THEME.PAGE_BG;
const CARD = THEME.CARD;
const LINE = THEME.LINE;
const SHADOW_SUBTLE = THEME.SHADOW_SUBTLE;

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
const SCENES = Object.values(Scene);

/**
 * The helper, loaded against a service that answers the way a device would.
 *
 * `built` and `plans` record every material the helper asked the service for, so
 * "the fallback path never builds one" and "the material is built once per scene"
 * are assertions rather than comments. `motion` is the reduced-motion answer the
 * helper reads: it is mutable, because the user can change it while the app runs,
 * and `motionReads` counts how often the helper asked.
 */
function supportHarness(options) {
  const built = [];
  const plans = [];
  const reads = [];
  const motionReads = [];
  const motion = { reduceMotion: options.reduceMotion === true };
  const service = {
    snapshot() {
      reads.push('snapshot');
      return {
        apiLevel: options.apiLevel,
        materialState: options.materialState === undefined ? 'default' : options.materialState,
        reduceMotion: false
      };
    },
    materialFor(plan) {
      plans.push(plan);
      if (!plan.apply || options.constructionFails === true) {
        return undefined;
      }
      const material = { level: plan.level };
      built.push(material);
      return material;
    }
  };
  const exported = {};
  new Function('require', 'exports', transpile(fs.readFileSync(SUPPORT, 'utf8')))(
    (specifier) => {
      if (specifier === '@kit.ArkUI') {
        return { promptAction: {} };
      }
      if (specifier === '../policy/ImmersiveMaterialPolicy') {
        return loadPolicy();
      }
      if (specifier === '../../services/ImmersiveMaterialService') {
        return { ImmersiveMaterialService: service };
      }
      if (specifier === '../../services/MotionPreference') {
        return { MotionPreference: { reduceMotion() {
          motionReads.push(motion.reduceMotion);
          return motion.reduceMotion;
        } } };
      }
      if (specifier === './Theme') {
        return THEME;
      }
      throw new Error(`the wiring helper must not import ${specifier}`);
    },
    exported);
  return { Support: exported.ImmersiveSurfaceSupport, built, plans, reads, motionReads, motion };
}

function sheetOptions(overrides) {
  return Object.assign({ height: 300, backgroundColor: PAGE_BG, maskColor: LINE }, overrides);
}

test('below API 26 every surface keeps the options the caller wrote', () => {
  const harness = supportHarness({ apiLevel: 21 });

  for (const scene of SCENES) {
    assert.equal(harness.Support.usesMaterial(scene), false, `${scene} must not ask for a material`);

    const sheet = sheetOptions({});
    assert.equal(harness.Support.sheetOptions(scene, sheet), sheet,
      `${scene} must return the sheet options unchanged, not a copy`);
    assert.equal(sheet.backgroundColor, PAGE_BG, `${scene} must keep its own sheet fill`);
    assert.equal(sheet.systemMaterial, undefined, `${scene} must not inject a material`);

    const popup = { popupColor: TRANSPARENT, targetSpace: 8 };
    assert.equal(harness.Support.popupOptions(scene, popup), popup,
      `${scene} must return the popup options unchanged`);
    assert.equal(popup.systemMaterial, undefined);

    const toast = { message: 'hello', duration: 2600 };
    assert.equal(harness.Support.toastOptions(scene, toast), toast,
      `${scene} must return the toast options unchanged`);
    assert.equal(toast.systemMaterial, undefined);

    assert.equal(harness.Support.menuOptions(scene, undefined), undefined,
      `${scene} must leave an options-less menu options-less`);

    // The content roots' fallback: the recipe's floor and hairline, and the
    // caller's own shadow — the recipe table has no shadow field.
    const recipe = policy.ImmersiveSurfaceRecipes.recipeFor(scene);
    assert.equal(harness.Support.surfaceFill(scene), harness.Support.floorColor(recipe.floorColor),
      `${scene} must paint the floor colour its recipe names`);
    assert.equal(harness.Support.surfaceFill(scene, CARD), CARD,
      `${scene} must keep a floor a caller overrides`);
    const border = { width: 0.5 };
    assert.equal(harness.Support.surfaceBorder(scene, border), border);
    assert.deepEqual(border, { width: 0.5, color: LINE },
      `${scene} must keep its width and take the recipe's hairline`);
    const shadow = { radius: 18, color: SHADOW_SUBTLE, offsetY: 7 };
    assert.equal(harness.Support.surfaceShadow(scene, shadow), shadow);
    assert.deepEqual(shadow, { radius: 18, color: SHADOW_SUBTLE, offsetY: 7 },
      `${scene} must keep its fallback shadow`);
  }

  assert.deepEqual(harness.built, [], 'the fallback path must not build a material');
});

test('API 26 injects one material and makes the conflicting decoration transparent', () => {
  const harness = supportHarness({ apiLevel: 26 });

  const sheet = sheetOptions({});
  harness.Support.sheetOptions(Scene.MODAL_SHEET, sheet);
  assert.equal(sheet.systemMaterial, harness.built[0], 'the sheet must carry the resolved material');
  assert.equal(sheet.backgroundColor, TRANSPARENT, 'the material owns the sheet background');
  assert.equal(sheet.height, 300, 'geometry stays the caller\'s');

  const popup = { popupColor: PAGE_BG, targetSpace: 8 };
  harness.Support.popupOptions(Scene.FLOATING_MENU, popup);
  assert.equal(popup.systemMaterial, harness.built[1], 'the popup must carry the resolved material');
  assert.equal(popup.popupColor, TRANSPARENT, 'the popup bubble must be transparent over the material');
  assert.equal(popup.targetSpace, 8, 'popup geometry stays the caller\'s');

  const created = harness.Support.menuOptions(Scene.FLOATING_MENU, undefined);
  assert.equal(created.systemMaterial, harness.built[1],
    'an options-less menu must be given the float scene\'s material');
  assert.equal(created.backgroundColor, TRANSPARENT);

  const menu = { enableArrow: false };
  assert.equal(harness.Support.menuOptions(Scene.FLOATING_MENU, menu), menu,
    'a menu with options must keep its own object');
  assert.equal(menu.systemMaterial, harness.built[1], 'the same scene must reuse its material');
  assert.equal(menu.backgroundColor, TRANSPARENT);
  assert.equal(menu.enableArrow, false, 'menu geometry stays the caller\'s');

  const toast = { message: 'hello', duration: 2600 };
  harness.Support.toastOptions(Scene.TOAST, toast);
  assert.equal(toast.systemMaterial, harness.built[2], 'the toast must carry the resolved material');
  assert.equal(toast.message, 'hello', 'toast copy is untouched');

  assert.equal(harness.Support.usesMaterial(Scene.MODAL_SHEET), true);
  assert.equal(harness.Support.surfaceFill(Scene.MODAL_SHEET), TRANSPARENT,
    'the content root must not paint over the material');
  assert.equal(harness.Support.surfaceFill(Scene.MODAL_SHEET, CARD), TRANSPARENT,
    'a caller override must not survive the material path either');
  assert.deepEqual(harness.Support.surfaceBorder(Scene.MODAL_SHEET, { width: 0.5 }),
    { width: 0, color: TRANSPARENT }, 'the hairline must be dropped');
  assert.deepEqual(harness.Support.surfaceShadow(Scene.MODAL_SHEET, { radius: 18, color: SHADOW_SUBTLE, offsetY: 7 }),
    { radius: 0, color: TRANSPARENT, offsetY: 7 }, 'the shadow must be dropped, the offset kept');
});

test('the device is read once and each scene builds at most one material', () => {
  const harness = supportHarness({ apiLevel: 26 });

  // Two scenes, each asked for more than once, as a rebuild would.
  harness.Support.sheetOptions(Scene.MODAL_SHEET, sheetOptions({}));
  harness.Support.usesMaterial(Scene.MODAL_SHEET);
  harness.Support.surfaceFill(Scene.MODAL_SHEET, CARD);
  harness.Support.popupOptions(Scene.FLOATING_MENU, { popupColor: TRANSPARENT });
  harness.Support.surfaceShadow(Scene.FLOATING_MENU, { radius: 18, color: SHADOW_SUBTLE });
  harness.Support.usesMaterial(Scene.FLOATING_MENU);

  assert.deepEqual(harness.reads, ['snapshot'], 'the device facts must be read once per process');
  assert.equal(harness.built.length, 2, 'each scene must build its material once, not per call');
  assert.notEqual(harness.built[0], harness.built[1], 'two scenes keep their own thickness');
});

test('an app-level disable takes the fallback path without touching the platform', () => {
  const harness = supportHarness({ apiLevel: 26, materialState: 'disable' });
  const sheet = sheetOptions({});
  harness.Support.sheetOptions(Scene.MODAL_SHEET, sheet);
  assert.equal(sheet.systemMaterial, undefined, 'a disabled app must not adopt the material');
  assert.equal(sheet.backgroundColor, PAGE_BG, 'and must keep the sheet it paints itself');
  assert.deepEqual(harness.built, []);
});

test('a refused construction leaves the caller on its own surface', () => {
  const harness = supportHarness({ apiLevel: 26, constructionFails: true });
  const sheet = sheetOptions({});
  harness.Support.sheetOptions(Scene.MODAL_SHEET, sheet);
  assert.equal(sheet.systemMaterial, undefined);
  assert.equal(sheet.backgroundColor, PAGE_BG, 'a refused material must not clear the fill');
  assert.equal(harness.Support.usesMaterial(Scene.MODAL_SHEET), false);
  assert.deepEqual(harness.built, []);
});

test('the fallback colours come from the recipe contract, key for key', () => {
  const harness = supportHarness({ apiLevel: 21 });
  const recipes = Object.values(Scene).map((scene) => policy.ImmersiveSurfaceRecipes.recipeFor(scene));
  const floorKeys = [...new Set(recipes.map((recipe) => recipe.floorColor))].sort();
  const hairlineKeys = [...new Set(recipes.map((recipe) => recipe.hairlineColor))].sort();

  // The resolver's vocabulary and the contract's colour names are one set: a key
  // the contract adds and the resolver does not know (or the other way around) is a
  // surface painting a colour nobody declared.
  assert.deepEqual(harness.Support.FLOOR_COLOR_KEYS.slice().sort(), floorKeys,
    'the floor keys the resolver knows must be the ones the contract names');
  assert.deepEqual(harness.Support.HAIRLINE_COLOR_KEYS.slice().sort(), hairlineKeys,
    'the hairline keys the resolver knows must be the ones the contract names');

  // Each key resolves to its own declared colour, so a key that quietly fell
  // through to another key's colour is a failed comparison rather than a shade
  // nobody notices.
  const floors = floorKeys.map((key) => harness.Support.floorColor(key));
  floors.forEach((colour, index) => assert.ok(THEME_VALUES.includes(colour),
    `${floorKeys[index]} must resolve to a Theme.ets colour, not ${colour}`));
  assert.equal(new Set(floors).size, floors.length, 'each floor key must keep its own colour');
  assert.equal(floors.includes(TRANSPARENT), false, 'a floor must never resolve to transparent');
  const hairlines = hairlineKeys.map((key) => harness.Support.hairlineColor(key));
  hairlines.forEach((colour, index) => assert.ok(THEME_VALUES.includes(colour),
    `${hairlineKeys[index]} must resolve to a Theme.ets colour, not ${colour}`));
  assert.equal(new Set(hairlines).size, hairlines.length, 'each hairline key must keep its own colour');
  assert.equal(hairlines.includes(TRANSPARENT), false, 'a hairline must never resolve to transparent');
});

test('a reduced-motion change resolves the scene again and keeps the device facts cached', () => {
  const harness = supportHarness({ apiLevel: 26 });
  assert.equal(harness.Support.usesMaterial(Scene.MODAL_SHEET), true);
  assert.deepEqual(
    { interactive: harness.plans[0].interactive, lightEffect: harness.plans[0].lightEffect },
    { interactive: true, lightEffect: true },
    'a motion-permitting user gets the material interactions');

  harness.motion.reduceMotion = true;
  assert.equal(harness.Support.usesMaterial(Scene.MODAL_SHEET), true,
    'reduced motion keeps the material and only drops its motion');
  assert.equal(harness.built.length, 2, 'the other answer must be resolved, not reused');
  assert.equal(harness.plans[1].apply, true, 'the material itself stays');
  assert.equal(harness.plans[1].interactive, false, 'reduced motion turns the deformation off');
  assert.equal(harness.plans[1].lightEffect, false, 'and the light feedback with it');
  assert.deepEqual(harness.reads, ['snapshot'],
    'the API level and the material state are still read once per process');

  // Each answer is kept: toggling is a cache hit, never a third material.
  harness.motion.reduceMotion = false;
  assert.equal(harness.Support.usesMaterial(Scene.MODAL_SHEET), true);
  assert.equal(harness.built.length, 2, 'a scene must hold one material per answer, not one per toggle');
  harness.motion.reduceMotion = true;
  harness.Support.usesMaterial(Scene.MODAL_SHEET);
  assert.equal(harness.built.length, 2, 'and the cache must not grow past those two');
  assert.deepEqual(harness.motionReads, [false, true, false, true],
    'reduce motion must be read on every access, in the order the answer changed, ' +
    'rather than frozen with the device facts');
});
