#!/usr/bin/env node
// Authoring only: load the current product contract instead of cloning its validator.
import { readFile, writeFile, mkdir, stat, realpath, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: node visual-skin.mjs <command> [input] [options]
  contract --project <checkout> [--out contract.json]
  init <new-directory> --id <id> --name <name> [--project <checkout>]
  validate <directory|canonical.json|canonical.zip> [--project <checkout>]
  pack <directory> --out <new-file.zip> [--project <checkout>]
Requires Node 22.12+, an OpenBitFun checkout with pnpm dependencies installed,
and prepared design-system packages. No storage or running app is modified.`;

function findProject(start) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'src/web-ui/src/infrastructure/visual-skin/parser.ts'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadProduct(project) {
  const root = project ? resolve(project) : findProject(process.cwd()) ?? findProject(skillRoot);
  if (!root || !existsSync(join(root, 'src/web-ui/src/infrastructure/visual-skin/parser.ts'))) {
    throw new Error('Current product source is required. Set --project to the OpenBitFun checkout.');
  }
  const webRoot = join(root, 'src/web-ui');
  const require = createRequire(join(webRoot, 'package.json'));
  let createServer;
  try { ({ createServer } = await import(pathToFileURL(require.resolve('vite')).href)); }
  catch { throw new Error('Install checkout dependencies with pnpm install before using this tool.'); }
  const server = await createServer({
    root: webRoot, configFile: false, appType: 'custom',
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const load = name => server.ssrLoadModule(`/src/infrastructure/visual-skin/${name}.ts`);
    const [parser, validator, contract, archive, resolution] = await Promise.all([
      load('parser'), load('validator'), load('contract'), load('archive'), load('resolve'),
    ]);
    return { ...parser, ...validator, ...contract, ...archive, ...resolution, JSZip: require('jszip'), close: () => server.close() };
  } catch (error) {
    await server.close();
    throw new Error(`Unable to load product contract. Run pnpm --dir src/web-ui run prepare:design-system:dev. ${error.message}`);
  }
}

function keys(value, allowed, path) {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key}: unsupported authoring field`);
  }
}

function unique(values, path) {
  if (new Set(values).size !== values.length) throw new Error(`${path}: duplicate target`);
}

// The product accepts some unknown metadata. New authored skins deliberately use
// only rendered fields; this lint does not change the importer's acceptance rules.
export function lintAuthoring(skin, product) {
  const result = product.validateVisualSkinPackage(skin);
  if (!result.valid || result.warnings.length) {
    throw new Error([...result.errors, ...result.warnings].map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  }
  keys(skin, ['manifest', 'modes', 'assets', 'components', 'surfaces'], '$');
  keys(skin.manifest, ['schema', 'schemaVersion', 'id', 'name', 'version', 'author', 'description', 'previewAssetId'], 'manifest');
  for (const [mode, patch] of Object.entries(skin.modes)) {
    keys(patch, ['tokens', 'slots', 'surfaces'], `modes.${mode}`);
    for (const [slot, declarations] of Object.entries(patch.slots ?? {})) {
      keys(declarations, product.VISUAL_SKIN_SLOT_PROPERTY_NAMES, `modes.${mode}.slots.${slot}`);
    }
  }
  for (const [id, asset] of Object.entries(skin.assets ?? {})) {
    keys(asset, ['mimeType', 'source', 'alt'], `assets.${id}`);
    keys(asset.source, asset.source.kind === 'path' ? ['kind', 'path'] : ['kind', 'data'], `assets.${id}.source`);
  }
  const parts = (slots, path) => {
    for (const [part, recipe] of Object.entries(slots ?? {})) {
      keys(recipe, product.VISUAL_SKIN_PART_FIELDS, `${path}.${part}`);

    }
  };
  const states = (recipes, path) => {
    for (const [state, recipe] of Object.entries(recipes ?? {})) {
      keys(recipe, ['tokens', 'slots'], `${path}.${state}`);
      parts(recipe.slots, `${path}.${state}.slots`);
    }
  };
  unique((skin.components ?? []).map(recipe => recipe.component), 'components');
  const surfaceGroups = [
    { profiles: skin.surfaces ?? [], path: 'surfaces' },
    ...Object.entries(skin.modes).map(([mode, patch]) => ({ profiles: patch.surfaces ?? [], path: `modes.${mode}.surfaces` })),
  ];
  for (const { profiles, path } of surfaceGroups) unique(profiles.map(recipe => recipe.surface), path);
  for (const [index, component] of (skin.components ?? []).entries()) {
    keys(component, ['component', 'tokens', 'slots', 'states'], `components[${index}]`);
    parts(component.slots, `components[${index}].slots`);
    states(component.states, `components[${index}].states`);
  }
  for (const { profiles, path: groupPath } of surfaceGroups) for (const [index, surface] of profiles.entries()) {
    const path = `${groupPath}[${index}]`;
    keys(surface, product.VISUAL_SKIN_SURFACE_FIELDS, path);
    for (const field of ['backgroundPosition', 'backgroundOpacity', 'fit']) {
      if (surface[field] !== undefined && !surface.backgroundAssetId) throw new Error(`${path}.${field}: requires backgroundAssetId`);
    }
    if (surface.scrimOpacity !== undefined && !surface.scrimToken) throw new Error(`${path}.scrimOpacity: requires scrimToken`);
    states(surface.states, `${path}.states`);
  }
}

function bufferSource(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }

// A numerical review aid, not a visual pass/fail heuristic. SVG alpha, crop,
// CSS consumption and parent/child occlusion still need actual product review.
export function compositionReview(skin, product) {
  const alpha = value => {
    if (typeof value !== 'string') return null;
    if (value === 'transparent') return 0;
    if (/^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value)) return 1;
    if (/^#[0-9a-f]{8}$/i.test(value)) return parseInt(value.slice(7), 16) / 255;
    if (/^#[0-9a-f]{4}$/i.test(value)) return parseInt(value[4], 16) / 15;
    const rgba = value.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i);
    return rgba ? Number(rgba[1]) : null;
  };
  return {
    components: (skin.components ?? []).map(recipe => recipe.component),
    componentMaterials: (skin.components ?? []).map(recipe => ({
      component: recipe.component,
      parts: Object.keys(recipe.slots ?? {}),
      states: Object.entries(recipe.states ?? {}).map(([state, paint]) => ({ state, parts: Object.keys(paint.slots ?? {}) })),
    })),
    surfaces: [...new Set([
      ...(skin.surfaces ?? []).map(profile => profile.surface),
      ...Object.values(skin.modes).flatMap(patch => (patch.surfaces ?? []).map(profile => profile.surface)),
    ])].map(surface => ({
      surface,
      materialByDeclaredMode: Object.fromEntries(Object.keys(skin.modes).map(mode => {
        const profile = product.resolveSkinSurfaces(skin, mode).selected.find(entry => entry.surface.surface === surface)?.surface;
        return [mode, { backgroundSource: profile?.backgroundSource ?? 'local', baseOpacity: profile?.baseOpacity ?? 1 }];
      })),
      imageWeightByDeclaredMode: Object.fromEntries(Object.keys(skin.modes).map(mode => {
        const profile = product.resolveSkinSurfaces(skin, mode).selected.find(entry => entry.surface.surface === surface)?.surface;
        if (profile?.backgroundSource === 'shell') return [mode, null];
        if (!profile?.backgroundAssetId) return [mode, 0];
        const { patch } = product.resolveSkinMode(skin, mode);
        const scrimAlpha = profile.scrimToken ? alpha(profile.tokens?.[profile.scrimToken] ?? patch.tokens?.[profile.scrimToken]) : 0;
        return [mode, scrimAlpha === null ? null : (profile.backgroundOpacity ?? 1) * (1 - (profile.scrimOpacity ?? 0) * scrimAlpha)];
      })),
    })),
    limitations: 'Nominal local-image contribution before source alpha and occlusion; null means a shared shell source or an unresolved scrim alpha. Shared appearance depends on shell and every intervening material; do not multiply a single slider into a visual score. Inspect artwork and real product screenshots. No visual acceptance is implied.',
  };
}

async function readBounded(path, limit) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error(`File is empty, not regular, or exceeds ${limit} bytes: ${path}`);
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > limit) throw new Error(`File changed beyond its size limit: ${path}`);
  return bytes;
}

export async function buildDirectory(directory, product) {
  const root = await realpath(resolve(directory));
  const manifestBytes = await readBounded(join(root, 'skin.json'), product.MAX_SKIN_MANIFEST_BYTES);
  const skin = JSON.parse(manifestBytes.toString('utf8'));
  lintAuthoring(skin, product);
  const paths = Object.values(skin.assets ?? {}).flatMap(asset => asset.source.kind === 'path' ? [asset.source.path] : []);
  unique(['skin.json', ...paths], 'archive paths');
  const files = new Map([['skin.json', manifestBytes]]);
  let total = manifestBytes.length;
  for (const path of paths.sort()) {
    const target = await realpath(resolve(root, path));
    const inside = relative(root, target);
    if (!inside || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) {
      throw new Error(`Asset resolves outside the skin directory: ${path}`);
    }
    const bytes = await readBounded(target, product.MAX_SKIN_ASSET_BYTES);
    total += bytes.length;
    if (total > product.MAX_SKIN_EXPANDED_BYTES) throw new Error('Skin exceeds the total expanded size limit');
    files.set(path, bytes);
  }
  const zip = new product.JSZip();
  for (const [path, bytes] of files) {
    zip.file(path, bytes, { date: new Date(2000, 0, 1), createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const parsed = await new product.VisualSkinPackageParser().parse(bufferSource(bytes));
  return { bytes, skin: parsed, files: [...files.keys()] };
}

export async function validateInput(input, product) {
  if ((await stat(input)).isDirectory()) return buildDirectory(input, product);
  // The parser performs the same archive and expansion checks used on import.
  const bytes = await readBounded(input, 32 * 1024 * 1024);
  const parser = new product.VisualSkinPackageParser();
  const skin = await parser.parse(bufferSource(bytes));
  let raw;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const archive = await product.SkinArchive.open(bufferSource(bytes));
    try { raw = JSON.parse(new TextDecoder().decode(await archive.read('skin.json', product.MAX_SKIN_MANIFEST_BYTES))); }
    finally { await archive.close(); }
  } else raw = JSON.parse(bytes.toString('utf8'));
  lintAuthoring(raw, product);
  return { bytes, skin };
}

export async function initDirectory(directory, id, name, product) {
  if (!id || !name) throw new Error('init requires --id and --name');
  const example = join(skillRoot, 'examples/aurora-paper');
  const skin = JSON.parse(await readFile(join(example, 'skin.json'), 'utf8'));
  skin.manifest = { ...skin.manifest, id, name, description: 'Authoring starter: replace example values using the supplied reference.' };
  lintAuthoring(skin, product);
  // Never replace existing authoring work, even if the directory is empty.
  await mkdir(directory);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'skin.json'), `${JSON.stringify(skin, null, 2)}\n`, { flag: 'wx' });
  await copyFile(join(example, 'assets/aurora-mark.svg'), join(directory, 'assets/aurora-mark.svg'));
  for (const name of ['paint-plan.md', 'visual-review.md']) {
    await copyFile(join(skillRoot, 'references/templates', name), join(directory, name));
  }
  return skin;
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, out: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { console.log(usage); return; }
  const [command, input] = positionals;
  if (!['contract', 'init', 'validate', 'pack'].includes(command) || positionals.length !== (command === 'contract' ? 1 : 2)) throw new Error(usage);
  if (command === 'pack' && (!values.out || !values.out.endsWith('.zip'))) throw new Error('pack requires --out <new-file.zip>');
  const product = await loadProduct(values.project);
  try {
    if (command === 'contract') {
      const report = JSON.stringify({
        tokens: product.VISUAL_SKIN_TOKEN_VARIABLES,
        surfaces: product.VISUAL_SKIN_SURFACE_IDS,
        surfaceBaseTokens: product.VISUAL_SKIN_SURFACE_BASE_TOKENS,
        surfaceFields: product.VISUAL_SKIN_SURFACE_FIELDS,
        slots: product.VISUAL_SKIN_SLOT_IDS,
        slotProperties: product.VISUAL_SKIN_SLOT_PROPERTY_NAMES,
        commonStates: product.VISUAL_SKIN_STATE_IDS,
        partPaintFields: product.VISUAL_SKIN_PART_FIELDS,
        note: 'Token existence does not prove consumption. Discover component ids and owned parts in product source or DOM; verify projection in the app.',
      }, null, 2);
      if (values.out) await writeFile(values.out, `${report}\n`, { flag: 'wx' });
      else console.log(report);
    } else if (command === 'init') {
      await initDirectory(input, values.id, values.name, product);
      console.log(`Created authoring starter: ${resolve(input)}. Reference analysis and visual QA remain required.`);
    } else {
      const result = command === 'pack' ? await buildDirectory(input, product) : await validateInput(input, product);
      if (command === 'pack') await writeFile(values.out, result.bytes, { flag: 'wx' });
      console.log(JSON.stringify({
        id: result.skin.manifest.id, modes: Object.keys(result.skin.modes),
        assets: Object.keys(result.skin.assets), files: result.files,
        output: command === 'pack' ? resolve(values.out) : undefined,
        validation: 'passed: product parser and authoring lint',
        deliveryStatus: 'draft-unverified',
        composition: compositionReview(result.skin, product),
        projection: 'unverified: inspect current targets and states in the app',
        visual: 'unverified: inspect composed contrast and actual product screenshots',
      }, null, 2));
    }
  } finally { await product.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Visual skin authoring failed: ${error.message}`); process.exitCode = 1; });
}
