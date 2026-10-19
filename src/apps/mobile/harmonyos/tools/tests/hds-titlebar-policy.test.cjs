const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// The HDS title bar's band is the platform's, and the members that describe it do
// not all arrive at once. `titleBar`, `TitleBarStyleOptions.originalStyle` /
// `scrollEffectStyle` and `ScrollEffectType.GRADIENT_BLUR` start at 5.1.0(18) /
// 6.0.0(20), so the app's `compatibleSdkVersion` 6.0.1(21) can name them
// everywhere; `ScrollEffectType.IMMERSIVE_GRADIENT_BLUR`, `systemMaterialEffect`
// and every `hdsMaterial` member start at 6.1.0(23). Two things have to hold
// across that gap, and neither is visible from a screenshot:
//
//   1. the tier table is one contract — which blur a level asks for, and which
//      material level it may ask for;
//   2. no 23+ member is touched on a device below API 23, and no `hdsMaterial`
//      member is touched below API 26, because a member that does not exist is
//      not a value the platform can ignore.
//
// So the pure policy runs here as the real `.ets` source (it imports nothing), and
// the service runs against a stubbed `@kit.UIDesignKit` whose every member records
// the read, which is what turns "the gate is strict" into an assertion.
const ENTRY = path.join(__dirname, '../../entry/src/main');
const POLICY = path.join(ENTRY, 'ets/pages/policy/HdsTitleBarPolicy.ets');
const SERVICE = path.join(ENTRY, 'ets/services/HdsTitleBarMaterialService.ets');
const SUPPORT = path.join(ENTRY, 'ets/pages/components/HdsTitleBarSupport.ets');

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
const Scene = policy.HdsTitleBarScene;
const Policy = policy.HdsTitleBarPolicy;
const resolveHdsTitleBar = policy.resolveHdsTitleBar;

const policySource = fs.readFileSync(POLICY, 'utf8');
const serviceSource = fs.readFileSync(SERVICE, 'utf8');

// The contract as this test reads it: one literal per tier, independent of the
// table under test, so a change to either side has to be made in both. `smooth` on
// the levels that cannot answer the material question is deliberate — it is the
// level the platform's own guidance asks for on a device that reports no
// immersive material type — and `adaptive` is the recommended level everywhere
// else, because the system then picks the cost from the device's performance.
const TIERS = [
  { apiLevel: 0, material: false, blur: 'gradient_blur', level: 'smooth', attached: false },
  { apiLevel: 21, material: false, blur: 'gradient_blur', level: 'smooth', attached: false },
  { apiLevel: 22, material: true, blur: 'gradient_blur', level: 'smooth', attached: false },
  { apiLevel: 23, material: false, blur: 'immersive_gradient_blur', level: 'smooth', attached: true },
  { apiLevel: 25, material: true, blur: 'immersive_gradient_blur', level: 'smooth', attached: true },
  { apiLevel: 26, material: false, blur: 'immersive_gradient_blur', level: 'smooth', attached: true },
  { apiLevel: 26, material: true, blur: 'immersive_gradient_blur', level: 'adaptive', attached: true },
  { apiLevel: 28, material: true, blur: 'immersive_gradient_blur', level: 'adaptive', attached: true }
];
const BLURS = ['gradient_blur', 'immersive_gradient_blur'];
const LEVELS = ['smooth', 'adaptive'];

function decision(apiLevel, immersiveMaterialSupported, scene) {
  return resolveHdsTitleBar(scene === undefined ? Scene.Conversation : scene, {
    apiLevel: apiLevel,
    immersiveMaterialSupported: immersiveMaterialSupported
  });
}

// The service, loaded with a `@kit.UIDesignKit` whose every member records the
// read. A getter is the only way to see a member the service never should have
// looked at: an accessing getter turns a missing call into a recorded one, and
// `getSystemMaterialTypes` answers the list the device reports.
function serviceHarness(options) {
  const accesses = [];
  const logs = [];
  const apiLevel = options.apiLevel;
  const types = options.types === undefined ? [2] : options.types;
  const member = (target, name, value) => Object.defineProperty(target, name, {
    get: () => {
      accesses.push(name);
      return value();
    }
  });
  const materialType = {};
  // 2 is `MaterialType.IMMERSIVE`, 0 is `NONE`: the two members this app reads. The
  // enum member is recorded under its own dotted name, so a comparison the service
  // should not have made is visible as a read of that member rather than as a
  // second read of the enum object.
  const typeMember = (name, value) => Object.defineProperty(materialType, name, {
    get: () => {
      accesses.push(`MaterialType.${name}`);
      return value();
    }
  });
  typeMember('IMMERSIVE', () => 2);
  typeMember('NONE', () => 0);
  const hdsMaterial = {};
  member(hdsMaterial, 'MaterialType', () => materialType);
  member(hdsMaterial, 'getSystemMaterialTypes', () => () => {
    if (options.readFails === true) {
      throw new Error('material types unavailable');
    }
    return types;
  });

  const exported = {};
  new Function('require', 'exports', transpile(serviceSource))(
    (specifier) => {
      if (specifier === '@kit.UIDesignKit') {
        return { hdsMaterial: hdsMaterial };
      }
      if (specifier === './DeviceApiLevelService') {
        return { DeviceApiLevelService: { sdkApiVersion: () => apiLevel } };
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
  return { Service: exported.HdsTitleBarMaterialService, accesses: accesses, logs: logs };
}

test('the policy stays pure so the tier table runs on the host', () => {
  // No import at all: a platform import here would move the gate out of reach of
  // this runner, and a component would reach a kit through a policy file. The file
  // names the platform types in its own comments, so the assertions read the code
  // with the comments taken out.
  const code = policySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^\s*import\b/m);
  assert.doesNotMatch(code, /from '@kit|from '@ohos/);
  // The platform's own spellings stay out as well: the policy answers in its own
  // vocabulary, and the support class is the only place the members are named.
  assert.doesNotMatch(code, /ScrollEffectType\s*\./);
  assert.doesNotMatch(code, /hdsMaterial\s*\./);
});

test('the four tiers are the table, and the material follows the level it is on', () => {
  for (const tier of TIERS) {
    const resolved = decision(tier.apiLevel, tier.material);
    const where = `api ${tier.apiLevel} with material ${tier.material}`;
    assert.equal(resolved.scrollEffectType, tier.blur, `${where} must ask for ${tier.blur}`);
    assert.equal(resolved.materialLevel, tier.level, `${where} must ask for the ${tier.level} material level`);
    assert.equal(resolved.materialAttached, tier.attached,
      `${where} must ${tier.attached ? '' : 'not '}attach the material effect`);
    assert.equal(resolved.immersiveBlur, tier.attached,
      `${where} must name the 23+ blur only where it may name the 23+ material`);
    assert.equal(resolved.materialType, 'adaptive',
      `${where} must ask the system to choose the material type`);
    assert.ok(BLURS.includes(resolved.scrollEffectType), `${where} must stay inside the blur vocabulary`);
    assert.ok(LEVELS.includes(resolved.materialLevel), `${where} must stay inside the level vocabulary`);
  }
});

test('the gates are the levels the platform ships, and the fallback is the oldest tier', () => {
  // 21 is compatibleSdkVersion, 22 is the level below the first one that ships the
  // immersive members, 23 is that level, 25 is below the one that ships
  // `hdsMaterial`, 26 is that level.
  assert.equal(Policy.IMMERSIVE_BLUR_API_LEVEL, 23);
  assert.equal(Policy.IMMERSIVE_MATERIAL_API_LEVEL, 26);
  for (let apiLevel = 0; apiLevel <= 30; apiLevel++) {
    for (const material of [false, true]) {
      const resolved = decision(apiLevel, material);
      const where = `api ${apiLevel} with material ${material}`;
      assert.equal(resolved.materialAttached, resolved.immersiveBlur,
        `${where} must attach the material effect exactly where it may name the 23+ blur`);
      if (apiLevel >= Policy.IMMERSIVE_BLUR_API_LEVEL) {
        assert.equal(resolved.scrollEffectType, 'immersive_gradient_blur', `${where} may name the immersive blur`);
      } else {
        assert.equal(resolved.scrollEffectType, 'gradient_blur',
          `${where} must fall back to the blur every supported device has`);
        assert.equal(resolved.immersiveBlur, false, `${where} must not claim the 23+ blur`);
        assert.equal(resolved.materialAttached, false, `${where} must not attach the 23+ field`);
      }
      assert.equal(resolved.materialLevel === 'adaptive',
        apiLevel >= Policy.IMMERSIVE_MATERIAL_API_LEVEL && material === true,
        `${where} may only follow the system's own level where the question can be asked and the answer is yes`);
    }
  }
  // A level that cannot be measured is not evidence of a modern device: a read that
  // failed reports `0`, and a device that cannot say what it is takes the oldest
  // tier — the one that names no 23+ member at all.
  for (const unmeasurable of [0, -1, undefined, null, NaN, Infinity, 'twenty-six']) {
    assert.equal(Policy.measurable(unmeasurable), 0,
      `${unmeasurable} is not a measured level and must not be treated as one`);
    assert.equal(decision(unmeasurable, true).scrollEffectType, 'gradient_blur',
      `${unmeasurable} must take the tier that names no 23+ member`);
    assert.equal(decision(unmeasurable, true).materialAttached, false);
  }
  assert.equal(Policy.measurable(21), 21);
});

test('the band\'s height is the bar mode the app asks for, not the device', () => {
  // `titleBar` overlays the content rather than insetting it, so the page below
  // reserves the bar's own height — and that is a property of the platform mode,
  // which the app picks, not of the device.
  assert.equal(Policy.TITLE_BAR_HEIGHT_MINI, 56);
  assert.equal(Policy.barHeight(Scene.Conversation), Policy.TITLE_BAR_HEIGHT_MINI);
  assert.equal(Policy.barHeight('not_a_scene'), 0,
    'a scene the table does not know reserves nothing: the zero case is the one that keeps a page from ' +
    'reserving a bar nobody draws');
});

test('the reserved offset is the band plus the strip the band covers', () => {
  // The band is the component-level safe area (`enableComponentSafeArea`), so its
  // box reaches the top of the window and covers the status bar strip; everything
  // that has to sit below it — the pane's rename row, and the transcript's content
  // start — reserves the strip and the bar. The strip is a device measurement and
  // the bar is this table's, so the sum is resolved here rather than at a call site.
  assert.equal(Policy.reservedBandHeight(Scene.Conversation, 44), 100,
    'the strip the band covers must be reserved as well as the bar under it');
  assert.equal(Policy.reservedBandHeight(Scene.Conversation, 0), Policy.TITLE_BAR_HEIGHT_MINI,
    'the bar half is the one that must never be dropped');
  // A measurement that is not one reserves nothing extra, the same rule the tier
  // table applies to an unmeasurable API level.
  for (const unmeasured of [undefined, null, NaN, -1, Infinity, '44']) {
    assert.equal(Policy.reservedBandHeight(Scene.Conversation, unmeasured), Policy.TITLE_BAR_HEIGHT_MINI,
      `${unmeasured} is not a measured strip and must not grow the reserved offset`);
  }
  assert.equal(Policy.reservedBandHeight('not_a_scene', 44), 44,
    'a scene with no bar reserves the strip alone, which is what a page at the window\'s top edge already did');
});

test('the blur family follows the scene, and the gate outranks it', () => {
  assert.equal(Policy.blurFor(Scene.Conversation, false), 'gradient_blur',
    'a device below 23 gets the plain gradient blur on every scene');
  assert.equal(Policy.blurFor(Scene.Conversation, true), 'immersive_gradient_blur',
    'the conversation route is the immersive scene: a transcript scrolls under it');
  assert.equal(Policy.blurFor('not_a_scene', true), 'gradient_blur',
    'a surface the table does not know must not claim the immersive blur');
});

test('the service reads no 23+ member below the level that ships it', () => {
  // The order is the point: the level first, then the member. Below 26 the read is
  // never attempted — not attempted-and-caught — and the answer is `false`, which
  // is the SMOOTH tier rather than a title bar that never appears.
  for (const apiLevel of [21, 22, 25, 0, undefined, NaN]) {
    const harness = serviceHarness({ apiLevel: apiLevel });
    assert.equal(harness.Service.immersiveMaterialSupported(), false,
      `api ${apiLevel} must not report the immersive material`);
    assert.deepEqual(harness.accesses, [],
      `api ${apiLevel} must not look at a single \`hdsMaterial\` member`);
    assert.deepEqual(harness.logs, [], `api ${apiLevel} must not log a failure it never had`);
  }
  for (const apiLevel of [23, 25]) {
    const harness = serviceHarness({ apiLevel: apiLevel });
    assert.equal(harness.Service.immersiveBlurSupported(), true,
      `api ${apiLevel} ships the immersive blur and may name it`);
  }
  for (const apiLevel of [21, 22, 0, undefined, NaN]) {
    const harness = serviceHarness({ apiLevel: apiLevel });
    assert.equal(harness.Service.immersiveBlurSupported(), false,
      `api ${apiLevel} must not claim the 23+ blur`);
    assert.deepEqual(harness.accesses, [], `api ${apiLevel} must not read the material table either`);
  }
});

test('the service asks the material question once, and only where it can be asked', () => {
  // 26+ with the immersive type: one read of the table, one read of the enum member.
  const capable = serviceHarness({ apiLevel: 26, types: [2] });
  assert.equal(capable.Service.immersiveMaterialSupported(), true);
  assert.deepEqual(capable.accesses, ['getSystemMaterialTypes', 'MaterialType', 'MaterialType.IMMERSIVE'],
    'the table is read once and the enum member compared once');
  assert.equal(capable.accesses.filter((access) => access === 'getSystemMaterialTypes').length, 1,
    'a capability question asks the device once, however many times it is answered from the answer');
  // 26+ without it: the same two reads answer no, and the tier is the SMOOTH one.
  const withoutType = serviceHarness({ apiLevel: 26, types: [1, 3] });
  assert.equal(withoutType.Service.immersiveMaterialSupported(), false,
    'a device that reports other material types does not report the immersive one');
  assert.deepEqual(withoutType.accesses, ['getSystemMaterialTypes', 'MaterialType', 'MaterialType.IMMERSIVE'],
    'a device that lists no immersive type is still asked the same two questions, and answered no');
  const none = serviceHarness({ apiLevel: 26, types: [] });
  assert.equal(none.Service.immersiveMaterialSupported(), false,
    'a device that reports no material type at all does not report the immersive one');
  // A read that throws is a device that cannot tell: the answer is the SMOOTH
  // tier, and the failure is recorded rather than thrown into the build.
  const failing = serviceHarness({ apiLevel: 26, readFails: true });
  assert.equal(failing.Service.immersiveMaterialSupported(), false);
  assert.equal(failing.logs.length, 1,
    'a capability read that fails has to be logged: a silent false is a tier nobody can explain');
});

test('the snapshot reports the two facts the policy resolves from, in one answer', () => {
  const capable = serviceHarness({ apiLevel: 26, types: [2] });
  assert.deepEqual(capable.Service.snapshot(), { apiLevel: 26, immersiveMaterialSupported: true });
  // The capability question reads the level itself first, so a snapshot on an old
  // device is still two platform reads at most and touches no material member.
  const old = serviceHarness({ apiLevel: 21 });
  assert.deepEqual(old.Service.snapshot(), { apiLevel: 21, immersiveMaterialSupported: false });
  assert.deepEqual(old.accesses, []);
});

test('the gate is written as an order, not as a flag beside the member', () => {
  // The behavioural assertions above hold the read; this one holds the shape that
  // makes the read impossible to reach: the level is read before the table, and
  // the table is inside the branch rather than merged into the return.
  const levelRead = serviceSource.indexOf('DeviceApiLevelService.sdkApiVersion()');
  const tableRead = serviceSource.indexOf('hdsMaterial.getSystemMaterialTypes()');
  const enumRead = serviceSource.indexOf('hdsMaterial.MaterialType.IMMERSIVE');
  assert.notEqual(levelRead, -1, 'the service must read the device level');
  assert.notEqual(tableRead, -1, 'the service must read the material table');
  assert.notEqual(enumRead, -1, 'the service must compare the immersive type');
  assert.ok(levelRead < tableRead, 'the level must be read before the material table is touched');
  assert.ok(tableRead < enumRead, 'the table must answer before the enum member is compared');
  assert.match(serviceSource,
    /if \(!\(Number\.isFinite\(apiLevel\) &&\s*\n\s*apiLevel >= HdsTitleBarMaterialService\.IMMERSIVE_MATERIAL_API_LEVEL\)\) \{\s*\n\s*return false;/,
    'the table read must sit behind the level gate, in the branch that returns unsupported');
});

test('the two declarations of the device facts are one contract', () => {
  // A service must not import a page module and the policy must not import a
  // platform kit, so the snapshot is declared twice — and the policy is the one
  // that resolves from it. The two files also keep the same two levels, because a
  // gate that only one side moves is a decision the other side silently ignores.
  const fieldsOf = (sourceText, name) => {
    const start = sourceText.indexOf(`export interface ${name} {`);
    assert.notEqual(start, -1, `${name} must stay a declared interface`);
    const end = sourceText.indexOf('}', start);
    return sourceText.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(':') && line.endsWith(';'))
      .map((line) => line.split(':')[0].trim());
  };
  assert.deepEqual(fieldsOf(policySource, 'HdsTitleBarInput'),
    ['apiLevel', 'immersiveMaterialSupported'],
    'the policy resolves from these two facts');
  assert.deepEqual(fieldsOf(serviceSource, 'HdsTitleBarSnapshot'), fieldsOf(policySource, 'HdsTitleBarInput'),
    'the snapshot the service fills must be the contract the policy resolves from');

  const service = serviceHarness({ apiLevel: 21 }).Service;
  for (const level of ['IMMERSIVE_BLUR_API_LEVEL', 'IMMERSIVE_MATERIAL_API_LEVEL']) {
    assert.equal(service[level], Policy[level],
      `${level} must be the same number in the service and in the policy: a gate that moves on one side ` +
      'is a decision the other side silently ignores');
  }
  assert.equal(service.IMMERSIVE_BLUR_API_LEVEL, 23,
    'the blur and the material effect are one platform release, and the number has to be the release');
});

test('the support class resolves from the service and answers in platform values', () => {
  // The one place that turns the policy's vocabulary into platform values, and the
  // one place that reads the device: a consumer that read a kit itself would be a
  // second gate.
  const supportSource = fs.readFileSync(SUPPORT, 'utf8');
  assert.match(supportSource, /static decide\(scene: HdsTitleBarScene\): HdsTitleBarDecision \{/);
  assert.match(supportSource,
    /const snapshot: HdsTitleBarSnapshot = HdsTitleBarMaterialService\.snapshot\(\);/,
    'the tier must be resolved from the service snapshot, not from a read of its own');
  assert.match(supportSource, /return resolveHdsTitleBar\(scene, \{/,
    'the tier must come from the pure policy');
  assert.doesNotMatch(supportSource, /@kit\.ArkUI|@ohos/,
    'the support class reads the design kit and the platform types, never a second API family');
  assert.match(supportSource, /static options\(params: HdsTitleBarContentParams\): HdsNavigationTitleBarOptions/);
});
