import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResidencyWindow } from './residency-metrics.mjs';

const p = (pid, startTicks, cpuMs, footprintBytes = 2 ** 20) => ({ pid, startTicks, cpuMs,
  name: 'fixture', footprintBytes, rssBytes: footprintBytes * 2, idleWakeups: cpuMs,
  diskReadBytes: 0, diskWriteBytes: 0 });
test('CPU uses monotonic time; footprint and RSS stay separate', () => {
  const result = summarizeResidencyWindow([
    { monotonicMs: 10, processes: [p(1, 'a', 5)] },
    { monotonicMs: 2010, processes: [p(1, 'a', 105, 3 * 2 ** 20)] },
  ]).processes[0];
  assert.equal(result.cpuPercent, 5);
  assert.equal(result.endFootprintMiB, 3);
  assert.equal(result.endRssMiB, 6);
  assert.equal(result.idleWakeupsPerSecond, 50);
  assert.equal(result.completeWindow, true);
});
test('PID recycling, arrivals and exits never become whole-window CPU data', () => {
  const result = summarizeResidencyWindow([
    { monotonicMs: 0, processes: [p(1, 'old', 100)] },
    { monotonicMs: 1000, processes: [p(1, 'old', 200), p(2, 'other', 20)] },
    { monotonicMs: 2000, processes: [p(1, 'new', 10), p(2, 'other', 40)] },
  ]).processes;
  assert.equal(result.length, 3);
  assert.ok(result.every(row => !row.completeWindow));
  assert.equal(result.find(row => row.startTicks === 'new').cpuPercent, null);
  assert.equal(result.find(row => row.startTicks === 'old').cpuPercent, 10);
});
