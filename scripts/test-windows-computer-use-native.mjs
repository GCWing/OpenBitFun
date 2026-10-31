// Native mode tests the whole shared provider. Cross-host mode type-checks the
// same Rust lib with its declared dependencies, without compiling/linking C.
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
if (process.platform !== 'win32' && !check) {
  throw new Error('Native tests require Windows. Use --check --target x86_64-pc-windows-msvc for Rust types only.');
}
const run = cargoArgs => new Promise((resolve, reject) => {
  const child = spawn('cargo', cargoArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('close', code => resolve(code ?? 1));
});
if (!check) {
  process.exitCode = await run(['test', '--locked', '-p', 'openbitfun-computer-use', '--lib', ...args]);
} else {
  const dir = await mkdtemp(join(tmpdir(), 'openbitfun-windows-native-'));
  try {
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version=1'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }));
    const pkg = metadata.packages.find(item => item.name === 'openbitfun-computer-use');
    const quote = JSON.stringify;
    let manifest = `[package]\nname = "windows-computer-use-typecheck"\nversion = "0.0.0"\nedition = ${quote(pkg.edition)}\n[workspace]\n[lib]\npath = ${quote(pkg.targets.find(t => t.kind.includes('lib')).src_path)}\n[features]\n`;
    for (const [feature, values] of Object.entries(pkg.features)) manifest += `${quote(feature)} = ${quote(values)}\n`;
    for (const dep of pkg.dependencies.filter(dep => dep.kind !== 'build')) {
      const section = dep.kind === 'dev' ? 'dev-dependencies' : 'dependencies';
      manifest += `\n[${dep.target ? `target.${quote(dep.target)}.` : ''}${section}.${quote(dep.rename ?? dep.name)}]\n`;
      manifest += `package = ${quote(dep.name)}\nversion = ${quote(dep.req)}\ndefault-features = ${dep.uses_default_features}\nfeatures = ${quote(dep.features)}\n`;
      if (dep.path) manifest += `path = ${quote(dep.path)}\n`;
      if (dep.optional) manifest += 'optional = true\n';
    }
    await writeFile(join(dir, 'Cargo.toml'), manifest);
    await copyFile(join(root, 'Cargo.lock'), join(dir, 'Cargo.lock'));
    // All native implementations, runtime admission and tests come from the
    // actual crate. This mode deliberately provides no evidence of C ABI/linking.
    process.exitCode = await run(['check', '--offline', '--manifest-path', join(dir, 'Cargo.toml'), '--tests', '--target-dir', join(root, 'target/windows-computer-use-native'), ...args]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
