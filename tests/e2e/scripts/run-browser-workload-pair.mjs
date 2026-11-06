/** Sequential matched Browser workloads. Build both frontends before running. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = process.env.OPENBITFUN_BROWSER_BASELINE_FRONTEND;
const optimized = process.env.OPENBITFUN_E2E_FRONTEND_DIR;
assert.ok(baseline && optimized, 'Select completed baseline and candidate frontends');
const baselineBinary = process.env.OPENBITFUN_BROWSER_BASELINE_BINARY;
const optimizedBinary = process.env.OPENBITFUN_E2E_DESKTOP_BINARY;
if (baselineBinary) assert.ok(optimizedBinary, 'Select the candidate native binary explicitly');
const pairs = Number(process.env.OPENBITFUN_BROWSER_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const requestedRoot = process.env.OPENBITFUN_BROWSER_PAIR_EVIDENCE;
const root = path.resolve(requestedRoot || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-browser-pairs-')));
if (requestedRoot) await mkdir(root);
await cp(fileURLToPath(import.meta.url), path.join(root, 'pair-runner.mjs'));
const summary = { schemaVersion: 2, pairs, axis: baselineBinary ? 'native' : 'frontend',
  order: 'AB/BA alternating', runs: [], results: [], comparable: false, passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(`Browser comparison: ${root}`);
await save();
let reference;
const armBuilds = new Map();
try {
  for (let pair = 1; pair <= pairs; pair++) for (const arm of pair % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
    const label = `${arm}-${pair}`, directory = path.join(root, label);
    await mkdir(directory);
    const log = await open(path.join(directory, 'runner.log'), 'w');
    let exitCode;
    try {
      const child = spawn(process.execPath, ['--experimental-strip-types',
        fileURLToPath(new URL('./run-browser-workload.mjs', import.meta.url))], {
        windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
          OPENBITFUN_E2E_FRONTEND_DIR: arm === 'baseline' ? baseline : optimized,
          OPENBITFUN_E2E_DESKTOP_BINARY: arm === 'baseline' && baselineBinary ? baselineBinary : optimizedBinary,
          OPENBITFUN_BROWSER_LABEL: label, OPENBITFUN_BROWSER_EVIDENCE: directory,
        },
      });
      console.log(`Started ${label}`);
      [exitCode] = await once(child, 'exit');
    } finally { await log.close(); }
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    summary.runs.push({ arm, pair, directory, exitCode, functionalPassed: report.functionalPassed,
      performanceBudgetsPassed: report.performanceBudgetsPassed, frontend: report.frontend.revision,
      binarySha256: report.binarySha256,
      protocolHash: report.protocolHash, harnessHash: report.harnessHash, failure: report.failure });
    await save();
    assert.equal(exitCode, 0, report.failure);
    assert.equal(report.functionalPassed, true, report.failure);
    assert.equal(report.coverage.pilot, false, 'A shortened run is not a formal comparison');
    assert.notEqual(report.coverage.instrumented, true, 'Instrumented diagnostics cannot be acceptance samples');
    reference ??= report;
    assert.equal(report.protocolHash, reference.protocolHash, 'Protocols must match');
    assert.equal(report.harnessHash, reference.harnessHash, 'Harnesses must match');
    const build = { frontend: report.frontend.revision, native: report.binarySha256 };
    if (!armBuilds.has(arm)) armBuilds.set(arm, build);
    assert.deepEqual(build, armBuilds.get(arm), 'Each arm must use immutable builds across all pairs');
    if (baselineBinary) {
      assert.equal(report.frontend.revision, reference.frontend.revision, 'Native comparison requires identical frontends');
    } else {
      assert.equal(report.binarySha256, reference.binarySha256, 'Frontend comparison requires identical native binaries');
    }
    assert.deepEqual(report.environment, reference.environment, 'Host environments must match');
    const resources = rows => rows.map(row => ({ name: row.name, ...row.summary,
      processes: row.summary.processes.map(process => ({ ...process,
        webview: report.webviews.find(view => view.pid === process.pid && view.startTicks === process.startTicks)?.handle ?? null,
      })),
    }));
    summary.results.push({ label, windows: resources(report.windows), actions: resources(report.actions),
      interactions: report.interactions.map(({ name, frames, inputRaf }) => ({ name, frames, inputRaf })),
      dividers: report.dividers.map(({ selector, frames }) => ({ selector, frames })),
      navigation: report.navigation, openings: report.openings, gates: report.gates,
    });
    await save();
    console.log(`Completed ${label}: budgets=${report.performanceBudgetsPassed}`);
  }
  summary.comparable = true;
  summary.passed = summary.runs.filter(run => run.arm === 'optimized').every(run => run.performanceBudgetsPassed);
} catch (error) {
  summary.failure = error.stack || String(error); console.error(summary.failure);
}
await save();
if (!summary.passed) process.exitCode = 1;
