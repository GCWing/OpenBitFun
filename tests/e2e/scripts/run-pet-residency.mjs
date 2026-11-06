/** Attributed companion residency; diagnostic observations are not an optimization A/B. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openNativeWorkload } from './native-workload-session.mjs';
import { PetResidencyPage } from '../page-objects/PetResidencyPage.mjs';

const exec = promisify(execFile);
const protocol = { name: 'native-pet-residency-diagnostic', version: 5,
  prewarmMs: 15000, settleMs: 5000, sampleMs: 2000,
  windowMs: Number(process.env.OPENBITFUN_PET_RESIDENCY_WINDOW_MS || 60000),
  windowsPerPhase: Number(process.env.OPENBITFUN_PET_RESIDENCY_WINDOWS || 5),
  phases: ['visible', 'hidden', 'restored'], mainVisibility: 'visible-static-todos',
  instrumented: true, nativeAllocationOutsideWindows: true, forcedGC: false };
assert.ok(Number.isFinite(protocol.windowMs) && protocol.windowMs >= 1000);
assert.ok(Number.isInteger(protocol.windowsPerPhase) && protocol.windowsPerPhase > 0);
const run = await openNativeWorkload({ Page: PetResidencyPage, protocol,
  label: 'pet-residency-diagnostic', evidence: process.env.OPENBITFUN_PET_RESIDENCY_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-pet-residency.mjs', 'tests/e2e/page-objects/PetResidencyPage.mjs',
    'tests/e2e/page-objects/PetPerformancePage.mjs'] });
const { page, report } = run;
Object.assign(report.coverage, { instrumented: true, pilot: true, companionResidency: true,
  customPetSwitching: false, streamedBubbles: false, optimizationComparison: false });
report.limitations.push('Callback counters wrap Tauri callback-map set/delete/get and perturb execution. They retain no callback values. Native heap/vmmap are allocation categories, not JS retained-object paths. This is causal residency diagnosis, not performance acceptance.',
  'Only the selected built-in resting pet is exercised; no custom-asset cache or streamed-bubble acceptance.',
  'Callback inventory belongs to this WebView only, not every application listener or retained object.',
  'Physical pointer movement is not suppressed. Authored v2 look frames are recorded separately from walking cadence; interrupted cadence cannot prove all walking frames.');
report.diagnostics = []; report.cadences = [];
let petIdentity;
async function allocation(name) {
  for (const [kind, command, args] of [
    ['vmmap', 'vmmap', ['-summary', String(petIdentity.pid)]],
    ['heap', 'heap', ['--sortBySize', '--showSizes', '--guessNonObjects', '--noContent', String(petIdentity.pid)]],
  ]) {
    const filename = `${name}-${petIdentity.pid}-${kind}.txt`;
    try {
      const { stdout, stderr } = await exec(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 ** 2 });
      await writeFile(path.join(run.root, filename), stdout + stderr);
      report.diagnostics.push({ name, kind, filename, available: true });
    } catch (error) { report.diagnostics.push({ name, kind, available: false, error: String(error) }); }
  }
  await run.save();
}
try {
  await page.select('main');
  await page.invoke('plugin:window|show', { label: 'main' });
  await page.click('[data-testid="nav-todos-btn"]');
  await page.until(() => page.visible('[data-testid="scene-viewport-scene"][data-scene-id="todos"][data-scene-active="true"]'), 'static main scene');
  await page.preparePet();
  await run.identify();
  petIdentity = report.webviews.find(view => view.handle === 'agent-companion-pet');
  assert.ok(petIdentity, 'Companion WebContent requires attributed identity');
  await page.select('agent-companion-pet');
  await page.invoke('plugin:window|show', { label: 'main' });
  await page.activity('rest');
  await page.startCallbackProbe();
  const initial = await page.residencySnapshot();
  assert.ok(initial.sprite); assert.equal(initial.bubbles, 0);
  report.initial = initial;
  await allocation('initial');
  for (const phase of protocol.phases) {
    await page.invoke(`plugin:window|${phase === 'hidden' ? 'hide' : 'show'}`, { label: 'agent-companion-pet' });
    await page.invoke('plugin:window|show', { label: 'main' });
    await page.until(async () => (await page.residencySnapshot()).visibility === (phase === 'hidden' ? 'hidden' : 'visible'), `pet ${phase}`);
    if (phase !== 'hidden') {
      const cadence = await page.cadence();
      const walking = cadence.frames.filter(frame => frame.name === 'openbitfun-petdex-walk');
      const look = cadence.frames.filter(frame => frame.name === 'none' && [9, 10].includes(frame.row));
      assert.equal(walking.length + look.length, cadence.frames.length, 'Visible frames must belong to the authored animation or v2 look rows');
      const positions = [...new Set(walking.map(frame => frame.x))];
      const pointerConfounded = look.length > 0;
      if (!pointerConfounded) assert.ok(positions.length >= 5, 'Uninterrupted visible sprite must retain its authored cadence');
      report.cadences.push({ phase, ...cadence, walkingPositions: positions, lookFrames: look.length,
        pointerConfounded, walkingCadenceVerified: positions.length >= 5 });
    }
    for (let index = 0; index < protocol.windowsPerPhase; index++) {
      assert.equal(await page.invoke('plugin:window|is_visible', { label: 'main' }), true);
      const window = await run.idleWindow(`${phase}-${index + 1}`, protocol.windowMs);
      window.mainVisibleAfter = await page.invoke('plugin:window|is_visible', { label: 'main' });
      await run.save();
      assert.equal(window.mainVisibleAfter, true);
      assert.equal(window.after.visibility, phase === 'hidden' ? 'hidden' : 'visible');
      for (const key of ['width', 'height', 'backgroundImage']) {
        assert.equal(window.after.sprite[key], initial.sprite[key], `Pet presentation changed: ${key}`);
      }
      const sprite = window.after.sprite;
      assert.ok(sprite.animationName === 'openbitfun-petdex-walk'
        || sprite.animationName === 'none' && [9, 10].includes(sprite.row) && sprite.lookPositionX !== '',
      'Only authored walking animation or positioned v2 look frames are valid');
      assert.ok(sprite.playState.split(',').every(state => state.trim() === (phase === 'hidden' ? 'paused' : 'running')));
      assert.equal(window.after.bubbles, 0);
      assert.ok(window.summary.processes.some(process => process.pid === petIdentity.pid
        && process.startTicks === petIdentity.startTicks && process.completeWindow), 'Pet identity changed within observation');
    }
    await allocation(phase);
  }
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); process.exitCode = 1;
} finally {
  await page.stopCallbackProbe().catch(() => {});
  await run.close();
}
console.log(JSON.stringify({ functionalPassed: report.functionalPassed, diagnosticOnly: true }));
