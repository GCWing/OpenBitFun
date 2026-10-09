import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  APPLE_SYSTEM_FONT_PROFILE,
  HARMONY_BUNDLED_FONT_PROFILE,
  HARMONY_FONT_ASSETS,
  assertWebFontProfileBundle,
  fontProfileForDesktopTarget,
  normalizeWebFontProfile,
  resolveWebFontProfile,
  verifyHarmonyFontSources,
} from './web-font-profile.mjs';

const ROOT = join(import.meta.dirname, '..');
const HARMONY_ROOT = join(ROOT, 'src/web-ui/src/assets/fonts/harmonyos-sans');
const harmonyBundle = [
  ...HARMONY_FONT_ASSETS
    .filter(({ relativePath }) => relativePath.endsWith('.ttf'))
    .map(({ relativePath }) => {
      const stem = relativePath.split('/').at(-1).replace(/\.ttf$/, '');
      return `assets/${stem}-contenthash.ttf`;
    }),
  'assets/FiraCode-Regular-contenthash.woff2',
  'assets/FiraCode-Medium-contenthash.woff2',
  'assets/FiraCode-SemiBold-contenthash.woff2',
  'assets/FiraCode-VF-contenthash.woff2',
  'third-party/fonts/harmonyos-sans/LICENSE.txt',
  'third-party/fonts/harmonyos-sans/NOTICE.txt',
  'third-party/fonts/fira-code/LICENSE.txt',
  'assets/KaTeX_Main-Regular-contenthash.woff2',
  'assets/codicon-contenthash.ttf',
];

test('Web font profiles resolve explicitly and use safe platform defaults', () => {
  assert.equal(normalizeWebFontProfile(APPLE_SYSTEM_FONT_PROFILE), APPLE_SYSTEM_FONT_PROFILE);
  assert.equal(
    normalizeWebFontProfile(HARMONY_BUNDLED_FONT_PROFILE),
    HARMONY_BUNDLED_FONT_PROFILE,
  );
  assert.throws(() => normalizeWebFontProfile('legacy-fonts'), /Unsupported/);

  assert.equal(resolveWebFontProfile({ command: 'build', platform: 'darwin' }), HARMONY_BUNDLED_FONT_PROFILE);
  assert.equal(resolveWebFontProfile({ command: 'serve', platform: 'darwin' }), APPLE_SYSTEM_FONT_PROFILE);
  assert.equal(resolveWebFontProfile({ command: 'serve', platform: 'win32' }), HARMONY_BUNDLED_FONT_PROFILE);
  assert.equal(
    resolveWebFontProfile({
      requested: APPLE_SYSTEM_FONT_PROFILE,
      command: 'build',
      platform: 'win32',
    }),
    APPLE_SYSTEM_FONT_PROFILE,
  );
});

test('Desktop targets select Apple system fonts only for Apple triples', () => {
  assert.equal(
    fontProfileForDesktopTarget({ target: 'aarch64-apple-darwin', platform: 'win32' }),
    APPLE_SYSTEM_FONT_PROFILE,
  );
  assert.equal(
    fontProfileForDesktopTarget({ target: 'x86_64-pc-windows-msvc', platform: 'darwin' }),
    HARMONY_BUNDLED_FONT_PROFILE,
  );
  assert.equal(
    fontProfileForDesktopTarget({ target: 'x86_64-unknown-linux-gnu', platform: 'darwin' }),
    HARMONY_BUNDLED_FONT_PROFILE,
  );
  assert.equal(fontProfileForDesktopTarget({ platform: 'darwin' }), APPLE_SYSTEM_FONT_PROFILE);
  assert.equal(fontProfileForDesktopTarget({ platform: 'linux' }), HARMONY_BUNDLED_FONT_PROFILE);
});

test('Harmony source profile contains only the two approved unmodified variable fonts', () => {
  const fonts = HARMONY_FONT_ASSETS.filter(({ relativePath }) => relativePath.endsWith('.ttf'));
  assert.equal(fonts.length, 2);
  assert.equal(fonts.some(({ relativePath }) => /(?:^|\/)tc(?:\/|$)/i.test(relativePath)), false);
  verifyHarmonyFontSources(HARMONY_ROOT);
});

test('bundled font variation axes and CSS cover every design-system weight', () => {
  const system = JSON.parse(readFileSync(join(
    ROOT, 'design-system/packages/design-tokens/src/system.tokens.json',
  ), 'utf8'));
  const weights = Object.values(system.font.weight)
    .map((token) => token.$value)
    .filter(Number.isFinite);
  assert.ok(weights.length > 0);
  const stylesheet = readFileSync(join(
    ROOT, 'src/web-ui/src/font-profiles/harmony-bundled.css',
  ), 'utf8');
  const faces = [...stylesheet.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);

  for (const { relativePath } of HARMONY_FONT_ASSETS.filter((asset) => asset.relativePath.endsWith('.ttf'))) {
    const font = readFileSync(join(HARMONY_ROOT, relativePath));
    const tables = new Map();
    for (let index = 0; index < font.readUInt16BE(4); index += 1) {
      const record = 12 + index * 16;
      tables.set(font.toString('ascii', record, record + 4), font.readUInt32BE(record + 8));
    }
    assert.ok(tables.has('fvar') && tables.has('gvar'), `${relativePath} needs real glyph variations`);
    const fvar = tables.get('fvar');
    const axesStart = fvar + font.readUInt16BE(fvar + 4);
    const axes = Array.from({ length: font.readUInt16BE(fvar + 8) }, (_, index) => {
      const axis = axesStart + index * font.readUInt16BE(fvar + 10);
      return {
        tag: font.toString('ascii', axis, axis + 4),
        min: font.readInt32BE(axis + 4) / 65536,
        max: font.readInt32BE(axis + 12) / 65536,
      };
    });
    const weightAxis = axes.find((axis) => axis.tag === 'wght');
    assert.ok(weightAxis, `${relativePath} needs a weight axis`);

    const declarations = faces.filter((face) => face.includes(`/harmonyos-sans/${relativePath}"`));
    assert.equal(declarations.length, 1, `${relativePath} must be registered once`);
    const range = declarations[0].match(/font-weight:\s*(\d+)\s+(\d+)\s*;/);
    assert.ok(range, `${relativePath} must expose variable font weights`);
    const cssMin = Number(range[1]);
    const cssMax = Number(range[2]);
    assert.deepEqual([cssMin, cssMax], [Math.min(...weights), Math.max(...weights)]);
    for (const weight of weights) {
      assert.ok(weight >= weightAxis.min && weight <= weightAxis.max,
        `${relativePath} cannot render design-system weight ${weight}`);
    }
  }
});

test('large bundled font files have exact reviewed Git object identities', () => {
  const policy = JSON.parse(readFileSync(join(ROOT, 'scripts/git-object-size-policy.json'), 'utf8'));
  for (const { relativePath, bytes } of HARMONY_FONT_ASSETS) {
    if (bytes <= policy.maxBlobBytes) continue;
    const source = readFileSync(join(HARMONY_ROOT, relativePath));
    const oid = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
    assert.ok(policy.allowedBlobs.some((entry) => entry.oid === oid
      && entry.path === `src/web-ui/src/assets/fonts/harmonyos-sans/${relativePath}`));
  }
});

test('Apple bundles reject product text fonts but allow functional fonts', () => {
  assert.doesNotThrow(() => assertWebFontProfileBundle(APPLE_SYSTEM_FONT_PROFILE, [
    'index.html',
    'assets/KaTeX_Main-Regular-contenthash.woff2',
    'assets/codicon-contenthash.ttf',
  ]));

  for (const forbidden of [
    'assets/HarmonyOS_Sans-contenthash.ttf',
    'assets/HarmonyOS_Sans_SC-contenthash.ttf',
    'assets/HarmonyOS_Sans_SC_Regular-contenthash.ttf',
    'assets/FiraCode-Regular-contenthash.woff2',
    'fonts/noto-sans-sc-latin-wght-normal.woff2',
  ]) {
    assert.throws(
      () => assertWebFontProfileBundle(APPLE_SYSTEM_FONT_PROFILE, ['index.html', forbidden]),
      /contains product text fonts/,
    );
  }
});

test('Harmony bundles require the exact approved font and legal asset set', () => {
  assert.doesNotThrow(() => assertWebFontProfileBundle(HARMONY_BUNDLED_FONT_PROFILE, harmonyBundle));

  assert.throws(
    () => assertWebFontProfileBundle(
      HARMONY_BUNDLED_FONT_PROFILE,
      harmonyBundle.filter((name) => !name.includes('HarmonyOS_Sans_SC-')),
    ),
    /missing font assets: HarmonyOS_Sans_SC/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(
      HARMONY_BUNDLED_FONT_PROFILE,
      harmonyBundle.filter((name) => !name.includes('HarmonyOS_Sans-')),
    ),
    /missing font assets: HarmonyOS_Sans$/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(HARMONY_BUNDLED_FONT_PROFILE, [
      ...harmonyBundle,
      'assets/HarmonyOS_Sans_SC-copy.ttf',
    ]),
    /duplicate font assets: HarmonyOS_Sans_SC/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(HARMONY_BUNDLED_FONT_PROFILE, [
      ...harmonyBundle,
      'assets/HarmonyOS_Sans_SC_Bold-contenthash.ttf',
    ]),
    /unapproved font assets/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(
      HARMONY_BUNDLED_FONT_PROFILE,
      harmonyBundle.map((name) => name.replace('HarmonyOS_Sans_SC-contenthash.ttf', 'HarmonyOS_Sans_SC-contenthash.woff2')),
    ),
    /unapproved formats/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(HARMONY_BUNDLED_FONT_PROFILE, [
      ...harmonyBundle,
      'assets/HarmonyOS_Sans_TC_Regular-contenthash.ttf',
    ]),
    /unapproved font assets/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(HARMONY_BUNDLED_FONT_PROFILE, [
      ...harmonyBundle,
      'assets/noto-sans-sc-latin-wght-normal.woff2',
    ]),
    /unapproved font assets/,
  );
  assert.throws(
    () => assertWebFontProfileBundle(
      HARMONY_BUNDLED_FONT_PROFILE,
      harmonyBundle.filter((name) => !name.endsWith('/NOTICE.txt')),
    ),
    /missing legal asset/,
  );
});
