#!/usr/bin/env node
// Build the bundled loopx CLI for the OpenBitFun desktop installer.
//
// Runs at BUILD time only (CI / packaging), never on user machines: fetches the
// pinned loopx source, compiles a self-contained onefile binary with
// PyInstaller, and stages it under src/apps/desktop/resources/loopx/ together
// with the compliance artifacts (Apache-2.0 LICENSE/NOTICE, historical
// LICENSE-MIT, TRADEMARKS.md, provenance
// manifest). The desktop bundles that directory as a sidecar resource and the
// bitfun-loopx MiniApp worker prefers the bundled binary at runtime, so end
// users need neither Python nor git nor network access to use loopx.
//
// loopx v0.5.1 is Apache-2.0 (Copyright 2026 LoopX contributors), pure-stdlib Python
// >= 3.11; PyInstaller's bootloader exception permits the bundled binary.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in sync with the pin constants in openbitfun-services-integrations::miniapp::loopx_cli (LOOPX_PINNED_VERSION_TAG / LOOPX_PINNED_SOURCE_COMMIT):
// loopx's CLI JSON contract is the app's interface surface, so the bundled
// binary and the runtime vendor fallback must pin the same version.
export const LOOPX_VERSION = 'v0.5.1';
const LOOPX_REPO = 'https://github.com/huangruiteng/loopx.git';
const LOOPX_COMMIT = '1bb42f4cb3e329dcb71c64654228f951098cead1';
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'apps',
  'desktop',
  'resources',
  'loopx',
);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLoopx().catch((err) => {
    console.error(`build-loopx failed: ${err.message}`);
    process.exit(1);
  });
}function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function shOut(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    .toString()
    .trim();
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pickPython() {
  for (const candidate of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    try {
      const version = shOut(candidate, ['--version']);
      const m = version.match(/Python\s+(\d+)\.(\d+)/);
      if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11))) {
        return { exe: candidate, version: version.replace(/\s+/g, ' ').trim() };
      }
      console.warn(`build-loopx: ${candidate} is ${version} (Python >= 3.11 required), skipping`);
    } catch {
      // not installed / not on PATH
    }
  }
  throw new Error('Python >= 3.11 not found (set PYTHON to a usable interpreter)');
}

export async function buildLoopx({
  version = LOOPX_VERSION,
  outDir = OUT_DIR,
} = {}) {
  const python = pickPython();
  console.log(`build-loopx: python ${python.version} (${python.exe})`);
  try {
    shOut('git', ['--version']);
  } catch {
    throw new Error('git not found on PATH');
  }

  const work = mkdtempSync(path.join(tmpdir(), 'loopx-build-'));
  const src = path.join(work, 'src');
  const venv = path.join(work, 'venv');
  const dist = path.join(work, 'dist');
  try {
    console.log(`build-loopx: cloning ${LOOPX_REPO} @ ${version}`);
    sh('git', ['clone', '--depth', '1', '--branch', version, LOOPX_REPO, src]);
    const commit = shOut('git', ['-C', src, 'rev-parse', 'HEAD']);
    if (commit !== LOOPX_COMMIT) {
      throw new Error(`pinned commit mismatch: expected ${LOOPX_COMMIT}, checkout is ${commit}`);
    }
    const described = shOut('git', ['-C', src, 'describe', '--tags', '--exact-match']);
    if (described !== version) {
      throw new Error(`pinned tag mismatch: expected ${version}, checkout is ${described}`);
    }
    if (
      !existsSync(path.join(src, 'LICENSE'))
      || !existsSync(path.join(src, 'NOTICE'))
      || !existsSync(path.join(src, 'LICENSE-MIT'))
      || !existsSync(path.join(src, 'loopx', 'entrypoint.py'))
    ) {
      throw new Error('checkout is missing compliance files or loopx/entrypoint.py');
    }

    console.log('build-loopx: creating build venv and installing PyInstaller');
    sh(python.exe, ['-m', 'venv', venv]);
    const pip = process.platform === 'win32'
      ? path.join(venv, 'Scripts', 'pip.exe')
      : path.join(venv, 'bin', 'pip');
    const pyinstaller = process.platform === 'win32'
      ? path.join(venv, 'Scripts', 'pyinstaller.exe')
      : path.join(venv, 'bin', 'pyinstaller');
    sh(pip, ['install', '--disable-pip-version-check', '--quiet', 'pyinstaller']);

    const entry = path.join(src, '_loopx_bundle_entry.py');
    writeFileSync(entry, 'from loopx.entrypoint import main\nraise SystemExit(main())\n', 'utf8');

    console.log('build-loopx: compiling onefile binary (PyInstaller)');
    sh(pyinstaller, [
      '--onefile',
      '--name', 'loopx',
      '--clean',
      '--noconfirm',
      '--distpath', dist,
      '--workpath', path.join(work, 'build'),
      '--specpath', path.join(work, 'build'),
      path.basename(entry),
    ], { cwd: src });

    const binary = path.join(dist, process.platform === 'win32' ? 'loopx.exe' : 'loopx');
    if (!existsSync(binary)) throw new Error(`PyInstaller produced no binary at ${binary}`);

    console.log('build-loopx: staging into', outDir);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(binary, path.join(outDir, path.basename(binary)));
    copyFileSync(path.join(src, 'LICENSE'), path.join(outDir, 'LICENSE'));
    copyFileSync(path.join(src, 'NOTICE'), path.join(outDir, 'NOTICE'));
    copyFileSync(path.join(src, 'LICENSE-MIT'), path.join(outDir, 'LICENSE-MIT'));
    copyFileSync(path.join(src, 'TRADEMARKS.md'), path.join(outDir, 'TRADEMARKS.md'));

    const pyinstallerVersion = shOut(pyinstaller, ['--version']);
    const manifest = {
      schema_version: 1,
      name: 'loopx',
      version,
      source: LOOPX_REPO.replace(/\.git$/, ''),
      commit,
      license: 'Apache-2.0',
      copyright: 'Copyright 2026 LoopX contributors',
      sha256: `sha256:${sha256Of(path.join(outDir, path.basename(binary)))}`,
      built_with: {
        python: python.version,
        pyinstaller: pyinstallerVersion,
      },
      built_at: new Date().toISOString(),
    };
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const sizeMb = (statSync(path.join(outDir, path.basename(binary))).size / 1048576).toFixed(1);
    console.log(`build-loopx: done — ${path.join(outDir, path.basename(binary))} (${sizeMb} MiB, loopx ${version} @ ${commit})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
