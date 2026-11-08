import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadProduct, buildDirectory, validateInput, initDirectory, lintAuthoring, compositionReview } from './visual-skin.mjs';

const script = fileURLToPath(new URL('./visual-skin.mjs', import.meta.url));
const example = resolve(dirname(script), '../examples/aurora-paper');
let product;
let scratch;
let sequence = 0;

before(async () => {
  product = await loadProduct();
  scratch = await mkdtemp(join(tmpdir(), 'openbitfun-skin-authoring-'));
});
after(async () => {
  await product?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function fixture(change = () => {}) {
  const directory = join(scratch, `skin-${sequence++}`);
  await initDirectory(directory, 'test-skin', 'Test Skin', product);
  const manifest = join(directory, 'skin.json');
  const skin = JSON.parse(await readFile(manifest, 'utf8'));
  change(skin);
  await writeFile(manifest, JSON.stringify(skin));
  return { directory, skin };
}

test('example packages only declared assets and round trips through the production parser', async () => {
  const result = await buildDirectory(example, product);
  assert.deepEqual(result.files, ['skin.json', 'assets/aurora-mark.svg']);
  assert.deepEqual(Object.keys(result.skin.modes), ['light', 'dark']);
  assert.match(result.skin.assets['brand.mark'].dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(result.skin.surfaces.length, 8);
  const archive = join(scratch, 'example.zip');
  await writeFile(archive, result.bytes);
  assert.equal((await validateInput(archive, product)).skin.manifest.id, 'aurora-paper');
  assert.deepEqual(result.bytes, (await buildDirectory(example, product)).bytes);
});

test('starter refuses to replace an existing directory or accept a bad id', async () => {
  await assert.rejects(initDirectory(join(scratch, 'bad'), '../escape', 'Name', product), /manifest.id/);
  const { directory } = await fixture();
  const original = await readFile(join(directory, 'skin.json'));
  await assert.rejects(initDirectory(directory, 'other', 'Other', product), /EEXIST/);
  assert.deepEqual(await readFile(join(directory, 'skin.json')), original);
});

test('a hand-authored token-only skin needs no starter, assets, recipes or worksheets', async () => {
  const directory = join(scratch, 'hand-authored');
  await mkdir(directory);
  await writeFile(join(directory, 'skin.json'), JSON.stringify({
    manifest: {
      schema: 'openbitfun.visual-skin', schemaVersion: 1,
      id: 'hand-authored', name: 'Color only', version: '1.0.0',
    },
    modes: { light: { tokens: { 'color.content.primary': '#202636' } } },
  }));
  const result = await buildDirectory(directory, product);
  assert.deepEqual(result.files, ['skin.json']);
  assert.deepEqual(Object.keys(result.skin.modes), ['light']);
  assert.deepEqual(Object.keys(result.skin.assets), []);
  const archive = join(scratch, 'hand-authored.zip');
  await writeFile(archive, result.bytes);
  assert.equal((await validateInput(archive, product)).skin.manifest.id, 'hand-authored');
  for (const name of ['paint-plan.md', 'visual-review.md']) {
    await assert.rejects(stat(join(directory, name)), /ENOENT/);
  }
});

test('shared shell material survives packaging without duplicating or resizing source artwork', async () => {
  const { directory } = await fixture(skin => {
    const id = Object.keys(skin.assets)[0];
    skin.surfaces = [{ surface: 'shell', backgroundAssetId: id },
      { surface: 'workbench-content', backgroundSource: 'shell', baseOpacity: 0 },
      { surface: 'chat', backgroundSource: 'shell', baseOpacity: 0.94 }];
  });
  const result = await buildDirectory(directory, product);
  assert.equal(result.skin.surfaces[1].backgroundSource, 'shell');
  assert.equal(result.skin.surfaces[2].baseOpacity, 0.94);
  const review = compositionReview(result.skin, product).surfaces.find(s => s.surface === 'chat');
  assert.equal(review.imageWeightByDeclaredMode.light, null);
  assert.deepEqual(review.materialByDeclaredMode.light, { backgroundSource: 'shell', baseOpacity: 0.94 });
  const original = JSON.parse(await readFile(join(directory, 'skin.json'), 'utf8'));
  const id = Object.keys(original.assets)[0];
  const bytes = await readFile(join(directory, original.assets[id].source.path));
  assert.equal(Buffer.from(result.skin.assets[id].dataUrl.split(',')[1], 'base64').compare(bytes), 0);
});

test('starter supplies unverified authoring evidence outside the import archive and preserves it on retry', async () => {
  const { directory } = await fixture();
  for (const name of ['paint-plan.md', 'visual-review.md']) {
    const path = join(directory, name);
    assert.match(await readFile(path, 'utf8'), /Status: draft-unverified/);
    await writeFile(path, 'User review evidence\n');
  }
  const result = await buildDirectory(directory, product);
  assert.deepEqual(result.files, ['skin.json', 'assets/aurora-mark.svg']);
  await assert.rejects(initDirectory(directory, 'other', 'Other', product), /EEXIST/);
  for (const name of ['paint-plan.md', 'visual-review.md']) {
    assert.equal(await readFile(join(directory, name), 'utf8'), 'User review evidence\n');
  }
});

test('uses product validation for unknown tokens and missing references', async () => {
  const unknown = await fixture(skin => { skin.modes.light.tokens['color.invented'] = '#fff'; });
  await assert.rejects(buildDirectory(unknown.directory, product), /color.invented/);
  const missing = await fixture(skin => { skin.surfaces[0].backgroundAssetId = 'missing'; });
  await assert.rejects(buildDirectory(missing.directory, product), /declared asset/);
});

test('authoring rejects fields ignored by the renderer at nested paths', async () => {
  for (const [change, reason] of [
    [skin => { skin.surfaces[0].responsive = {}; }, /surfaces\[0\].responsive/],
    [skin => { skin.assets['brand.mark'].license = 'metadata belongs in analysis'; }, /assets.brand.mark.license/],
    [skin => { skin.components[0].states.disabled.slots['leading-icon'].blend = 'multiply'; }, /leading-icon.blend/],
  ]) {
    const { directory } = await fixture(change);
    await assert.rejects(buildDirectory(directory, product), reason);
  }
});

test('authoring rejects unsupported global slots, slot properties, and surfaces', async () => {
  for (const [change, reason] of [
    [skin => { skin.modes.light.slots = { 'empty-state-background': { foreground: '#fff' } }; }, /product slot contract/],
    [skin => { skin.modes.light.slots = { 'shell-background': { custom: '#fff' } }; }, /shell-background.custom/],
    [skin => { skin.surfaces[0].surface = 'hero'; }, /product surface contract/],
  ]) {
    const { directory } = await fixture(change);
    await assert.rejects(buildDirectory(directory, product), reason);
  }
});

test('rejects duplicate target declarations instead of silently overriding them', async () => {
  const { directory } = await fixture(skin => { skin.surfaces.push({ ...skin.surfaces[0] }); });
  await assert.rejects(buildDirectory(directory, product), /duplicate target/);
});

test('rejects backdrop, scrim, and part fit settings without their dependencies', async () => {
  for (const [change, reason] of [
    [skin => { skin.surfaces[0].backgroundOpacity = 0.4; }, /requires backgroundAssetId/],
    [skin => { skin.surfaces[0].scrimOpacity = 0.4; }, /requires scrimToken/],
    [skin => { skin.components[0].slots = { 'leading-icon': { fit: 'cover' } }; }, /requires assetId/],
  ]) {
    const { directory } = await fixture(change);
    await assert.rejects(buildDirectory(directory, product), reason);
  }
});

test('accepts intentional fill sizing for both surfaces and parts', async () => {
  for (const change of [
    skin => { skin.surfaces.at(-1).fit = 'fill'; },
    skin => { skin.components[0].slots = { 'leading-icon': { assetId: 'brand.mark', fit: 'fill' } }; },
  ]) {
    const { directory, skin } = await fixture(change);
    assert.equal(product.validateVisualSkinPackage(skin).valid, true);
    await buildDirectory(directory, product);
  }
});

test('reports cumulative image contribution without inventing a visual acceptance threshold', async () => {
  const { skin } = await fixture(skin => {
    skin.modes.light.tokens['color.surface.panel'] = '#fff';
    skin.modes.dark.tokens['color.surface.panel'] = 'rgba(0,0,0,0.5)';
    skin.surfaces = [{ surface: 'empty-state', backgroundAssetId: 'brand.mark', backgroundOpacity: 0.72, scrimToken: 'color.surface.panel', scrimOpacity: 0.7 }];
  });
  let report = compositionReview(skin, product);
  assert.ok(Math.abs(report.surfaces[0].imageWeightByDeclaredMode.light - 0.216) < 0.00001);
  assert.ok(Math.abs(report.surfaces[0].imageWeightByDeclaredMode.dark - 0.468) < 0.00001);
  skin.modes.light.tokens['color.surface.panel'] = 'color-mix(in srgb, white 50%, transparent)';
  report = compositionReview(skin, product);
  assert.equal(report.surfaces[0].imageWeightByDeclaredMode.light, null);
  assert.match(report.limitations, /No visual acceptance/);
});

test('rejects traversal, missing assets, and oversized files before writing a ZIP', async () => {
  const unsafe = await fixture(skin => { skin.assets['brand.mark'].source.path = '../outside.svg'; });
  await assert.rejects(buildDirectory(unsafe.directory, product), /safe relative/);
  const missing = await fixture(skin => { skin.assets['brand.mark'].source.path = 'assets/missing.svg'; });
  await assert.rejects(buildDirectory(missing.directory, product), /ENOENT/);
  const large = await fixture();
  await writeFile(join(large.directory, 'assets/aurora-mark.svg'), Buffer.alloc(product.MAX_SKIN_ASSET_BYTES + 1));
  await assert.rejects(buildDirectory(large.directory, product), /exceeds/);
});

test('rejects symlinked assets outside the source directory', async () => {
  const external = join(scratch, 'external');
  await mkdir(external);
  await writeFile(join(external, 'image.svg'), '<svg/>');
  const { directory } = await fixture(skin => { skin.assets['brand.mark'].source.path = 'linked/image.svg'; });
  await symlink(external, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildDirectory(directory, product), /outside the skin directory/);
});

test('validates embedded canonical JSON but rejects JSON with path assets', async () => {
  const { skin } = await fixture();
  skin.assets['brand.mark'].source = { kind: 'data', data: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` };
  const path = join(scratch, 'embedded.json');
  await writeFile(path, JSON.stringify(skin));
  assert.equal((await validateInput(path, product)).skin.manifest.id, 'test-skin');
  const rawPath = join(scratch, 'path-assets.json');
  await writeFile(rawPath, await readFile(join(example, 'skin.json')));
  await assert.rejects(validateInput(rawPath, product), /must use data URLs/);
});

test('archive validation rejects unsupported authoring fields even when importer tolerates them', async () => {
  const { skin } = await fixture();
  skin.responsive = {};
  const zip = new product.JSZip();
  zip.file('skin.json', JSON.stringify(skin));
  zip.file('assets/aurora-mark.svg', await readFile(join(example, 'assets/aurora-mark.svg')));
  const path = join(scratch, 'ignored-field.zip');
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(validateInput(path, product), /responsive: unsupported/);
});

test('supports actual mode slot properties and high-contrast patches without a separate schema', async () => {
  const { directory, skin } = await fixture(skin => {
    skin.modes.highContrastLight = { tokens: { 'color.focus.ring': '#000000' } };
    skin.modes.light.slots = { 'navigation-background': { foreground: '#202636', border: '#999181', shadow: 'none' } };
  });
  lintAuthoring(skin, product);
  const result = await buildDirectory(directory, product);
  assert.equal(result.skin.modes.highContrastLight.tokens['color.focus.ring'], '#000000');
});

test('CLI works outside the checkout, exports live contract, validates before writing, and refuses overwrite', async () => {
  const project = resolve(dirname(script), ...Array(7).fill('..'));
  const run = args => execFileSync(process.execPath, [script, ...args, '--project', project], { cwd: scratch, windowsHide: true, encoding: 'utf8' });
  const contract = JSON.parse(run(['contract']));
  assert.equal(contract.tokens['color.surface.canvas'], product.VISUAL_SKIN_TOKEN_VARIABLES['color.surface.canvas']);
  assert.deepEqual(contract.slots, product.VISUAL_SKIN_SLOT_IDS);
  const starter = join(scratch, 'cli-starter');
  run(['init', starter, '--id', 'cli-skin', '--name', 'CLI Skin']);
  const output = join(scratch, 'cli.zip');
  const packed = JSON.parse(run(['pack', starter, '--out', output]));
  assert.match(packed.validation, /product parser/);
  assert.match(packed.visual, /^unverified/);
  assert.equal(packed.deliveryStatus, 'draft-unverified');
  assert.ok(packed.composition.surfaces.some(surface => surface.surface === 'empty-state'));
  assert.match(JSON.parse(run(['validate', output])).validation, /^passed/);
  const original = await readFile(output);
  assert.throws(() => run(['pack', starter, '--out', output]), /EEXIST/);
  assert.deepEqual(await readFile(output), original);
  const { directory } = await fixture(skin => { skin.modes.light.tokens['no.such.token'] = '#fff'; });
  const rejected = join(scratch, 'rejected.zip');
  assert.throws(() => run(['pack', directory, '--out', rejected]), /public theme token/);
  await assert.rejects(stat(rejected), /ENOENT/);
});


test('mode surfaces use the product resolver for overrides and validation', async () => {
  const { directory, skin } = await fixture(skin => {
    skin.surfaces = [{ surface: 'empty-state', backgroundAssetId: 'brand.mark', backgroundOpacity: 0.1 }];
    skin.modes.light.surfaces = [{ surface: 'empty-state', backgroundAssetId: 'brand.mark', backgroundOpacity: 0.8 }];
    skin.modes.dark.surfaces = [{ surface: 'empty-state', baseToken: 'color.surface.panel' }];
  });
  await buildDirectory(directory, product);
  const report = compositionReview(skin, product);
  assert.equal(report.surfaces[0].imageWeightByDeclaredMode.light, 0.8);
  assert.equal(report.surfaces[0].imageWeightByDeclaredMode.dark, 0);
  skin.modes.light.surfaces[0].backgroundAssetId = 'missing';
  assert.equal(product.validateVisualSkinPackage(skin).valid, false);
  skin.modes.light.surfaces[0].backgroundAssetId = 'brand.mark';
  skin.modes.light.surfaces.push(skin.modes.light.surfaces[0]);
  assert.throws(() => lintAuthoring(skin, product), /modes.light.surfaces: duplicate target/);
});

test('component recipes reject layout fields and keep paint-only recipes', async () => {
  const { directory } = await fixture(skin => {
    skin.components = [{ component: 'welcome', tokens: { 'color.content.primary': '#ffffff' } }];
  });
  const { skin } = await buildDirectory(directory, product);
  assert.equal(skin.components[0].tokens['color.content.primary'], '#ffffff');
  assert.equal(product.validateVisualSkinPackage({ ...skin, components: [{ component: 'welcome', presentation: 'quiet-end' }] }).valid, false);
  assert.throws(() => lintAuthoring({ ...skin, components: [{ component: 'welcome', position: 'bottom' }] }, product), /position/);
});


test('packs exposed text contrast using the product contract', async () => {
  const { directory } = await fixture(skin => {
    skin.components = [{ component: 'markdown', slots: { root: { foregroundToken: 'color.content.onDark', textShadowToken: 'shadow.base' } } }];
  });
  const { skin } = await buildDirectory(directory, product);
  assert.equal(skin.components[0].slots.root.textShadowToken, 'shadow.base');
  assert.equal(product.validateVisualSkinPackage({ ...skin, components: [{ component: 'markdown', slots: { root: { textShadowToken: 'color.surface.panel' } } }] }).valid, false);
});
