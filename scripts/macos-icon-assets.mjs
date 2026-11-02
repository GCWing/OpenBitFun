import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MACOS_ICON_DIR = join(ROOT, 'assets/brand/macos');
export const COMPOSER_ICON = join(MACOS_ICON_DIR, 'openbitfun.icon');
export const ICNS_OUTPUTS = [
  'assets/brand/exports/openbitfun-app-icon.icns',
  'src/apps/desktop/icons/openbitfun-app-icon.icns',
  'OpenBitFun-Installer/src-tauri/icons/openbitfun-app-icon.icns',
];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function macosSourceDigest() {
  const hash = createHash('sha256');
  for (const file of ['openbitfun.icon/icon.json', 'openbitfun.icon/Assets/Mark.png', 'legacy-canvas.json']) {
    hash.update(file).update('\0').update(readFileSync(join(MACOS_ICON_DIR, file)));
  }
  return hash.digest('hex');
}

// Normal installs and non-Apple builds only copy the committed native export.
// Changing either composition requires an explicit export on a Mac.
export function readMacosFallback() {
  const manifest = JSON.parse(readFileSync(join(MACOS_ICON_DIR, 'generated.json'), 'utf8'));
  const icns = readFileSync(join(ROOT, ICNS_OUTPUTS[0]));
  if (manifest.sourceSha256 !== macosSourceDigest() || manifest.icnsSha256 !== sha256(icns)) {
    throw new Error('macOS icon export is stale. Run pnpm run generate:macos-icons on macOS and commit the generated assets.');
  }
  return icns;
}
