#!/usr/bin/env node
// Build the window-only executable in its own Cargo invocation so Desktop's
// feature union and debug profile cannot inflate every exported MiniApp.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHELL_NAME = 'openbitfun-miniapp-shell';

export function prepareMiniAppShell({
  root = ROOT, target, profile = 'debug', env = process.env, run = spawnSync,
} = {}) {
  const shellEnv = { ...env };
  // The sidecar has its own Tauri context; a parent CLI's config must not embed
  // the full frontend, apply product commands, or recursively run build hooks.
  delete shellEnv.TAURI_CONFIG;
  const execute = (command, args, options = {}) => {
    const result = run(command, args, {
      cwd: root, env: shellEnv, shell: false, windowsHide: true, stdio: 'inherit', ...options,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`MiniApp shell preparation failed: ${result.error?.message || result.stderr || result.status}`);
    }
    return result;
  };
  const host = String(execute('rustc', ['-vV'], { encoding: 'utf8', stdio: 'pipe' }).stdout)
    .match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) throw new Error('rustc did not report the host target triple');
  // Derive native-window visuals from the same Hi/FlowChat style owners.
  execute('node', ['scripts/generate-miniapp-chat-styles.mjs']);
  execute('node', ['scripts/generate-miniapp-chrome-theme.mjs']);
  const triple = target || host;
  const targetDir = env.CARGO_TARGET_DIR ? resolve(root, env.CARGO_TARGET_DIR) : join(root, 'target');
  const extension = triple.includes('windows') ? '.exe' : '';
  const name = `${SHELL_NAME}${extension}`;
  const triples = triple === 'universal-apple-darwin'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target];
  const binaries = triples.map((buildTarget) => {
    execute('cargo', ['build', '--locked', '-p', SHELL_NAME, '--profile', 'miniapp-shell',
      ...(buildTarget ? ['--target', buildTarget] : [])]);
    const binary = join(targetDir, ...(buildTarget ? [buildTarget] : []), 'miniapp-shell', name);
    const bytes = statSync(binary).size;
    if (bytes === 0 || bytes > 16 * 1048576) {
      throw new Error(`MiniApp shell exceeds its per-architecture 16 MiB artifact budget or is empty: ${bytes} bytes`);
    }
    return binary;
  });
  const sidecarDir = join(root, 'src/apps/desktop/gen/miniapp-shell');
  mkdirSync(sidecarDir, { recursive: true });
  const sidecarBase = join(sidecarDir, SHELL_NAME);
  const sidecar = `${sidecarBase}-${triple}${extension}`;
  if (binaries.length > 1) {
    execute('lipo', ['-create', ...binaries, '-output', sidecar]);
  } else {
    copyFileSync(binaries[0], sidecar);
  }
  chmodSync(sidecar, statSync(sidecar).mode | 0o111);
  // Tauri bundles externalBin alongside the host. Raw dev/no-bundle builds
  // require the same sibling layout, including custom target/profile folders.
  const stage = join(targetDir, ...(target ? [target] : []), profile, name);
  mkdirSync(dirname(stage), { recursive: true });
  copyFileSync(sidecar, stage);
  chmodSync(stage, statSync(stage).mode | 0o111);
  const bytes = statSync(sidecar).size;
  console.log(`[miniapp-shell] ${triple}: ${(bytes / 1048576).toFixed(2)} MiB`);
  return { sidecarBase, sidecar, stage, bytes, target: triple };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  prepareMiniAppShell({
    target: args.includes('--target') ? option('--target') : undefined,
    profile: args.includes('--profile') ? option('--profile') : 'debug',
  });
}
