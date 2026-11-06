/** Native compact/expanded geometry equivalence, separate from timing benchmarks. */
import assert from 'node:assert/strict';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { ComposerLayoutPage } from '../page-objects/ComposerLayoutPage.mjs';

const protocol = { name: 'native-composer-layout', version: 2, prewarmMs: 15000,
  widths: [1280, 1000], settleMs: 500,
  drafts: ['', 'short draft', ...[24, 48, 72, 96, 160, 320].map(length => 'word '.repeat(64).slice(0, length)),
    'first line\nsecond line', '中文输入布局验证'.repeat(10), 'short again', ''] };
const run = await openNativeWorkload({ Page: ComposerLayoutPage, protocol, label: 'composer-layout',
  evidence: process.env.OPENBITFUN_COMPOSER_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-composer-layout.mjs', 'tests/e2e/page-objects/ComposerLayoutPage.mjs'] });
const { page, report } = run;
report.coverage.instrumented = true; report.coverage.pilot = true;
report.limitations.push('Legacy off-screen clone reads are a geometry oracle, not a latency benchmark. Chinese text insertion is not OS IME coverage.');
report.cases = [];
let original;
try {
  await page.click('[data-testid="nav-session-item"][data-session-id="workload-history-000"]');
  await page.until(() => page.visible('[data-testid="chat-input-textarea"]'), 'composer');
  original = await page.request(`/session/${page.session}/window/rect`);
  const scale = await page.execute(() => devicePixelRatio);
  for (const width of protocol.widths) {
    // The embedded native rect endpoint uses physical pixels on macOS.
    await page.request(`/session/${page.session}/window/rect`, { ...original, width: width * scale });
    await delay(1000);
    for (const draft of protocol.drafts) {
      await page.replaceDraft(draft);
      await delay(protocol.settleMs);
      const state = await page.readComposerGeometry();
      report.cases.push({ width, expectedDraft: draft, ...state });
      await run.save();
      assert.equal(state.draft, draft, 'Real editor input must be preserved');
      assert.equal(state.viewport.width, width, 'Exercise the requested logical viewport width');
      assert.ok(state.container.width > 0 && state.inputArea.width > 0);
      if (state.layout === 'compact') assert.ok(Math.abs(state.liveWidth - state.referenceWidth) <= 1,
        `Live compact width differs from the legacy probe: ${JSON.stringify(state)}`);
    }
    const cases = report.cases.filter(row => row.width === width);
    assert.ok(cases.some(row => row.layout === 'expanded'), 'Long input must expand');
    assert.equal(cases.at(-1).layout, 'compact', 'Clearing must collapse');
  }
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  if (original) await page.request(`/session/${page.session}/window/rect`, original).catch(() => {});
  await run.close();
}
