import assert from 'node:assert/strict';

export function summarizeResidencyWindow(samples) {
  assert.ok(samples.length >= 2, 'A resource window requires independent boundaries');
  const first = samples[0], last = samples.at(-1);
  const elapsedMs = last.monotonicMs - first.monotonicMs;
  assert.ok(elapsedMs > 0, 'Resource time must advance');
  const identities = new Map();
  for (const sample of samples) for (const process of sample.processes) {
    if (process.error) continue;
    const key = `${process.pid}:${process.startTicks}`;
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push({ ...process, at: sample.monotonicMs });
  }
  return { elapsedMs, processes: [...identities.values()].map(rows => {
    const begin = rows[0], end = rows.at(-1);
    const coveredMs = end.at - begin.at;
    const completeWindow = begin.at === first.monotonicMs && end.at === last.monotonicMs;
    const deltaCpuMs = end.cpuMs - begin.cpuMs;
    assert.ok(deltaCpuMs >= 0, 'Cumulative CPU cannot go backwards for one process identity');
    return { pid: begin.pid, name: begin.name, startTicks: begin.startTicks, completeWindow,
      coveredMs, sampleCount: rows.length, cpuMs: deltaCpuMs,
      cpuPercent: coveredMs > 0 ? deltaCpuMs / coveredMs * 100 : null,
      startFootprintMiB: begin.footprintBytes / 2 ** 20, endFootprintMiB: end.footprintBytes / 2 ** 20,
      peakFootprintMiB: Math.max(...rows.map(row => row.footprintBytes)) / 2 ** 20,
      endRssMiB: end.rssBytes / 2 ** 20,
      idleWakeupsPerSecond: coveredMs > 0 ? (end.idleWakeups - begin.idleWakeups) / coveredMs * 1000 : null,
      diskReadBytes: end.diskReadBytes - begin.diskReadBytes,
      diskWriteBytes: end.diskWriteBytes - begin.diskWriteBytes,
    };
  }) };
}
