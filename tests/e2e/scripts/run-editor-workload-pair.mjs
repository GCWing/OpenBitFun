/** Sequential matched editor workloads. Both frontends must already be built. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = process.env.OPENBITFUN_EDITOR_BASELINE_FRONTEND;
const optimized = process.env.OPENBITFUN_E2E_FRONTEND_DIR;
assert.ok(baseline && optimized, 'Select completed baseline and candidate frontends');
const pairs = Number(process.env.OPENBITFUN_EDITOR_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const requestedRoot = process.env.OPENBITFUN_EDITOR_PAIR_EVIDENCE;
const root = path.resolve(requestedRoot || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-editor-pairs-')));
if (requestedRoot) await mkdir(root);
await cp(fileURLToPath(import.meta.url), path.join(root, 'pair-runner.mjs'));
const summary = { schemaVersion: 1, pairs, order: 'AB/BA alternating', runs: [], results: [],
  repetitionsSufficient: pairs >= 3, comparable: false, passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(`Editor comparison: ${root}`);
await save();
let reference;
try {
  for (let pair = 1; pair <= pairs; pair++) for (const arm of pair % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
    const label = `${arm}-${pair}`, directory = path.join(root, label);
    await mkdir(directory);
    const log = await open(path.join(directory, 'runner.log'), 'w');
    let exitCode;
    try {
      const child = spawn(process.execPath, ['--experimental-strip-types',
        fileURLToPath(new URL('./run-editor-workload.mjs', import.meta.url))], {
        windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
          OPENBITFUN_E2E_FRONTEND_DIR: arm === 'baseline' ? baseline : optimized,
          OPENBITFUN_EDITOR_LABEL: label, OPENBITFUN_EDITOR_EVIDENCE: directory,
        },
      });
      console.log(`Started ${label}`);
      [exitCode] = await once(child, 'exit');
    } finally { await log.close(); }
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    summary.runs.push({ arm, pair, directory, exitCode, functionalPassed: report.functionalPassed,
      performanceBudgetsPassed: report.performanceBudgetsPassed, frontend: report.frontend.revision,
      protocolHash: report.protocolHash, harnessHash: report.harnessHash, failure: report.failure });
    await save();
    assert.equal(exitCode, 0, report.failure);
    assert.equal(report.functionalPassed, true, report.failure);
    assert.equal(report.coverage.pilot, false, 'Shortened or instrumented runs are not formal comparisons');
    assert.notEqual(report.coverage.instrumented, true);
    assert.equal(report.coverage.languageServiceReadiness, true);
    assert.equal(report.coverage.hotSceneTabs, true);
    reference ??= report;
    assert.equal(report.protocolHash, reference.protocolHash, 'Protocols must match');
    assert.equal(report.harnessHash, reference.harnessHash, 'Harnesses must match');
    assert.equal(report.binarySha256, reference.binarySha256, 'Native binaries must match');
    assert.deepEqual(report.environment, reference.environment, 'Host environments must match');
    const resources = rows => rows.map(row => ({ name: row.name, ...row.summary,
      processes: row.summary.processes.map(process => ({ ...process,
        webview: report.webviews.find(view => view.pid === process.pid && view.startTicks === process.startTicks)?.handle ?? null,
      })),
    }));
    summary.results.push({ label, windows: resources(report.windows), actions: resources(report.actions),
      interactions: report.interactions.map(({ name, frames, inputRaf }) => ({ name, frames, inputRaf })),
      navigation: report.navigation, openings: report.openings, languageReadiness: report.languageReadiness,
      checks: report.checks, closedTabs: report.closedTabs,
    });
    await save();
    console.log(`Completed ${label}: budgets=${report.performanceBudgetsPassed}`);
  }
  summary.comparable = true;
  summary.passed = summary.repetitionsSufficient
    && summary.runs.filter(run => run.arm === 'optimized').every(run => run.performanceBudgetsPassed);
} catch (error) {
  summary.failure = error.stack || String(error); console.error(summary.failure);
}
await save();
if (!summary.passed) process.exitCode = 1;
