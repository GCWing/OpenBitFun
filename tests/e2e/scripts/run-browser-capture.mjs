/** Native PNG and unchanged JPEG preview fidelity; never a timing benchmark. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { openNativeWorkload, delay } from './native-workload-session.mjs';
import { BrowserCapturePage } from '../page-objects/BrowserCapturePage.mjs';
import { createBrowserCaptureFixture } from '../helpers/browser-capture-fixture.mjs';
import { captureHomeVisuals } from './workbench-performance-visuals.mjs';

const protocol = { name: 'native-browser-capture-fidelity', version: 2, prewarmMs: 15000,
  widths: [1280, 1000], scrolls: [0, 120], settleMs: 1000 };
const run = await openNativeWorkload({ Page: BrowserCapturePage, protocol, label: 'capture-fidelity',
  evidence: process.env.OPENBITFUN_CAPTURE_EVIDENCE,
  harnessFiles: ['tests/e2e/scripts/run-browser-capture.mjs', 'tests/e2e/page-objects/BrowserCapturePage.mjs',
    'tests/e2e/page-objects/BrowserWorkloadPage.mjs', 'tests/e2e/helpers/browser-capture-fixture.mjs',
    'tests/e2e/helpers/browser-workload-fixture.mjs', 'tests/e2e/scripts/workbench-performance-visuals.mjs'] });
const { page, report } = run;
report.coverage.realAgent = true; report.coverage.realNativeBrowser = true;
report.coverage.pilot = true; report.coverage.instrumented = true;
report.limitations.push('Static native PNG/JPEG pixel equivalence is capture fidelity, not performance or every compositor frame.');
report.captures = [];
let fixture, original;
try {
  await page.click('[data-testid="nav-personal-overview"]');
  const home = await captureHomeVisuals(page, run.root);
  report.home = home;
  report.captures.push(...home.map(row => ({ name: `home-${row.name}`, file: row.file, placement: row.placement })));
  fixture = await createBrowserCaptureFixture();
  const browser = await page.openCaptureFixture(fixture, run.workspace);
  original = await page.windowSize();
  const scale = await page.execute(() => devicePixelRatio);
  for (const width of protocol.widths) {
    await page.setWindowSize({ ...original, width: width * scale });
    await delay(protocol.settleMs);
    assert.equal(await page.execute(() => innerWidth), width);
    for (const scroll of protocol.scrolls) {
      const placement = await page.prepareCapture(browser.handle, scroll);
      assert.equal(placement.visibility, 'visible');
      assert.equal(placement.scrollY, scroll);
      assert.equal(placement.title, 'Native capture fixture');
      const png = Buffer.from(await page.capturePng(browser.handle), 'base64');
      await writeFile(path.join(run.root, `browser-${width}-${scroll}-png.png`), png);
      const pngMetadata = await sharp(png).metadata();
      assert.equal(pngMetadata.format, 'png');
      assert.equal(pngMetadata.width, Math.round(placement.width * placement.devicePixelRatio));
      assert.equal(pngMetadata.height, Math.round(placement.height * placement.devicePixelRatio));
      const preview = await page.capturePreview(browser.handle);
      assert.equal(preview.status, 'ready');
      assert.ok(preview.dataUrl.startsWith('data:image/jpeg;base64,'));
      const jpeg = Buffer.from(preview.dataUrl.split(',')[1], 'base64');
      const jpegMetadata = await sharp(jpeg).metadata();
      assert.equal(jpegMetadata.format, 'jpeg');
      assert.ok(jpegMetadata.width > 0 && jpegMetadata.height > 0);
      assert.ok(Math.max(jpegMetadata.width, jpegMetadata.height) <= 1600);
      for (const [extension, data] of [['png', png], ['jpg', jpeg]]) {
        const name = `browser-${width}-${scroll}-${extension}`, file = path.join(run.root, `${name}.${extension}`);
        await writeFile(file, data);
        report.captures.push({ name, file, placement });
      }
      await run.save();
    }
  }
  await page.tool('close', { target: 'builtin', session_id: browser.handle });
  assert.deepEqual(fixture.errors, []);
  if (process.env.OPENBITFUN_CAPTURE_REFERENCE) {
    const before = JSON.parse(await readFile(process.env.OPENBITFUN_CAPTURE_REFERENCE, 'utf8'));
    assert.equal(before.functionalPassed, true);
    assert.equal(before.protocolHash, report.protocolHash);
    assert.equal(before.harnessHash, report.harnessHash);
    assert.equal(before.frontend.revision, report.frontend.revision);
    assert.deepEqual(before.environment, report.environment);
    assert.equal(before.captures.length, report.captures.length);
    report.comparison = [];
    for (const capture of report.captures) {
      const previous = before.captures.find(row => row.name === capture.name);
      assert.ok(previous);
      assert.deepEqual(capture.placement, previous.placement);
      const [left, right] = await Promise.all([previous, capture].map(row =>
        sharp(row.file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
      assert.deepEqual(right.info, left.info);
      let changedChannels = 0, maximumDifference = 0;
      for (let index = 0; index < left.data.length; index++) {
        const difference = Math.abs(right.data[index] - left.data[index]);
        if (difference) changedChannels++;
        maximumDifference = Math.max(maximumDifference, difference);
      }
      report.comparison.push({ name: capture.name, changedChannels, maximumDifference });
      await run.save();
      assert.equal(changedChannels, 0, `Native capture pixels changed: ${capture.name}`);
    }
  }
  report.functionalPassed = true; report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
} finally {
  if (original) await page.setWindowSize(original).catch(() => {});
  await run.close();
  await fixture?.close();
}
