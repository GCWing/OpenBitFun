/** Matched native workload comparisons; builds must finish before this runner. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unfocusedWindowConditions } from './workbench-performance-metrics.mjs';

const baseline = process.env.OPENBITFUN_CONCURRENT_BASELINE_FRONTEND;
const optimized = process.env.OPENBITFUN_E2E_FRONTEND_DIR;
assert.notEqual(process.env.OPENBITFUN_CONCURRENT_MEMORY_DIAGNOSTIC, '1', 'Memory diagnostics cannot establish uninstrumented A/B acceptance');
assert.ok(baseline && optimized, 'Select completed baseline and candidate frontends');
const pairs = Number(process.env.OPENBITFUN_CONCURRENT_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const root = path.resolve(process.env.OPENBITFUN_CONCURRENT_PAIR_EVIDENCE
  || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-concurrent-pairs-')));
await mkdir(root, { recursive: true });
const summary = { schemaVersion: 1, pairs, order: 'AB/BA alternating', runs: [], results: [],
  pilot: pairs < 3, comparable: false, passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(`Concurrent comparison: ${root}`);
await save();
let reference;
const revisions = new Map();
const conditions = report => unfocusedWindowConditions([...report.actions, ...report.windows], {
  'real-tools-startup': 'session', 'bounded-stream-with-concurrent-input': 'session',
  'cancel-active-generation': 'session', 'before-generation': 'session',
  'after-completion': 'session', 'after-cancellation': 'session', 'after-close': 'personal-overview',
});
try {
  for (let pair = 1; pair <= pairs; pair++) for (const arm of pair % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
    const label = `${arm}-${pair}`, directory = path.join(root, label);
    await mkdir(directory);
    const log = await open(path.join(directory, 'runner.log'), 'w');
    const child = spawn(process.execPath, ['--experimental-strip-types',
      fileURLToPath(new URL('./run-concurrent-workload.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
        OPENBITFUN_E2E_FRONTEND_DIR: arm === 'baseline' ? baseline : optimized,
        OPENBITFUN_CONCURRENT_LABEL: label, OPENBITFUN_CONCURRENT_EVIDENCE: directory,
      },
    });
    console.log(`Started ${label}`);
    const [exitCode] = await once(child, 'exit'); await log.close();
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    summary.pilot ||= report.coverage.pilot;
    summary.runs.push({ arm, pair, directory, exitCode, functionalPassed: report.functionalPassed,
      performanceBudgetsPassed: report.performanceBudgetsPassed, frontend: report.frontend.revision,
      protocolHash: report.protocolHash, harnessHash: report.harnessHash, failure: report.failure });
    await save();
    assert.equal(exitCode, 0, report.failure);
    assert.equal(report.functionalPassed, true, report.failure);
    reference ??= report;
    assert.equal(report.protocolHash, reference.protocolHash, 'Protocols must match');
    assert.equal(report.harnessHash, reference.harnessHash, 'Harnesses must match');
    assert.equal(report.binarySha256, reference.binarySha256, 'Native binaries must match');
    assert.deepEqual(report.environment, reference.environment, 'Host environments must match');
    assert.deepEqual(conditions(report), conditions(reference), 'Match scene and document focus at resource window endpoints');
    if (revisions.has(arm)) assert.equal(report.frontend.digest, revisions.get(arm));
    else revisions.set(arm, report.frontend.digest);
    const resources = rows => rows.map(row => ({ name: row.name, ...row.summary,
      processes: row.summary.processes.map(process => ({ ...process,
        webview: report.webviews.find(view => view.pid === process.pid && view.startTicks === process.startTicks)?.handle ?? null,
      })),
    }));
    summary.results.push({ label, windows: resources(report.windows), actions: resources(report.actions),
      interactions: report.interactions.map(({ name, frames, inputRaf }) => ({ name, frames, inputRaf })),
      navigations: report.navigations, cancel: report.cancel, cancelledAnimations: report.cancelAnimationOwners });
    await save();
    console.log(`Completed ${label}: budgets=${report.performanceBudgetsPassed}`);
  }
  summary.comparable = true;
  summary.pilot = pairs < 3 || reference.coverage.pilot;
  summary.passed = summary.runs.filter(run => run.arm === 'optimized').every(run => run.performanceBudgetsPassed);
} catch (error) {
  summary.failure = error.stack || String(error); console.error(summary.failure);
}
await save();
if (!summary.passed) process.exitCode = 1;
