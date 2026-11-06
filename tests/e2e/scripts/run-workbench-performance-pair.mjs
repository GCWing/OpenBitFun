/** Alternating, isolated A/B runs. Never compare a different sequence or binary. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareHomeVisuals } from './workbench-performance-visuals.mjs';
import { assertComparable, assertResourceMotion, motionDifference, processWindow } from './workbench-performance-metrics.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const before = process.env.OPENBITFUN_WORKBENCH_BASELINE_FRONTEND;
const after = process.env.OPENBITFUN_E2E_FRONTEND_DIR || path.join(repo, 'dist');
assert.ok(before, 'OPENBITFUN_WORKBENCH_BASELINE_FRONTEND must select a completed baseline snapshot');
const pairs = Number(process.env.OPENBITFUN_WORKBENCH_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const root = process.env.OPENBITFUN_WORKBENCH_PAIR_EVIDENCE || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-workbench-pair-'));
await mkdir(root, { recursive: true });
const summary = { schemaVersion: 1, runs: [], passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(`Paired workbench evidence: ${root}`);
const reports = [];
runs: for (let pair = 1; pair <= pairs; pair++) for (const arm of (pair % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline'])) {
  const directory = path.join(root, `${arm}-${pair}`);
  await mkdir(directory);
  const log = await open(path.join(directory, 'runner.log'), 'w');
  const child = spawn(process.execPath, [path.join(repo, 'tests/e2e/scripts/run-workbench-performance.mjs')], {
    cwd: repo, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
      OPENBITFUN_E2E_FRONTEND_DIR: arm === 'baseline' ? before : after,
      OPENBITFUN_WORKBENCH_LABEL: `${arm}-${pair}`, OPENBITFUN_WORKBENCH_EVIDENCE: directory,
      OPENBITFUN_WORKBENCH_STATE_GUARDS: '1', OPENBITFUN_WORKBENCH_ENFORCE_BUDGETS: '1',
      OPENBITFUN_WORKBENCH_MOTION_DIAGNOSTIC: '', OPENBITFUN_WORKBENCH_CONTAINMENT_DIAGNOSTIC: '',
    },
  });
  console.log(`Started ${arm}-${pair}`);
  const [exitCode] = await once(child, 'exit');
  await log.close();
  const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  reports.push(report);
  summary.runs.push({ arm, pair, directory, exitCode, passed: report.passed, failure: report.failure,
    frontend: report.frontend.revision, protocolHash: report.protocolHash, harnessHash: report.harnessHash });
  await save();
  console.log(`Completed ${arm}-${pair}: functional=${report.functionalPassed}, budgets=${report.performanceBudgetsPassed}`);
  if (!report.functionalPassed) break runs;
}
try {
  assert.equal(reports.length, pairs * 2);
  assertComparable(reports);
  reports.forEach(assertResourceMotion);
  const first = reports[0];
  summary.motion = reports.map(report => ({ label: report.label,
    maximumGeometryDifference: motionDifference(first.motionSignature, report.motionSignature) }));
  assert.ok(summary.motion.every(item => item.maximumGeometryDifference < 0.0001), 'Authored motion geometry must remain equivalent');
  summary.visuals = [];
  for (const report of reports) summary.visuals.push({ label: report.label, differences: await compareHomeVisuals(first.homeVisuals, report.homeVisuals) });
  summary.resources = reports.map(report => {
    const processes = report.processAttribution.candidates;
    const host = processes.find(item => item.role === 'host');
    const gpu = processes.filter(item => item.role === 'com.apple.WebKit.GPU');
    const web = processes.filter(item => item.role === 'com.apple.WebKit.WebContent');
    const peak = pid => Math.max(...report.resourceSamples.flatMap(row => row.processes.filter(p => p.pid === pid).map(p => p.rssMiB)));
    const primary = [...web].sort((a, b) => peak(b.pid) - peak(a.pid))[0];
    assert.ok(host && primary && gpu.length === 1, 'Ambiguous process candidates need manual attribution');
    return { label: report.label, candidateCounts: { gpu: gpu.length, webContent: web.length },
      windows: report.resourceWindows.map(window => ({ name: window.name,
        host: processWindow(window, host.pid), mainWebContentCandidate: processWindow(window, primary.pid),
        gpuCandidate: processWindow(window, gpu[0].pid),
        otherWebContentCandidates: web.filter(p => p.pid !== primary.pid).map(p => processWindow(window, p.pid)),
        domNodes: [window.before.domNodes, window.after.domNodes],
        animations: [window.before.animations, window.after.animations],
        systemGpu: report.resourceSamples.filter(row => row.at >= window.start.at && row.at <= window.end.at).map(row => row.gpu),
      })) };
  });
  summary.passed = summary.runs.every(run => run.exitCode === 0);
} catch (error) {
  summary.failure = error.stack || String(error);
  console.error(summary.failure);
}
await save();
if (!summary.passed) process.exitCode = 1;
