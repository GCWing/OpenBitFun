/** Alternate unchanged and optimized packaged frontends under the exact same harness. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = process.env.OPENBITFUN_PET_BASELINE_FRONTEND;
const optimized = process.env.OPENBITFUN_E2E_FRONTEND_DIR;
assert.ok(baseline && optimized, 'Set OPENBITFUN_PET_BASELINE_FRONTEND and OPENBITFUN_E2E_FRONTEND_DIR');
const pairs = Number(process.env.OPENBITFUN_PET_PAIRS || 3);
assert.ok(Number.isInteger(pairs) && pairs > 0);
const root = await mkdtemp(path.join(os.tmpdir(), 'openbitfun-pet-pairs-'));
const result = { protocol: 'AB / BA / AB alternating; fresh process and storage for every run', runs: [], summary: [], passed: false };
const save = () => writeFile(path.join(root, 'comparison.json'), JSON.stringify(result, null, 2));
console.log(`Pet paired evidence: ${root}`);
await save();
for (let i = 0; i < pairs; i++) {
  for (const label of i % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
    let output = '';
    const child = spawn(process.execPath, [fileURLToPath(new URL('./run-pet-performance.mjs', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENBITFUN_E2E_FRONTEND_DIR: label === 'baseline' ? baseline : optimized,
        OPENBITFUN_PET_LABEL: `${label}-${i + 1}` },
    });
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    const [code] = await once(child, 'exit');
    const directory = output.match(/Pet performance evidence: (.+)/)?.[1];
    const report = directory ? JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')) : null;
    result.runs.push({ pair: i + 1, label, directory, report });
    await save();
    assert.equal(code, 0, `${label} failed; inspect ${directory}`);
    assert.equal(report?.passed, true);
    const reference = result.runs[0].report;
    assert.equal(report.binarySha256, reference.binarySha256);
    assert.equal(report.harnessHash, reference.harnessHash);
    assert.deepEqual(report.protocol, reference.protocol);
    assert.deepEqual(report.environment, reference.environment);
    if (label === 'optimized') {
      for (const window of report.windows) {
        for (const snapshot of [window.before, window.after]) {
          if (window.name === 'rest' || window.name === 'working-bubble') {
            assert.equal(snapshot.sprite.name, 'openbitfun-petdex-walk', 'BitBlob must retain atlas-only motion');
            assert.equal(snapshot.sprite.width, 96);
            assert.equal(snapshot.sprite.height, 104);
          } else if (window.name === 'hidden') {
            assert.equal(snapshot.visibility, 'hidden');
            assert.ok(snapshot.sprite.state.split(',').every(state => state.trim() === 'paused'));
          }
        }
      }
    }
    const closed = report.windows.find(window => window.name === 'closed');
    assert.ok(!closed.samples.at(-1).processes.some(p => report.processAttribution.petCandidatePids.includes(p.pid)),
      'Destroying the companion must release its WebContent candidate');
  }
}
const median = values => {
  const v = values.slice().sort((a, b) => a - b), middle = Math.floor(v.length / 2);
  return v.length ? v.length % 2 ? v[middle] : (v[middle - 1] + v[middle]) / 2 : null;
};
const select = (report, row, role) => role === 'total' || (role === 'host' ? row.pid === report.processAttribution.hostPid
  : role === 'pet-WebContent' ? row.role === 'com.apple.WebKit.WebContent' && report.processAttribution.petCandidatePids.includes(row.pid)
    : role === 'main-WebContent' ? row.role === 'com.apple.WebKit.WebContent' && report.processAttribution.mainCandidatePids.includes(row.pid)
      : row.role === role);
for (const name of result.runs[0].report.protocol.phases) {
  for (const role of ['host', 'pet-WebContent', 'main-WebContent', 'com.apple.WebKit.GPU', 'total']) {
    const row = { name, role };
    for (const label of ['baseline', 'optimized']) {
      const samples = result.runs.filter(run => run.label === label).map(({ report }) => {
        const window = report.windows.find(w => w.name === name);
        const processes = window.cpu.filter(p => select(report, p, role));
        return { cpuPercent: processes.reduce((s, p) => s + p.cpuPercent, 0),
          endRssMiB: processes.reduce((s, p) => s + p.endRssMiB, 0),
          peakRssMiB: Math.max(...window.samples.map(sample => sample.processes.filter(p => select(report, p, role)).reduce((s, p) => s + p.rssMiB, 0))) };
      });
      row[label] = { samples, medianCpuPercent: median(samples.map(s => s.cpuPercent)),
        medianEndRssMiB: median(samples.map(s => s.endRssMiB)), medianPeakRssMiB: median(samples.map(s => s.peakRssMiB)) };
    }
    result.summary.push(row);
  }
}
result.passed = true;
await save();
console.log(`Pet paired comparison completed: ${root}`);
