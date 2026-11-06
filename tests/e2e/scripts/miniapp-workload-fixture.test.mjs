import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { miniAppFixtureRequests } from '../helpers/miniapp-workload-fixture.mjs';

test('heavy MiniApp fixture performs bounded work and RPC through the real Worker host', async () => {
  const protocol = { installedApps: 30, activeApps: 3, rows: 3000, points: 400,
    workerIntervalMs: 50, workItems: 20000, rpcIntervalMs: 1000 };
  const root = await mkdtemp(path.join(os.tmpdir(), 'openbitfun-miniapp-fixture-'));
  let child, exited, output;
  try {
    const { quiet, active } = miniAppFixtureRequests(protocol, root);
    assert.equal(quiet.length, 27); assert.equal(active.length, 3);
    assert.ok(quiet.every(app => !app.permissions.node.enabled));
    assert.ok(active.every(app => app.permissions.node.enabled && app.source.esmDependencies.length === 0
      && app.source.npmDependencies.length === 0));
    const uiSyntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: active[0].source.uiJs, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(uiSyntax.status, 0, uiSyntax.stderr);
    await mkdir(path.join(root, 'source'));
    await writeFile(path.join(root, 'source/worker.js'), active[0].source.workerJs);
    // Keep the CommonJS resource outside the repository's ESM package scope,
    // as the native Worker integration fixtures do. Do not rewrite its source.
    const host = path.join(root, 'worker_host.cjs');
    await cp(fileURLToPath(new URL('../../../src/apps/desktop/resources/worker_host.js', import.meta.url)), host);
    child = spawn(process.execPath, [host, JSON.stringify(active[0].permissions)], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    const messages = [], parseErrors = [];
    let launchError;
    child.on('error', error => { launchError = error; });
    output = createInterface({ input: child.stderr });
    output.on('line', line => {
      try { messages.push(JSON.parse(line)); } catch { parseErrors.push(line); }
    });
    const waitFor = async match => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        assert.deepEqual(parseErrors, [], 'Worker host must emit valid protocol messages');
        const found = messages.find(match);
        if (found) return found;
        assert.equal(child.exitCode, null, 'Worker host must remain alive');
        await delay(10);
      }
      throw new Error('Fixture Worker response did not arrive');
    };
    const first = await waitFor(message => message.event === 'workload' && message.data.sequence >= 2);
    assert.equal(first.data.pid, child.pid);
    assert.equal(first.data.processedItems, first.data.sequence * protocol.workItems);
    assert.equal(first.data.points.length, protocol.points);
    assert.ok(first.data.points.every(point => Number.isFinite(point) && point >= 20 && point <= 140));
    child.stdin.write(JSON.stringify({ id: 'stats', method: 'workload.stats' }) + '\n');
    const stats = (await waitFor(message => message.id === 'stats')).result;
    assert.equal(stats.instance, first.data.instance);
    assert.equal(stats.pid, child.pid);
    child.stdin.write(JSON.stringify({ id: 'compute', method: 'workload.compute', params: { iterations: 200000 } }) + '\n');
    const computed = (await waitFor(message => message.id === 'compute')).result;
    assert.equal(computed.iterations, 200000);
    assert.ok(computed.processedItems >= stats.processedItems + 200000);
    assert.ok(computed.calls > stats.calls);
    for (const iterations of [-1, 1.5, 10000001]) {
      const id = `invalid-${iterations}`;
      child.stdin.write(JSON.stringify({ id, method: 'workload.compute', params: { iterations } }) + '\n');
      assert.equal((await waitFor(message => message.id === id)).error.message, 'Invalid fixture work size');
    }
    const later = await waitFor(message => message.event === 'workload' && message.data.sequence > computed.sequence);
    assert.ok(later.data.processedItems > computed.processedItems, 'RPC must not stop periodic business work');
    child.stdin.end();
    const result = await Promise.race([exited, delay(5000, null, { ref: false })]);
    assert.deepEqual(result, [0, null], 'Closing the host input must reap the Worker');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    output?.close();
    await rm(root, { recursive: true, force: true });
  }
});
