import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = process.env.OPENBITFUN_RESIDENCY_BASELINE_FRONTEND;
const optimized = process.env.OPENBITFUN_E2E_FRONTEND_DIR;
assert.ok(baseline && optimized, 'Select completed baseline and optimized frontend snapshots');
const pairs = Number(process.env.OPENBITFUN_RESIDENCY_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const root = path.resolve(process.env.OPENBITFUN_RESIDENCY_PAIR_EVIDENCE
  || await mkdtemp(path.join(os.tmpdir(), 'openbitfun-residency-pairs-')));
await mkdir(root, { recursive: true });
const summary = { pairs, order: 'AB/BA alternating', runs: [], comparable: false, passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(summary, null, 2));
const reports = [];
console.log(`Residency comparison: ${root}`);
await save();
try {
  for (let pair = 1; pair <= pairs; pair++) for (const arm of pair % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
    const directory = path.join(root, `${arm}-${pair}`);
    await mkdir(directory);
    const log = await open(path.join(directory, 'runner.log'), 'w');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run-workbench-residency.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env,
        OPENBITFUN_E2E_FRONTEND_DIR: arm === 'baseline' ? baseline : optimized,
        OPENBITFUN_RESIDENCY_LABEL: `${arm}-${pair}`, OPENBITFUN_RESIDENCY_EVIDENCE: directory,
      },
    });
    console.log(`Started ${arm}-${pair}`);
    const [exitCode] = await once(child, 'exit'); await log.close();
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    reports.push(report);
    summary.runs.push({ arm, pair, directory, exitCode, functionalPassed: report.functionalPassed,
      performanceBudgetsPassed: report.performanceBudgetsPassed, frontend: report.frontend.revision,
      protocolHash: report.protocolHash, harnessHash: report.harnessHash, failure: report.failure });
    await save();
    assert.equal(exitCode, 0, report.failure);
    assert.equal(report.functionalPassed, true, report.failure);
    const reference = reports[0];
    assert.equal(report.protocolHash, reference.protocolHash, 'Protocols must match');
    assert.equal(report.harnessHash, reference.harnessHash, 'Harnesses must match');
    assert.equal(report.binarySha256, reference.binarySha256, 'Native binaries must match');
    assert.deepEqual(report.environment, reference.environment, 'Host environments must match');
    console.log(`Completed ${arm}-${pair}: budgets=${report.performanceBudgetsPassed}`);
  }
  summary.comparable = true;
  summary.navigation = reports.map(report => ({ label: report.label, gates: report.performanceGates }));
  summary.resources = reports.map(report => ({ label: report.label,
    windows: report.windows.map(window => ({ name: window.name, elapsedMs: window.summary.elapsedMs,
      processes: window.summary.processes.map(process => ({ ...process,
        webview: report.webviews.find(view => view.pid === process.pid && view.startTicks === process.startTicks)?.handle ?? null,
      })), domNodes: [window.before.domNodes, window.after.domNodes],
      systemGpu: window.samples.map(sample => sample.systemGpu),
    })),
  }));
  summary.optimizedBudgetsPassed = summary.runs.filter(run => run.arm === 'optimized').every(run => run.performanceBudgetsPassed);
  summary.passed = summary.optimizedBudgetsPassed;
} catch (error) {
  summary.failure = error.stack || String(error); console.error(summary.failure);
}
await save();
if (!summary.passed) process.exitCode = 1;
