import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../helpers/flowchat-frame-metrics.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { latencyDistribution, probeFrameDistributions } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`,
);

test('latency reports nearest-rank percentiles, counts and the ordinary average', () => {
  assert.deepEqual(latencyDistribution(Array.from({ length: 100 }, (_, index) => 100 - index)), {
    samples: 100, p50Ms: 50, p90Ms: 90, p95Ms: 95, p99Ms: 99, maxMs: 100, meanMs: 50.5,
  });
  assert.equal(latencyDistribution([10, 90]).p95Ms, 90);
  assert.equal(latencyDistribution([]).meanMs, 0);
});

test('active input includes crossing frames but idle settling cannot dilute stalls', () => {
  const times = [0, 16, 32, 72, 132, 149, 269, 286, 302, 318];
  const measure = values => probeFrameDistributions({ frames: values.map(time => ({ time })), wheelTimes: [30, 130] });
  const active = measure(times).activeWheel;
  assert.equal(active.samples, 5);
  assert.deepEqual(active.overBudget.map(({ count, percent }) => [count, percent]), [[3, 60], [2, 40], [1, 20]]);
  assert.equal(active.stallEpisodes, 2);
  assert.equal(active.longestStallFrames, 2);
  assert.equal(active.longestStallMs, 120);
  assert.deepEqual(measure([...times, ...Array.from({ length: 100 }, (_, index) => 334 + index * 16)]).activeWheel, active);
});

test('non-wheel phases keep their complete distribution without inventing input samples', () => {
  const report = probeFrameDistributions({ frames: [{ time: 0 }, { time: 16 }, { time: 32 }] });
  assert.equal(report.phase.samples, 2);
  assert.equal(report.phase.p50Ms, 16);
  assert.equal(report.activeWheel, undefined);
});
