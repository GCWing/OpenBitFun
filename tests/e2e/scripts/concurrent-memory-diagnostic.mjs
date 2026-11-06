import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Native reads may change residency; invoke only outside sampled windows. */
export async function captureConcurrentAllocation(run, name) {
  const main = run.report.webviews.find(view => view.handle === 'main');
  assert.ok(main, 'Attribute the main WebContent before inspecting allocation');
  const sample = await run.resource();
  assert.ok(sample.processes.some(process => process.pid === main.pid && process.startTicks === main.startTicks && !process.error));
  const gpu = sample.processes.find(process => process.name === 'com.apple.WebKit.GPU' && !process.error);
  const requests = [
    { owner: 'main', pid: main.pid, kind: 'vmmap', args: ['-summary', String(main.pid)] },
    { owner: 'main', pid: main.pid, kind: 'heap', args: ['--sortBySize', '--showSizes', '--guessNonObjects', '--noContent', String(main.pid)] },
    ...(gpu ? [{ owner: 'gpu', pid: gpu.pid, kind: 'vmmap', args: ['-summary', String(gpu.pid)] }] : []),
  ];
  for (const request of requests) {
    const filename = `${name}-${request.owner}-${request.kind}.txt`;
    const row = { name, owner: request.owner, pid: request.pid, kind: request.kind,
      filename, outsideResourceWindow: true, startedAt: Date.now() };
    try {
      const { stdout, stderr } = await promisify(execFile)(request.kind, request.args,
        { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 ** 2 });
      await writeFile(path.join(run.root, filename), stdout + stderr);
      row.available = true;
    } catch (error) { row.available = false; row.error = String(error); }
    row.endedAt = Date.now();
    run.report.memoryAllocations.push(row); await run.save();
  }
}
