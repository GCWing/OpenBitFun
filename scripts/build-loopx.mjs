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
// loopx v1.0.1 is Apache-2.0 (Copyright 2026 LoopX contributors), pure-stdlib Python
// >= 3.11; PyInstaller's bootloader exception permits the bundled binary.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
export const LOOPX_VERSION = 'v1.0.1';
const LOOPX_REPO = 'https://github.com/huangruiteng/loopx.git';
const LOOPX_COMMIT = '7f2a020b18d1b5bb00da4044403ae72ddce2d743';
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
    // Compliance files shipped next to the binary. The pinned revision decides
    // which files exist (v1.0.x dropped TRADEMARKS.md), so stage what the
    // checkout carries instead of hard-coding the full list.
    const complianceFiles = readdirSync(src)
      .filter((name) => /^(LICENSE|NOTICE|TRADEMARKS)/i.test(name))
      .map((name) => path.join(src, name));

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
    // The workflow skills live in the loopx source tree at `skills/` and are
    // shipped for pip wheels via package-data. PyInstaller only bundles what
    // import analysis sees, so the skills data must be added explicitly.
    // Under PyInstaller the modules resolve under the extraction root
    // (sys._MEIPASS) and `workflow_skill_install.resolve_workflow_skill_source()`
    // checks `<extraction root>/skills` first (Path(__file__).parents[1]/skills),
    // so the destination must be the `skills` directory at the extraction root,
    // not `share/loopx/skills`. If the pinned upstream layout ever changes this
    // branch, keep the two in sync.
    const addDataSeparator = process.platform === 'win32' ? ';' : ':';
    const skillsAddData = `${path.join(src, 'skills')}${addDataSeparator}skills`;
    // LoopX v1.0.x moved the control plane core (coordination state, turn
    // envelopes, vision checkpoints) to a managed TypeScript effect runtime.
    // The Python sidecar starts it on demand with
    // `node --experimental-strip-types effect_runtime_server.ts` and computes
    // a source fingerprint by walking `loopx/control_plane/**` for .ts/.json
    // files (effect_runtime._scan_runtime_source_files); a missing tree fails
    // bootstrap with `packaged_runtime_source_unreadable`. PyInstaller import
    // analysis cannot see data-only sources, so stage the .ts/.json subset
    // into a shadow tree and add it as data at the same destination - staging
    // a subset (not the whole directory) keeps compiled .py modules out of the
    // data area, where loose sources could shadow the frozen modules.
    const controlPlaneSrc = path.join(src, 'loopx', 'control_plane');
    const controlPlaneStage = path.join(work, 'control_plane_runtime');
    rmSync(controlPlaneStage, { recursive: true, force: true });
    let stagedRuntimeFiles = 0;
    const stageRuntimeSources = (dir, rel) => {
      mkdirSync(path.join(controlPlaneStage, rel), { recursive: true });
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relEntry = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          stageRuntimeSources(path.join(dir, entry.name), relEntry);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.json')) {
          copyFileSync(path.join(dir, entry.name), path.join(controlPlaneStage, relEntry));
          stagedRuntimeFiles += 1;
        }
      }
    };
    stageRuntimeSources(controlPlaneSrc, '');
    if (stagedRuntimeFiles === 0) {
      throw new Error('pinned LoopX source has no control-plane TypeScript runtime files');
    }
    console.log(`build-loopx: staged ${stagedRuntimeFiles} TypeScript runtime files`);
    const runtimeAddData = `${controlPlaneStage}${addDataSeparator}${path.join('loopx', 'control_plane')}`;
    sh(pyinstaller, [
      '--onefile',
      '--name', 'loopx',
      '--clean',
      '--noconfirm',
      // The pinned CLI shells out to `gh` with `subprocess.run(..., text=True)`
      // and no explicit `encoding=`, so Python decodes the child's UTF-8 output
      // with `locale.getpreferredencoding(False)`. On a Windows host whose ANSI
      // code page is not UTF-8 (zh-CN / cp936) that raises
      // `UnicodeDecodeError: 'gbk' codec can't decode byte 0x80`, the reader
      // thread dies, `stdout` becomes None, and the caller surfaces the
      // misleading `the JSON object must be str, bytes or bytearray, not
      // NoneType`. `issue-fix workflow-plan --fetch-metadata` /
      // `--fetch-candidate-evidence` fail on any non-ASCII GitHub content.
      //
      // `PYTHONUTF8=1` in the child environment cannot fix it: the PyInstaller
      // bootloader pins `Py_UTF8Mode = 0` before `Py_Initialize()` and thereby
      // overrides the environment variable (verified live 2026-09-10 - the
      // frozen sidecar fails identically with and without those vars, while a
      // normal CPython flips `getpreferredencoding` to utf-8 under
      // `PYTHONUTF8=1`). Enabling UTF-8 mode in the frozen interpreter is the
      // only build-side fix.
      //
      // Verified by rebuilding and re-running the repro below on a cp936 host;
      // it must switch from exit=1 with the GBK traceback to the normal
      // `{"ok": true, "schema_version": "issue_fix_workflow_plan_packet_v0"}`:
      //   loopx issue-fix workflow-plan \
      //     --url "https://github.com/<owner>/<repo>/issues/<n-with-cjk-title>" \
      //     --fetch-metadata --format json --no-write-domain-state
      // The upstream complement (explicit `encoding="utf-8", errors="replace"`
      // on those subprocess calls) is tracked separately; neither replaces the
      // other, because this one also covers the other sites.
      '--python-option', 'X utf8=1',
      '--distpath', dist,
      '--workpath', path.join(work, 'build'),
      '--specpath', path.join(work, 'build'),
      '--add-data', skillsAddData,
      '--add-data', runtimeAddData,
      path.basename(entry),
    ], { cwd: src });

    const binary = path.join(dist, process.platform === 'win32' ? 'loopx.exe' : 'loopx');
    if (!existsSync(binary)) throw new Error(`PyInstaller produced no binary at ${binary}`);

    console.log('build-loopx: staging into', outDir);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(binary, path.join(outDir, path.basename(binary)));
    for (const file of complianceFiles) {
      copyFileSync(file, path.join(outDir, path.basename(file)));
    }

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
