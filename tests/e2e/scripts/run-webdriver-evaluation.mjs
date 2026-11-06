/** Native functional coverage only; use the separate diagnostic for cost. */
import { openNativeWorkload } from './native-workload-session.mjs';
import { WebDriverEvaluationPage } from '../page-objects/WebDriverEvaluationPage.mjs';

const protocol = { name: 'native-webdriver-evaluation-semantics', version: 1, prewarmMs: 15000, diagnosticOnly: true };
const run = await openNativeWorkload({ Page: WebDriverEvaluationPage, protocol, label: 'evaluation-semantics',
  evidence: process.env.OPENBITFUN_EVALUATION_FUNCTIONAL_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-webdriver-evaluation.mjs',
    'tests/e2e/page-objects/WebDriverEvaluationPage.mjs', 'tests/e2e/page-objects/WebDriverFramePage.mjs'] });
run.report.coverage.pilot = true;
run.report.coverage.instrumented = true;
try {
  run.report.evaluationChecks = await run.page.exerciseEvaluation();
  run.report.frameChecks = await run.page.exerciseFrames();
  run.report.functionalPassed = true;
  run.report.passed = true;
  console.log('Native evaluation semantics and same-origin frames passed');
} catch (error) {
  run.report.failure = error.stack || String(error);
  console.error(run.report.failure); process.exitCode = 1;
} finally {
  await run.page.switchFrame(null).catch(() => undefined);
  await run.close();
}
