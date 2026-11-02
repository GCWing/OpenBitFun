import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { canonicalizeIcns } from './icns-container.mjs';
import { COMPOSER_ICON, ICNS_OUTPUTS, MACOS_ICON_DIR, ROOT, macosSourceDigest, sha256 } from './macos-icon-assets.mjs';

if (process.platform !== 'darwin') throw new Error('Exporting macOS icons requires macOS and Icon Composer 1.2.');
const composer = process.env.ICON_COMPOSER_APP || '/Applications/Icon Composer.app';
const ictool = join(composer, 'Contents/Executables/ictool');
const run = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const version = JSON.parse(run(ictool, ['--version']));
if (version['short-bundle-version'] !== '1.2') {
  throw new Error('Use Icon Composer 1.2 for reproducible legacy exports; review the assets before updating the renderer version.');
}
run(process.execPath, [join(ROOT, 'scripts/generate-brand-assets.mjs'), '--macos-source-only']);

const temp = await mkdtemp(join(tmpdir(), 'openbitfun-macos-icons-'));
try {
  const { canvasSize, artworkBounds: bounds } = JSON.parse(await readFile(join(MACOS_ICON_DIR, 'legacy-canvas.json'), 'utf8'));
  const iconset = join(temp, 'openbitfun.iconset');
  await mkdir(iconset);
  // The legacy canvas is an authored macOS asset, not a modification of the
  // shared PNG/ICO or the full-bleed Icon Composer document. Render each size
  // with Apple's renderer before placing it on that canvas; do not rescale an
  // already flattened icon or rewrite Tauri's ICNS internals.
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      const left = Math.round(pixels * bounds.x / canvasSize);
      const top = Math.round(pixels * bounds.y / canvasSize);
      const width = pixels - left - Math.round(pixels * (canvasSize - bounds.x - bounds.width) / canvasSize);
      const height = pixels - top - Math.round(pixels * (canvasSize - bounds.y - bounds.height) / canvasSize);
      const rendered = join(temp, 'rendered.png');
      run(ictool, [COMPOSER_ICON, '--export-image', '--output-file', rendered,
        '--platform', 'macOS', '--rendition', 'Default', '--width', String(width),
        '--height', String(height), '--scale', '1']);
      await sharp({ create: { width: pixels, height: pixels, channels: 4, background: '#00000000' } })
        .composite([{ input: rendered, left, top }])
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(join(iconset, `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`));
    }
  }
  const output = join(temp, 'openbitfun.icns');
  run('/usr/bin/iconutil', ['--convert', 'icns', '--output', output, iconset]);
  const icns = canonicalizeIcns(await readFile(output));
  for (const relative of ICNS_OUTPUTS) await writeFile(join(ROOT, relative), icns);
  await writeFile(join(MACOS_ICON_DIR, 'generated.json'), `${JSON.stringify({
    iconComposerVersion: version['short-bundle-version'],
    iconComposerBuild: version['bundle-version'],
    sourceSha256: macosSourceDigest(),
    icnsSha256: sha256(icns),
  }, null, 2)}\n`);
  console.log('Exported macOS Icon Composer fallback with iconutil.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
