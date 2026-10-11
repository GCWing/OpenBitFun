import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMacosFallback } from './macos-icon-assets.mjs';

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true });

export function requireModernIconTools(execute = run) {
  let output;
  try {
    // Use the same actool lookup as Tauri's bundler, including DEVELOPER_DIR.
    output = execute('actool', ['--version', '--output-format=human-readable-text']);
  } catch {
    throw new Error('macOS bundles require full Xcode 26 or newer (actool). Select it with DEVELOPER_DIR or xcode-select; Command Line Tools alone cannot compile Icon Composer assets.');
  }
  const major = Number(output.match(/^\s*short-bundle-version:\s*(\d+)\./m)?.[1]);
  if (!Number.isFinite(major) || major < 26) {
    throw new Error('macOS bundles require actool 26 or newer; refusing to silently omit Assets.car.');
  }
  execute('xcrun', ['--find', 'assetutil']);
}

export function verifyMacosIconBundle(appPath, { execute = run, fallback = readMacosFallback() } = {}) {
  const contents = join(appPath, 'Contents');
  const plist = JSON.parse(execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(contents, 'Info.plist')]));
  const name = plist.CFBundleIconName;
  const file = plist.CFBundleIconFile;
  if (!name || !file || basename(file) !== file) {
    throw new Error('macOS bundle must declare both CFBundleIconName and a local CFBundleIconFile.');
  }
  const resources = join(contents, 'Resources');
  const car = join(resources, 'Assets.car');
  if (statSync(car).size === 0) throw new Error('Assets.car is empty.');
  const assets = JSON.parse(execute('assetutil', ['--info', car]));
  if (!assets.some(asset => asset.AssetType === 'Icon Image' && asset.Name === name)) {
    throw new Error(`Assets.car has no Icon Image matching CFBundleIconName ${name}.`);
  }
  const icns = readFileSync(join(resources, file.endsWith('.icns') ? file : `${file}.icns`));
  if (!icns.equals(fallback)) throw new Error('Bundled legacy ICNS differs from the verified dev/legacy export.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'preflight') {
      readMacosFallback();
      requireModernIconTools();
      console.log('macOS icon sources and Xcode tools verified.');
    } else if (process.argv[2] === 'verify' && process.argv.length > 3) {
      for (const appPath of process.argv.slice(3)) {
        verifyMacosIconBundle(appPath);
        console.log(`Verified modern and legacy macOS icons: ${appPath}`);
      }
    } else {
      throw new Error('Usage: node scripts/macos-icon-bundle.mjs preflight | verify <app-bundle> [...]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
