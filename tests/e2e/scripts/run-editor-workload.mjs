/** Large real files, native input, retained drafts and external disk updates. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { EditorLanguagePage } from '../page-objects/EditorLanguagePage.mjs';
import { EditorRetentionPage } from '../page-objects/EditorRetentionPage.mjs';
import { latencyDistribution, probeFrameDistributions } from '../helpers/flowchat-frame-metrics.ts';

const retentionDiagnostic = process.env.OPENBITFUN_EDITOR_RETENTION_DIAGNOSTIC === '1';
const emptyWorkerDiagnostic = process.env.OPENBITFUN_EDITOR_EMPTY_WORKER_DIAGNOSTIC === '1';
const emptyProgramDiagnostic = process.env.OPENBITFUN_EDITOR_EMPTY_PROGRAM_DIAGNOSTIC === '1';
assert.ok(!(emptyWorkerDiagnostic && emptyProgramDiagnostic), 'Run Worker reset and program synchronization separately');
assert.ok(!(emptyWorkerDiagnostic || emptyProgramDiagnostic) || retentionDiagnostic, 'Empty-language diagnosis requires the retention probe');
const protocol = { name: 'native-editor-heavy-workload', version: 4, prewarmMs: 15_000, settleMs: 5000, sampleMs: 2000,
  fileLines: [30000, 30000, 8000, 8000, 8000, 8000], hotCycles: 6,
  idleMs: Number(process.env.OPENBITFUN_EDITOR_IDLE_MS || 30_000), hiddenMs: 45_000,
  draftChunks: 24, typingIntervalMs: 80, scrollSteps: 24, scrollDeltaY: -1400,
  budgets: { feedbackP95Ms: 100, hotContentP95Ms: 150, inputRafP95Ms: 100, frameP95Ms: 34, frameMaxMs: 100 },
  ...(retentionDiagnostic ? { retentionDiagnostic: true, diagnosticOnly: true, extendedClosedMs: 30000 } : {}),
  ...(emptyWorkerDiagnostic ? { emptyWorkerDiagnostic: true } : {}),
  ...(emptyProgramDiagnostic ? { emptyProgramDiagnostic: true } : {}) };
const run = await openNativeWorkload({ Page: retentionDiagnostic ? EditorRetentionPage : EditorLanguagePage, protocol,
  label: process.env.OPENBITFUN_EDITOR_LABEL || 'baseline', evidence: process.env.OPENBITFUN_EDITOR_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-editor-workload.mjs', 'tests/e2e/page-objects/EditorWorkloadPage.mjs',
    'tests/e2e/page-objects/EditorLanguagePage.mjs',
    'tests/e2e/helpers/flowchat-frame-metrics.ts',
    ...(retentionDiagnostic ? ['tests/e2e/page-objects/EditorRetentionPage.mjs'] : [])] });
const { page, report } = run;
report.coverage.largeCodeFiles = true;
report.coverage.languageServiceReadiness = true;
report.coverage.interactiveFileTree = true; report.coverage.hotSceneTabs = true;
report.coverage.markdown = false; report.coverage.diff = false;
report.coverage.pilot = protocol.idleMs !== 30_000;
if (retentionDiagnostic) {
  report.coverage.instrumented = true; report.coverage.pilot = true; report.retention = [];
  report.limitations.push('Weak-reference/model/Worker lifecycle probes perturb execution. Object survival is not a retained heap size or a leak proof; observation windows do not force GC or clear caches. Any explicit intervention is recorded separately.');
}
if (emptyWorkerDiagnostic) report.limitations.push('After two unmodified closed windows, the TypeScript worker is reset through an unchanged compiler-options notification. This deliberate cache-lifecycle intervention is causal diagnosis, not a product optimization or acceptance result. Reopen checks model content and the real semantic service, not all language features.');
if (emptyProgramDiagnostic) report.limitations.push('After two unmodified closed windows, a compiler-options diagnostic request synchronizes the existing TypeScript program with its empty mirror inventory. This is a separate causal diagnostic, not a product change or performance acceptance.');
report.limitations.push('Monaco input-to-RAF is not keyboard-to-pixel latency.',
  'The exposed editor instance is used only for readback; all edits use native driver input.',
  'Shortcuts dispatch DOM KeyboardEvents with legacy keyCode through native eval because the embedded key source omits it; these are not trusted OS keystrokes.',
  'This stage covers code documents, not rich Markdown or Diff computation.');
report.files = []; report.openings = []; report.interactions = [];
const home = '[data-testid="nav-personal-overview"]';
const meta = '\uE03D';
const retain = async name => {
  if (retentionDiagnostic) report.retention.push({ name, state: await page.retentionSnapshot() });
};
const probe = async (name, filePath, action) => {
  await page.startEditorProbe(filePath);
  try { return await action(); }
  finally {
    const raw = await page.stopEditorProbe();
    assert.ok(raw.frames.length > 1, `Missing frames: ${name}`);
    report.interactions.push({ name, raw,
      frames: probeFrameDistributions({ frames: raw.frames.map(time => ({ time })), wheelTimes: raw.wheelTimes }),
      inputRaf: raw.inputRafMs.length ? latencyDistribution(raw.inputRafMs) : null });
    await run.save();
  }
};
try {
  if (retentionDiagnostic) await page.startRetentionProbe();
  const contents = protocol.fileLines.map((lines, file) => `// EDITOR_WORKLOAD_${file}\n`
    + Array.from({ length: lines }, (_, index) => `export const record${index} = { name: 'entry-${index}', value: ${index} };`).join('\n')
    + `\n// END_EDITOR_WORKLOAD_${file}\n`);
  for (let file = 0; file < contents.length; file++) {
    const filePath = path.join(run.workspace, `editor-heavy-${file}.ts`);
    await writeFile(filePath, contents[file]);
    report.files.push({ filePath, bytes: Buffer.byteLength(contents[file]), lines: protocol.fileLines[file] + 3 });
  }
  await page.click(home);
  await run.idleWindow('before-editors', protocol.idleMs);
  await retain('before-editors');
  await run.measureAction('open-six-code-documents', async () => {
    for (const file of report.files) {
      report.openings.push({ filePath: file.filePath, kind: 'first-ui-entry', ...await page.openFile(file.filePath) });
      const state = await page.editorSnapshot(file.filePath);
      assert.equal(state.lines, file.lines); assert.equal(state.readonly, 'false');
      report.checks.push({ name: 'file-loaded', filePath: file.filePath, state });
    }
  });
  await retain('six-documents-open');
  const first = report.files[0].filePath;
  await page.openFile(first);
  // A rendered Monaco view does not prove its language Worker initialized.
  // Keep this real semantic-service guard outside the timed opening/input phases.
  await page.startSemanticProbe(first);
  try { await page.until(async () => (await page.semanticState()).done, 'large-file language service readiness'); }
  finally { report.languageReadiness = await page.semanticState(); await run.save(); }
  assert.equal(report.languageReadiness.stage, 'complete', JSON.stringify(report.languageReadiness));
  assert.deepEqual(report.languageReadiness.codes, []);
  assert.ok(!report.languageReadiness.errors.some(error => /Could not create web worker|Can't find variable: define/.test(error.message)),
    'Heavy workload requires a working language Worker');
  await page.click(`${page.root(first)} .view-lines`);
  await page.keyChord([meta, '\uE015']);
  await page.until(async () => (await page.editorSnapshot(first)).position?.lineNumber === report.files[0].lines, 'end of large file');
  const chunks = Array.from({ length: protocol.draftChunks }, (_, index) => `// EDIT_${index} `);
  const expected = contents[0] + chunks.join('');
  await run.measureAction('typing-large-document', () => probe('typing-large-document', first,
    () => page.typeChunks(first, chunks, protocol.typingIntervalMs)));
  const typed = await page.editorSnapshot(first);
  assert.equal(typed.characters, expected.length); assert.equal(typed.last, chunks.join(''));
  await page.keyChord([meta, 'z']);
  await page.until(async () => (await page.editorSnapshot(first)).characters < typed.characters, 'undo real input');
  await page.keyChord([meta, '\uE008', 'z']);
  await page.until(async () => (await page.editorSnapshot(first)).last === typed.last, 'redo real input');
  await run.measureAction('scroll-large-document', () => probe('scroll-large-document', first,
    () => page.scrollEditor(first, protocol.scrollDeltaY, protocol.scrollSteps)));
  await run.measureAction('switch-retained-code-documents', async () => {
    // Start on the other document: all twelve samples must change selection,
    // including the first switch that may reconstruct a suspended view.
    for (let cycle = 0; cycle < protocol.hotCycles; cycle++) for (const file of report.files.slice(0, 2).reverse()) {
      report.openings.push({ filePath: file.filePath, kind: 'hot', cycle, ...await page.openFile(file.filePath) });
    }
  });
  await page.openFile(first);
  const retained = await page.editorSnapshot(first);
  await run.idleWindow('editor-active', protocol.idleMs);
  await retain('editor-active');
  await page.click(home);
  await run.idleWindow('editors-inactive', protocol.hiddenMs);
  await retain('editors-inactive');
  report.openings.push({ filePath: first, kind: 'after-view-residency', ...await page.openFile(first) });
  const restored = await page.editorSnapshot(first);
  assert.equal(restored.last, typed.last); assert.equal(restored.characters, typed.characters);
  assert.deepEqual(restored.position, retained.position);
  assert.ok(Math.abs(restored.scrollTop - retained.scrollTop) <= 1, 'Restore the editor reading offset');
  report.checks.push({ name: 'draft-position-after-view-residency', before: retained, after: restored });
  await page.click(`${page.root(first)} .view-lines`);
  await page.keyChord([meta, 's']);
  await page.until(async () => (await readFile(first, 'utf8')) === expected, 'save complete retained document');
  const changedOnDisk = expected + '\n// EXTERNAL_DISK_UPDATE\n';
  await writeFile(first, changedOnDisk);
  await page.until(async () => (await page.editorSnapshot(first)).penultimate === '// EXTERNAL_DISK_UPDATE', 'external file update');
  report.checks.push({ name: 'external-disk-update', state: await page.editorSnapshot(first) });
  await page.click(`${page.root(first)} .view-lines`);
  await page.until(() => page.execute(filePath => document.activeElement?.closest('.code-editor-tool')?.dataset.filePath === filePath, first),
    'editor focus after disk reload');
  await probe('find-in-large-document', first, async () => {
    await page.keyChord([meta, 'f']);
    const find = `${page.root(first)} .find-widget .monaco-findInput :is(input, textarea)`;
    await page.until(() => page.visible(find), 'editor find widget');
    await page.enterText(find, 'record29999');
    await page.until(async () => (await page.editorSnapshot(first)).currentLine.includes('record29999'), 'real find match');
    await delay(100);
    await page.keyChord(['\uE00C']);
  });
  await run.idleWindow('editor-restored', protocol.idleMs);
  await retain('editor-restored');
  report.closedTabs = await page.closeClosableTabs();
  await page.click(home);
  await run.idleWindow('after-editors-close', protocol.idleMs);
  await retain('after-editors-close');
  if (retentionDiagnostic) {
    await run.idleWindow('after-editors-close-extended', protocol.extendedClosedMs);
    await retain('after-editors-close-extended');
    assert.equal(report.retention.at(-1).state.currentModels.length, 0, 'Explicit closure must release all fixture models');
  }
  if (emptyWorkerDiagnostic) {
    report.workerReset = await page.resetEmptyTypeScriptWorker();
    assert.equal(report.workerReset.before, report.workerReset.after, 'Compiler options must remain identical');
    await retain('empty-typescript-worker-reset');
    await run.idleWindow('after-empty-worker-reset', protocol.idleMs);
    await retain('after-empty-worker-reset');
  }
  if (emptyProgramDiagnostic) {
    report.programRefresh = await page.refreshEmptyTypeScriptProgram();
    assert.deepEqual(report.programRefresh.filesAfter, []);
    assert.deepEqual(report.programRefresh.codes, []);
    assert.deepEqual(report.programRefresh.workersAfter, report.programRefresh.workersBefore,
      'Program synchronization must preserve the existing Worker identity and lifecycle');
    await retain('empty-typescript-program-refresh');
    await run.idleWindow('after-empty-program-refresh', protocol.idleMs);
    await retain('after-empty-program-refresh');
  }
  if (emptyWorkerDiagnostic || emptyProgramDiagnostic) {
    report.reopenedAfterWorkerReset = await page.openFile(first);
    assert.equal((await page.editorSnapshot(first)).characters, changedOnDisk.length);
    report.semanticAfterWorkerReset = await page.semanticDiagnostics(first);
    assert.deepEqual(report.semanticAfterWorkerReset.codes, [], 'Semantic service must restart and process the real reopened file');
    await retain('reopened-after-worker-reset');
    await page.closeClosableTabs();
    await page.click(home);
  }
  const hot = report.openings.filter(row => row.kind === 'hot');
  report.navigation = { feedback: latencyDistribution(hot.map(row => row.milestones.visibleMs)),
    content: latencyDistribution(hot.map(row => row.milestones.contentMs)) };
  report.performanceGates = report.interactions.map(row => ({ name: row.name,
    frameP95Passed: row.frames.phase.p95Ms < protocol.budgets.frameP95Ms,
    frameMaxPassed: row.frames.phase.maxMs < protocol.budgets.frameMaxMs,
    inputPassed: row.inputRaf ? row.inputRaf.p95Ms <= protocol.budgets.inputRafP95Ms : null }));
  assert.ok(report.interactions.find(row => row.name === 'typing-large-document')?.inputRaf?.samples >= protocol.draftChunks,
    'Capture actual input events for every typed chunk');
  report.functionalPassed = true;
  report.navigationGates = { feedbackPassed: report.navigation.feedback.p95Ms <= protocol.budgets.feedbackP95Ms,
    contentPassed: report.navigation.content.p95Ms <= protocol.budgets.hotContentP95Ms };
  report.performanceBudgetsPassed = report.performanceGates.every(row => row.frameP95Passed && row.frameMaxPassed && row.inputPassed !== false)
    && Object.values(report.navigationGates).every(Boolean);
  report.passed = report.functionalPassed && report.performanceBudgetsPassed;
  console.log(JSON.stringify({ functionalPassed: report.functionalPassed, performanceBudgetsPassed: report.performanceBudgetsPassed }));
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  report.failureEditors = await Promise.all(report.files.map(async file => ({ filePath: file.filePath,
    state: await page.editorSnapshot(file.filePath).catch(() => null) })));
  report.failureFocus = await page.execute(() => ({ tag: document.activeElement?.tagName,
    className: document.activeElement?.className, role: document.activeElement?.getAttribute('role'),
    file: document.activeElement?.closest('.code-editor-tool')?.dataset.filePath,
    find: [...document.querySelectorAll('.find-widget')].map(node => ({ visible: node.checkVisibility({ checkVisibilityCSS: true }),
      file: node.closest('.code-editor-tool')?.dataset.filePath })) })).catch(() => null);
  await writeFile(path.join(run.root, 'failure.png'), Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64')).catch(() => undefined);
} finally {
  if (retentionDiagnostic) report.retentionFinal = await page.stopRetentionProbe().catch(error => ({ error: String(error) }));
  await page.stopEditorProbe().catch(() => undefined);
  await run.close();
}
