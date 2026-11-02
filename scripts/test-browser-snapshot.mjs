// Real Chromium DOM -> production snapshot.js -> compiled Rust presentation.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireE2e = createRequire(new URL('../tests/e2e/package.json', import.meta.url));
const requireWdio = createRequire(requireE2e.resolve('@wdio/cli'));
const puppeteer = requireWdio('puppeteer-core');
const script = await readFile(new URL('../src/crates/assembly/core/src/agentic/tools/browser_control/snapshot.js', import.meta.url), 'utf8');
const resolver = await readFile(new URL('../src/crates/assembly/core/src/agentic/tools/browser_control/resolve_element.js', import.meta.url), 'utf8');
const browser = await puppeteer.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  headless: 'new',
});
const dir = await mkdtemp(join(tmpdir(), 'openbitfun-dom-context-'));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.setContent(`<button id="save">保存</button>
    <label for="search">Search label</label><input id="search" value="current query" disabled>
    <input id="secret" type="password" value="must-not-appear">
    <input id="checked" type="checkbox" checked>
    <textarea id="long-value"></textarea><button id="unicode-label"></button>
    <div id="shadow"></div>
    <button id="offscreen" style="position:absolute;top:3000px">Outside</button>
    <iframe id="outer" style="width:500px;height:300px"></iframe>
    <iframe id="hidden" style="display:none"></iframe>
    <iframe id="cross" sandbox srcdoc="<button>Unreachable</button>"></iframe>`);
  await page.evaluate(async () => {
    document.querySelector('#long-value').value = '🧪'.repeat(2001);
    document.querySelector('#unicode-label').textContent = '🧪'.repeat(101);
    const populate = (frame, html) => new Promise(resolve => {
      frame.onload = resolve;
      frame.srcdoc = html;
    });
    await populate(document.querySelector('#outer'), '<button id="frame-button">Frame</button><iframe id="nested" style="width:400px;height:150px"></iframe>');
    await populate(document.querySelector('#outer').contentDocument.querySelector('#nested'), '<button id="deep">Nested</button>');
    await populate(document.querySelector('#hidden'), '<button id="hidden-button">Hidden frame</button>');
    const shadow = document.querySelector('#shadow').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="shadow-button">Shadow</button><iframe id="shadow-frame" style="width:400px;height:100px"></iframe>';
    await populate(shadow.querySelector('iframe'), '<button id="shadow-deep">Shadow frame</button>');
  });
  const snapshot = () => page.evaluate(script).then(JSON.parse);
  const first = await snapshot();
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const byId = Object.fromEntries(first.elements.map(e => [e.id, e]));
  check('DOM names and form states', () => {
    assert.equal(byId.search.label, 'Search label');
    assert.equal(byId.search.value, 'current query');
    assert.equal(byId.search.disabled, true);
    assert.equal(byId.checked.checked, true);
    assert(!JSON.stringify(first).includes('must-not-appear'));
  });
  check('Unicode truncation is explicit and preserves code points', () => {
    assert.equal(byId['long-value'].value, '🧪'.repeat(2000));
    assert.equal(byId['long-value'].value_truncated, true);
    assert.equal(byId['unicode-label'].text, '🧪'.repeat(100));
    assert.equal(byId['unicode-label'].text_truncated, true);
  });
  check('recursive iframe and shadow traversal', () => {
    for (const id of ['save', 'frame-button', 'deep', 'shadow-button', 'shadow-deep']) assert(byId[id], `missing ${id}`);
    assert(byId.deep.frame_path.includes('/'));
    assert.equal(byId['shadow-button'].scope, 'shadow');
  });
  for (const id of ['frame-button', 'deep', 'shadow-button', 'shadow-deep']) {
    if (!byId[id]) continue;
    const resolved = await page.evaluate(`(() => {
      const el = (${resolver})(${JSON.stringify(`[data-cdp-ref="${byId[id].ref}"]`)});
      el.addEventListener('click', () => el.setAttribute('data-clicked', 'true'), {once:true});
      el.click();
      return {id:el.id, clicked:el.getAttribute('data-clicked')};
    })()`);
    check(`ref resolves and activates ${id}`, () => assert.deepEqual(resolved, { id, clicked: 'true' }));
  }
  check('visibility and inaccessible-context reporting', () => {
    assert(!byId.offscreen);
    assert(!byId['hidden-button']);
    assert(first.offscreen_count > 0);
    assert.equal(first.cross_origin_frames, 1);
  });
  await page.evaluate(() => {
    document.querySelector('#save').remove();
    document.querySelector('#outer').contentDocument.querySelector('#nested').contentDocument.querySelector('#deep').style.display = 'none';
  });
  const second = await snapshot();
  check('refresh removes nested stale refs', () => {
    assert.equal(new Set(second.elements.map(e => e.ref)).size, second.elements.length);
    assert(!second.elements.some(e => e.id === 'save' || e.id === 'deep'));
  });
  const deepRef = await page.evaluate(() => document.querySelector('#outer').contentDocument.querySelector('#nested').contentDocument.querySelector('#deep').getAttribute('data-cdp-ref'));
  check('hidden nested element has no stale target attribute', () => assert.equal(deepRef, null));
  if (failures.length) throw new Error(`${failures.length} browser snapshot checks failed`);
  const fixture = join(dir, 'snapshot.json');
  await writeFile(fixture, JSON.stringify(first));
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/test-computer-use-context.mjs'), 'real_browser_snapshot', '--', '--ignored'], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, OPENBITFUN_BROWSER_SNAPSHOT_FIXTURE: fixture },
    });
    child.on('error', reject);
    child.on('close', code => resolveExit(code ?? 1));
  });
  assert.equal(code, 0, 'compiled Rust must preserve the actual browser context');
  if (process.argv.includes('--native-ocr')) {
    assert.equal(process.platform, 'darwin', 'native fixture currently exercises macOS Vision');
    await page.setViewport({ width: 800, height: 600 });
    await page.setContent('<div style="position:absolute;left:100px;top:100px;font:40px Arial;color:black;background:white">Save report</div><div style="position:absolute;left:100px;top:300px;font:40px Arial;color:black;background:white">Cancel</div>');
    const bytes = await page.screenshot({ type: 'jpeg', quality: 95 });
    const ocrFixture = join(dir, 'ocr.json');
    await writeFile(ocrFixture, JSON.stringify({
      bytes: [...bytes], mime_type: 'image/jpeg', image_width: 800, image_height: 600,
      native_width: 1600, native_height: 1200, display_origin_x: -1000, display_origin_y: 0,
      vision_scale: 0.5, image_global_bounds: { left: -500, top: 100, width: 400, height: 300 },
    }));
    const nativeCode = await new Promise((resolveExit, reject) => {
      const nativeArgs = ['--ignored', '--exact', 'computer_use::screen_ocr::native_fixture_tests::native_vision_reads_rendered_fixture'];
      const child = spawn(process.env.OPENBITFUN_TEST_BINARY || 'cargo', process.env.OPENBITFUN_TEST_BINARY ? nativeArgs : ['test', '-p', 'openbitfun-computer-use', '--lib', 'native_vision_reads_rendered_fixture', '--', ...nativeArgs], {
        cwd: root, stdio: 'inherit', windowsHide: true,
        env: { ...process.env, OPENBITFUN_OCR_FIXTURE: ocrFixture },
      });
      child.on('error', reject);
      child.on('close', code => resolveExit(code ?? 1));
    });
    assert.equal(nativeCode, 0, 'actual macOS OCR must recognize the rendered fixture');
  }
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
