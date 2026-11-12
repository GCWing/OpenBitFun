import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('desktop updates use the official registry crate without a source patch', () => {
  const manifest = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
  const patches = manifest.split('[patch.crates-io]')[1].split(/^\[/m)[0];
  assert.doesNotMatch(patches, /^tauri-plugin-updater\s*=/m);
  assert.equal(existsSync(new URL('../third_party/tauri-plugin-updater', import.meta.url)), false);
  const lock = readFileSync(new URL('../Cargo.lock', import.meta.url), 'utf8');
  const updater = lock.match(/\[\[package\]\]\r?\nname = "tauri-plugin-updater"[\s\S]*?(?=\[\[package\]\]|$)/)?.[0];
  assert.ok(updater);
  assert.match(updater, /source = "registry\+https:\/\/github.com\/rust-lang\/crates.io-index"/);
  assert.match(updater, /checksum = "[0-9a-f]{64}"/);
});

test('native Windows supervisor records startup failure before authorizing application exit', { skip: process.platform !== 'win32' }, t => {
  const temp = mkdtempSync(join(tmpdir(), "openbitfun-update-'测试-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = readFileSync(new URL('../src/apps/desktop/src/update_maintenance/windows.rs', import.meta.url), 'utf8');
  const template = source.match(/r#"(\$ErrorActionPreference='Stop'[\s\S]*?)"#,/)?.[1];
  assert.ok(template, 'use the production supervisor source');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const receipt = join(temp, 'result.json');
  const args = {
    pid: String(process.pid), version: "'2.0.0'", file: quote(join(temp, 'missing-installer.exe')),
    parameters: "''", transactional: '$true', event: quote(`Local\\OpenBitFunUpdate-test-${process.pid}`),
    elevate: '$false', receipt: quote(receipt), current: quote(join(temp, 'missing-application.exe')), restart: "''",
    user_results: quote(join(temp, 'user-results')), machine_results: quote(join(temp, 'machine-results')), cleanup: "''",
  };
  const fields = [];
  const script = template.replace(/\{([a-z_]+)\}/g, (_, key) => {
    assert.ok(key in args, key); fields.push(args[key]); return `\u0001${fields.length - 1}\u0002`;
  }).replaceAll('{{', '{').replaceAll('}}', '}')
    .replace(/\u0001(\d+)\u0002/g, (_, index) => fields[Number(index)]);
  const result = spawnSync(join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ERROR:/);
  assert.doesNotMatch(result.stdout, /^READY$/m);
  const saved = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(saved.version, '2.0.0'); assert.equal(saved.success, false);
  assert.ok(saved.error); assert.equal(saved.exitCode, null);
  const fakeNativeWorker = `function Start-Process {
    param([string]$FilePath,[string]$ArgumentList,[switch]$PassThru,[string]$Verb)
    $id=[regex]::Match($ArgumentList,'/RESULT_ID=([0-9a-f]+)').Groups[1].Value
    if(!$id) { throw 'Missing native result identifier' }
    foreach($directory in @(${args.user_results},${args.machine_results})) {
      [IO.Directory]::CreateDirectory($directory) | Out-Null
      [IO.File]::WriteAllText((Join-Path $directory ($id+'.json')), '{"exitCode":1,"error":"Cannot back up locked runtime 运行时; previous files restored"}')
    }
    return [pscustomobject]@{HasExited=$true;ExitCode=1}
  }
`;
  const detailed = spawnSync(join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fakeNativeWorker + script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  // EncodedCommand may retain a handled failure in its process status. The
  // readiness line and persisted native outcome are the supervisor contract.
  assert.ok(detailed.status === 0 || detailed.status === 1, detailed.stdout + detailed.stderr);
  assert.match(detailed.stdout, /^ERROR: Cannot back up locked runtime/);
  const nativeResult = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(nativeResult.exitCode, 1);
  assert.match(nativeResult.error, /previous files restored/);
  assert.match(nativeResult.error, /运行时/);
});
