/** Functional regression only; no speed or resource acceptance windows. */
import { openNativeWorkload } from './native-workload-session.mjs';
import { WebDriverFramePage } from '../page-objects/WebDriverFramePage.mjs';

const protocol = { name: 'native-webdriver-same-origin-frames', version: 1, prewarmMs: 15000, diagnosticOnly: true };
const run = await openNativeWorkload({ Page: WebDriverFramePage, protocol,
  label: process.env.OPENBITFUN_FRAME_LABEL || 'frames', evidence: process.env.OPENBITFUN_FRAME_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-webdriver-frames.mjs', 'tests/e2e/page-objects/WebDriverFramePage.mjs'] });
run.report.coverage.pilot = true; run.report.coverage.instrumented = true;
run.report.limitations.push('Static same-origin DOM fixtures exercise native protocol execution, not MiniApp SDK behavior, cross-origin frames or performance.');
try {
  run.report.frameChecks = await run.page.exerciseFrames();
  run.report.functionalPassed = true; run.report.passed = true;
  console.log('Same-origin nested frame commands passed');
} catch (error) {
  run.report.failure = error.stack || String(error); console.error(run.report.failure); process.exitCode = 1;
} finally {
  await run.page.switchFrame(null).catch(() => undefined);
  await run.close();
}
