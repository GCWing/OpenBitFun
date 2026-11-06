/** Alternate immutable frontend arms with the same native scene-only workload. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareHomeVisuals } from './workbench-performance-visuals.mjs';
import { motionDifference, sceneWindowConditions } from './workbench-performance-metrics.mjs';

const baseline = process.env.OPENBITFUN_SCENE_BASELINE_FRONTEND;
const candidate = process.env.OPENBITFUN_E2E_FRONTEND_DIR;
assert.ok(baseline && candidate, 'Select completed baseline and candidate frontends');
const pairs = Number(process.env.OPENBITFUN_SCENE_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const root = path.resolve(process.env.OPENBITFUN_SCENE_PAIR_EVIDENCE
  || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-scene-pairs-')));
await mkdir(root, { recursive: true });
const summary = { schemaVersion: 1, pairs, order: 'AB/BA alternating', runs: [], results: [], comparable: false, passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(`Scene comparison: ${root}`);
await save();
let reference;
const revisions = new Map();
try {
  for (let pair = 1; pair <= pairs; pair++) for (const arm of pair % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    const label = `${arm}-${pair}`, directory = path.join(root, label);
    await mkdir(directory);
    const log = await open(path.join(directory, 'runner.log'), 'w');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run-scene-visibility.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
        OPENBITFUN_E2E_FRONTEND_DIR: arm === 'baseline' ? baseline : candidate,
        OPENBITFUN_SCENE_LABEL: label, OPENBITFUN_SCENE_EVIDENCE: directory },
    });
    console.log(`Started ${label}`);
    const [exitCode] = await once(child, 'exit'); await log.close();
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    summary.runs.push({ arm, pair, directory, exitCode, functionalPassed: report.functionalPassed,
      performanceBudgetsPassed: report.performanceBudgetsPassed, frontend: report.frontend.revision,
      protocolHash: report.protocolHash, harnessHash: report.harnessHash, failure: report.failure });
    await save();
    assert.equal(exitCode, 0, report.failure);
    assert.equal(report.functionalPassed, true, report.failure);
    reference ??= report;
    for (const key of ['protocolHash', 'harnessHash', 'binarySha256']) assert.equal(report[key], reference[key], key);
    assert.deepEqual(report.environment, reference.environment);
    assert.deepEqual(sceneWindowConditions([...report.actions, ...report.windows]),
      sceneWindowConditions([...reference.actions, ...reference.windows]), 'Match scene and document focus conditions across arms');
    if (revisions.has(arm)) assert.equal(report.frontend.digest, revisions.get(arm));
    else revisions.set(arm, report.frontend.digest);
    assert.equal(report.navigations.length, reference.navigations.length);
    const geometry = motionDifference(reference.motionSignature, report.motionSignature);
    assert.ok(geometry < 0.0001, 'Authored avatar geometry must remain equivalent');
    const visuals = await compareHomeVisuals(reference.homeVisuals, report.homeVisuals);
    for (const capture of report.homeVisuals) {
      assert.deepEqual(capture.placement, reference.homeVisuals.find(item => item.name === capture.name).placement,
        'Avatar placement, size and scroll must remain equivalent');
    }
    const resources = rows => rows.map(row => ({ name: row.name, ...row.summary,
      processes: row.summary.processes.map(process => ({ ...process,
        webview: report.webviews.find(view => view.pid === process.pid && view.startTicks === process.startTicks)?.handle ?? null })) }));
    summary.results.push({ label, geometry, visuals, gates: report.performanceGates,
      windows: resources(report.windows), actions: resources(report.actions) });
    await save();
    console.log(`Completed ${label}: budgets=${report.performanceBudgetsPassed}`);
  }
  summary.comparable = true;
  summary.pilot = pairs < 3 || reference.coverage.pilot;
  summary.passed = summary.runs.filter(run => run.arm === 'candidate').every(run => run.performanceBudgetsPassed);
} catch (error) {
  summary.failure = error.stack || String(error); console.error(summary.failure);
}
await save();
if (!summary.passed) process.exitCode = 1;
