import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('native CPU units and process attribution exclude another live process', { skip: process.platform !== 'darwin' }, async () => {
  const exec = promisify(execFile), root = await mkdtemp(path.join(os.tmpdir(), 'residency-probe-test-'));
  const probe = path.join(root, 'probe'), pidfile = path.join(root, 'pid');
  let child, unrelated;
  try {
    await exec('clang', ['-O2', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./native-process-probe.c', import.meta.url)), '-o', probe], { windowsHide: true });
    const calibrated = JSON.parse((await exec(probe, ['self-test'], { windowsHide: true })).stdout);
    assert.ok(Math.abs(calibrated.measuredCpuMs - calibrated.referenceCpuMs) < 5);
    unrelated = spawn('/bin/sleep', ['20'], { windowsHide: true, stdio: 'ignore' });
    child = spawn(probe, ['launch', pidfile, '/bin/sleep', '20'], { windowsHide: true, stdio: 'ignore' });
    let pid;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      try { pid = Number(await readFile(pidfile, 'utf8')); } catch {}
      if (!pid) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pid, 'Launcher must publish the actual target PID');
    const sample = JSON.parse((await exec(probe, ['sample', String(pid)], { windowsHide: true })).stdout);
    assert.equal(sample.hostResponsiblePid, pid);
    assert.ok(sample.processes.some(process => process.pid === pid && process.footprintBytes > 0));
    assert.ok(sample.processes.every(process => process.responsiblePid === pid));
    assert.ok(sample.processes.every(process => process.pid !== unrelated.pid && process.pid !== child.pid));
  } finally {
    await Promise.all([child, unrelated].filter(Boolean).map(async process => {
      if (process.exitCode !== null || process.signalCode !== null) return;
      const exited = once(process, 'exit'); process.kill('SIGTERM'); await exited;
    }));
    await rm(root, { recursive: true, force: true });
  }
});
