import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openNativeWorkload } from './native-workload-session.mjs';
import { EditorLanguagePage } from '../page-objects/EditorLanguagePage.mjs';

const protocol = { name: 'native-editor-language-diagnostic', version: 6, diagnosticOnly: true,
  prewarmMs: 15000, timeoutMs: 10000, resetEmptyWorker: process.env.OPENBITFUN_EDITOR_LANGUAGE_RESET === '1',
  allLanguages: process.env.OPENBITFUN_EDITOR_LANGUAGE_ALL === '1' };
const run = await openNativeWorkload({ Page: EditorLanguagePage, protocol, label: 'editor-language',
  evidence: process.env.OPENBITFUN_EDITOR_LANGUAGE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-editor-language-diagnostic.mjs', 'tests/e2e/page-objects/EditorLanguagePage.mjs',
    'tests/e2e/page-objects/EditorWorkloadPage.mjs'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.pilot = true; report.language = [];
report.limitations.push('Small-file semantic API and native marker diagnostic only. No Worker constructor/method wrapper, forced GC or performance acceptance.');
try {
  const file = path.join(run.workspace, 'language-check.ts');
  await writeFile(file, 'export const answer: number = "wrong";\n');
  const additional = protocol.allLanguages ? [
    { filePath: path.join(run.workspace, 'language-check.js'), content: 'export const answer = ;\n', language: 'javascript' },
    { filePath: path.join(run.workspace, 'language-check.json'), content: '{ "answer": }\n', language: 'json' },
    { filePath: path.join(run.workspace, 'language-check.css'), content: '.test { unknown-property: value; }\n', language: 'css' },
    { filePath: path.join(run.workspace, 'language-check.html'), content: '<di', language: 'html' },
  ] : [];
  for (const entry of additional) await writeFile(entry.filePath, entry.content);
  const openAndCheck = async name => {
    const opening = await page.openFile(file);
    await page.startSemanticProbe(file);
    try { await page.until(async () => (await page.semanticState()).done, 'semantic service response', protocol.timeoutMs); }
    finally { report.language.push({ name, opening, state: await page.semanticState() }); await run.save(); }
    const state = report.language.at(-1).state;
    assert.equal(state.stage, 'complete', JSON.stringify(state));
    assert.deepEqual(state.codes, [2322]);
    assert.ok(!state.errors.some(error => /Could not create web worker|Can't find variable: define/.test(error.message)), 'Language workers must not fall back after bootstrap errors');
    await page.until(async () => (await page.semanticState()).markers.some(marker => String(marker.code) === '2322'), 'native semantic error marker');
    await page.until(async () => (await page.fileLanguageState(file)).squiggles > 0, 'rendered TypeScript error decoration');
    await page.closeClosableTabs();
    await page.click('[data-testid="nav-personal-overview"]');
    await page.until(() => page.execute(() => window.monaco.editor.getModels().length === 0), 'all models closed');
  };
  await openAndCheck('original-worker');
  if (protocol.resetEmptyWorker) {
    report.reset = await page.execute(() => {
      if (window.monaco.editor.getModels().length) throw new Error('Expected no models before reset');
      const defaults = window.monaco.languages.typescript.typescriptDefaults;
      const before = JSON.stringify(defaults.getCompilerOptions());
      defaults.setCompilerOptions(defaults.getCompilerOptions());
      return { before, after: JSON.stringify(defaults.getCompilerOptions()) };
    });
    assert.equal(report.reset.before, report.reset.after);
    await openAndCheck('reset-worker');
  }
  report.additionalLanguages = [];
  for (const entry of additional) {
    const opening = entry.language === 'html' ? await page.openHtmlAsCode(entry.filePath) : await page.openFile(entry.filePath);
    let completion;
    if (entry.language === 'html') {
      await page.click(`${page.root(entry.filePath)} .view-lines`);
      await page.keyChord(['\uE03D', '\uE015']);
      await page.keyChord(['\uE009', ' ']);
      await page.until(async () => (await page.fileLanguageState(entry.filePath)).suggestions.some(text => /\bdiv\b/.test(text)),
        'HTML tag suggestions through native editor input', protocol.timeoutMs);
      completion = await page.fileLanguageState(entry.filePath);
      await page.keyChord(['\uE00C']);
    } else {
      await page.until(async () => (await page.fileLanguageState(entry.filePath)).squiggles > 0,
        `${entry.language} native validation decoration`, protocol.timeoutMs);
    }
    const state = await page.fileLanguageState(entry.filePath);
    assert.equal(state.language, entry.language);
    report.additionalLanguages.push({ language: entry.language, opening, state, completion });
    await run.save();
  }
  const finalState = await page.semanticState();
  assert.ok(!finalState.errors.some(error => /Could not create web worker|Can't find variable: define/.test(error.message)), 'All tested language workers must bootstrap');
  if (additional.length) await page.closeClosableTabs();
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  report.failureLanguage = await page.semanticState().catch(error => ({ error: String(error) }));
  report.failureHtmlOpening = page.htmlOpeningDiagnostic;
  report.failureUi = await page.execute(() => ({ active: document.activeElement?.outerHTML.slice(0, 2000),
    menus: [...document.querySelectorAll('[role="menu"], [data-menu-id]')].map(node => node.outerHTML.slice(0, 4000)) })).catch(error => ({ error: String(error) }));
  const screenshot = await page.request(`/session/${page.session}/screenshot`).catch(() => null);
  if (screenshot) await writeFile(path.join(run.root, 'failure.png'), Buffer.from(screenshot, 'base64'));
} finally { await run.close(); }
