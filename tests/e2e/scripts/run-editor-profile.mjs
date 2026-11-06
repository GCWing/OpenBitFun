/** Independent native stacks and creation/layout diagnostics; never an A/B benchmark. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { EditorProfilePage } from '../page-objects/EditorProfilePage.mjs';

const protocol = { name: 'native-editor-creation-diagnostic', version: 1, diagnosticOnly: true,
  prewarmMs: 15000, settleMs: 5000, fileLines: [30000, 30000, 8000, 8000, 8000, 8000],
  cycles: 4, stackDurationSeconds: 20, stackIntervalMs: 1 };
const run = await openNativeWorkload({ Page: EditorProfilePage, protocol, label: 'editor-creation',
  evidence: process.env.OPENBITFUN_EDITOR_PROFILE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-editor-profile.mjs', 'tests/e2e/page-objects/EditorProfilePage.mjs',
    'tests/e2e/page-objects/EditorLanguagePage.mjs', 'tests/e2e/page-objects/EditorWorkloadPage.mjs',
    'tests/e2e/page-objects/LayoutReadDiagnosticPage.mjs'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.pilot = true;
report.limitations.push('Native stack sampling and JavaScript creation/layout wrappers perturb execution. Timings locate work only; no performance acceptance.');
report.files = []; report.openings = [];
let sampling;
try {
  for (const [index, lines] of protocol.fileLines.entries()) {
    const filePath = path.join(run.workspace, `editor-profile-${index}.ts`);
    await writeFile(filePath, `// EDITOR_PROFILE_${index}\n`
      + Array.from({ length: lines }, (_, line) => `export const record${line} = { name: 'entry-${line}', value: ${line} };`).join('\n')
      + `\n// END_EDITOR_PROFILE_${index}\n`);
    report.files.push({ filePath, lines: lines + 3 });
  }
  for (const file of report.files) await page.openFile(file.filePath);
  await page.startSemanticProbe(report.files.at(-1).filePath);
  await page.until(async () => (await page.semanticState()).done, 'working language service before creation diagnosis');
  report.language = await page.semanticState(); assert.equal(report.language.stage, 'complete');
  assert.deepEqual(report.language.codes, []);
  await delay(protocol.settleMs);
  await page.startEditorCreationProbe(); await page.startLayoutReads();
  const main = report.webviews.find(view => view.handle === 'main'); assert.ok(main);
  const output = path.join(run.root, 'main-webcontent-sample.txt');
  sampling = promisify(execFile)('sample', [String(main.pid), String(protocol.stackDurationSeconds),
    String(protocol.stackIntervalMs), '-file', output], { windowsHide: true, maxBuffer: 1024 * 1024 })
    .then(result => ({ output, stdout: result.stdout, stderr: result.stderr }), error => ({ output, error: String(error) }));
  for (let cycle = 0; cycle < protocol.cycles; cycle++) {
    for (const file of report.files) {
      report.openings.push({ cycle, filePath: file.filePath, ...await page.openFile(file.filePath) });
      assert.equal((await page.editorSnapshot(file.filePath)).lines, file.lines);
    }
    await run.save();
  }
  report.stackSample = await sampling; assert.ok(!report.stackSample.error, report.stackSample.error);
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  await writeFile(path.join(run.root, 'failure.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64')).catch(() => undefined);
} finally {
  if (sampling) report.stackSample = await sampling;
  report.creation = await page.stopEditorCreationProbe().catch(error => ({ error: String(error) }));
  report.layout = await page.stopLayoutReads().catch(error => ({ error: String(error) }));
  await run.close();
}
