// Real browser rendering/events; storage and locale use explicit fixture ports.
// Native owner durability is verified separately by the Rust service tests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const requireE2e = createRequire(new URL('../tests/e2e/package.json', import.meta.url));
const requireWdio = createRequire(requireE2e.resolve('@wdio/cli'));
const puppeteer = requireWdio('puppeteer-core');
const url = process.env.OPENBITFUN_GENUI_TEST_URL;
if (!url) throw new Error('Set OPENBITFUN_GENUI_TEST_URL to this checkout Vite /tests/e2e/generative-ui.html');
const browser = await puppeteer.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  headless: 'new',
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const setInputValue = async (selector, value) => page.evaluate((target, next) => {
    const element = [...document.querySelectorAll(target)].find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !candidate.closest('[inert]');
    });
    if (!element) throw new Error('Visible input not found: ' + target);
    const input = element;
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('Input has no writable value setter');
    setter.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
  const waitForReactiveText = value => page.waitForFunction(expected => [...document.querySelectorAll('.gen-ui-oi-text,.iui-text')].some(element => element.textContent === expected && !element.closest('[inert]')), {}, value);
  const verify = async () => {
    await page.waitForSelector('html[data-genui-result]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="genui-evidence"]', { timeout: 60000 });
    const reports = await page.$eval('[data-testid="genui-evidence"]', element => JSON.parse(element.textContent));
    assert.equal(await page.$eval('html', element => element.dataset.genuiResult), 'passed', JSON.stringify(reports));
    for (const name of ['openui', 'harmony', 'openui-source', 'free']) {
      for (const stage of ['preflight', 'checks', 'render', 'reopen', 'probeReopen', 'layout']) assert.equal(reports[name][stage], 'passed', name + '.' + stage);
      assert.deepEqual(reports[name].layoutWidths, ['harmony', 'free', 'openui-source'].includes(name) ? [360] : [360, 960]);
      if (name === 'harmony' || name === 'free' || name === 'openui-source') {
        assert.deepEqual(reports[name].designSpec, { id: 'harmony.phone.v1', revision: 1 });
        assert.equal(reports[name].viewport, '360x764');
        assert.equal(reports[name].hostShell, 'passed');
      }
      if (name === 'free') assert.equal(reports[name].screenshotBytes, undefined);
      else assert(reports[name].screenshotBytes > 100);
    }
  };
  await page.goto(url);
  await verify();
  const harmonyProbe = await page.$eval('[data-testid="harmony-style-probe"]', element => {
    const app = element.querySelector('[data-gen-ui-app="harmony-style-probe"]');
    const card = app?.querySelector('.gen-ui-oi-card');
    const button = app?.querySelector('button.gen-ui-oi-button');
    const input = app?.querySelector('.gen-ui-oi-field input');
    const slider = app?.querySelector('.gen-ui-oi-slider input[type="range"]');
    const icon = app?.querySelector('.hm-icon');
    const frame = element.querySelector('.gen-ui-phone-device');
    return {
      theme: app?.getAttribute('data-hm-theme'),
      font: app?.getAttribute('data-hm-font'),
      scheme: app?.getAttribute('data-hm-scheme'),
      frameTheme: frame?.getAttribute('data-hm-theme'),
      cardRadius: card ? getComputedStyle(card).borderRadius : '',
      buttonRadius: button ? getComputedStyle(button).borderRadius : '',
      inputRadius: input ? getComputedStyle(input).borderRadius : '',
      track: slider ? getComputedStyle(slider).getPropertyValue('--hm-track').trim() : '',
      iconName: icon?.getAttribute('data-icon'),
      iconFont: icon ? getComputedStyle(icon).fontFamily : '',
    };
  });
  assert.deepEqual(harmonyProbe, {
    theme: 'green', font: 'sans', scheme: 'light', frameTheme: 'green',
    cardRadius: '24px', buttonRadius: '999px', inputRadius: '20px', track: '4px',
    iconName: 'house', iconFont: '"HM Symbol"',
  });
  const harmonyHtmlFrameElement = await page.$('[data-testid="harmony-html-style-probe"] iframe[data-gen-ui-html-frame]');
  assert(harmonyHtmlFrameElement, 'Harmony HTML style probe iframe did not mount');
  const harmonyHtmlFrame = await harmonyHtmlFrameElement.contentFrame();
  assert(harmonyHtmlFrame, 'Harmony HTML style probe did not expose a browser frame');
  await harmonyHtmlFrame.waitForSelector('.hero-ring, .list-item, .progress');
  const harmonyHtmlProbe = await harmonyHtmlFrame.evaluate(() => {
    const root = document.documentElement;
    const card = document.querySelector('.card');
    const ring = document.querySelector('.hero-ring');
    const progress = document.querySelector('.progress');
    const toggle = document.querySelector('.switch');
    const chip = document.querySelector('.chip.active');
    return {
      theme: root.getAttribute('data-hm-theme'),
      font: root.getAttribute('data-hm-font'),
      cardRadius: card ? getComputedStyle(card).borderRadius : '',
      ringSize: ring ? getComputedStyle(ring).width : '',
      progressHeight: progress ? getComputedStyle(progress).height : '',
      switchWidth: toggle ? getComputedStyle(toggle).width : '',
      switchColor: toggle ? getComputedStyle(toggle).backgroundColor : '',
      chipRadius: chip ? getComputedStyle(chip).borderRadius : '',
    };
  });
  assert.deepEqual(harmonyHtmlProbe, {
    theme: 'green', font: 'sans', cardRadius: '24px', ringSize: '176px',
    progressHeight: '4px', switchWidth: '36px', switchColor: 'rgb(58, 131, 87)', chipRadius: '14px',
  });
  const harmonyDarkProbe = await page.$eval('[data-testid="harmony-dark-style-probe"]', element => {
    const app = element.querySelector('[data-gen-ui-app="harmony-dark-style-probe"]');
    const card = app?.querySelector('.gen-ui-oi-card');
    const frame = element.querySelector('.gen-ui-phone-device');
    return {
      theme: app?.getAttribute('data-hm-theme'),
      font: app?.getAttribute('data-hm-font'),
      scheme: app?.getAttribute('data-hm-scheme'),
      frameScheme: frame?.getAttribute('data-hm-scheme'),
      cardBackground: card ? getComputedStyle(card).backgroundColor : '',
      frameBackground: frame ? getComputedStyle(frame).backgroundColor : '',
    };
  });
  assert.deepEqual(harmonyDarkProbe, {
    theme: 'purple', font: 'handwritten', scheme: 'dark', frameScheme: 'dark',
    cardBackground: 'rgba(255, 255, 255, 0.1)', frameBackground: 'rgb(50, 46, 54)',
  });
  const freeFrameElement = await page.$('[data-testid="free-live-document"] iframe[data-gen-ui-html-frame]');
  assert(freeFrameElement, 'Free document iframe did not mount in the live host');
  const freeFrame = await freeFrameElement.contentFrame();
  assert(freeFrame, 'Free document iframe did not expose a browser frame');
  await freeFrame.waitForSelector('svg[aria-label="Decorative chart"]');
  assert.match(await freeFrame.$eval('body', element => element.textContent ?? ''), /Free SVG/);
  assert.equal(await freeFrame.$eval('meta[name="openbitfun-design-spec"]', element => element.content), 'Harmony phone@1');
  assert.equal(await freeFrame.$eval('meta[name="openbitfun-style-resources"]', element => element.content), 'openbitfun-theme-tokens,openbitfun-harmony-components');
  const scriptFrameElement = await page.$('[data-testid="script-live-document"] iframe[data-gen-ui-html-frame]');
  assert(scriptFrameElement, 'Controlled script iframe did not mount');
  const scriptFrame = await scriptFrameElement.contentFrame();
  assert(scriptFrame, 'Controlled script iframe did not expose a browser frame');
  await scriptFrame.waitForFunction(() => document.querySelector('[data-bridge-result]')?.textContent === 'bridge-ok');
  const scriptContext = await page.evaluate(() => JSON.parse(sessionStorage.getItem('genui-script-context')));
  assert.deepEqual(scriptContext.payload, { value: 'bridge-ok' });
  assert.equal(scriptContext.context.appId, 'script-phone');
  assert.equal(scriptContext.context.designSpec.id, 'harmony.phone.v1');
  assert.equal(scriptContext.context.designSpec.revision, 1);
  assert.equal(typeof scriptContext.context.sourceKey, 'string');
  const noteSelector = '[aria-label="Shared note"]';
  await setInputValue(noteSelector, 'Updated browser note');
  await waitForReactiveText('Updated browser note');
  assert.notEqual(await page.$eval('[data-gen-ui-save]', element => element.getAttribute('data-gen-ui-save')), 'saved');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('genui-browser-state')), null);
  await page.reload();
  await verify();
  await page.waitForFunction(() => ![...document.querySelectorAll('.gen-ui-oi-text')].some(element => element.textContent === 'Updated browser note'));
  assert.deepEqual(errors, []);
  if (process.env.OPENBITFUN_GENUI_SCREENSHOT_DIR) {
    await mkdir(process.env.OPENBITFUN_GENUI_SCREENSHOT_DIR, { recursive: true });
    for (const name of ['openui', 'harmony', 'openui-source', 'free']) {
      const image = await page.$('[data-testid="genui-screenshot-' + name + '"]');
      if (!image) continue;
      const src = await image.evaluate(element => element.src);
      if (src) await writeFile(join(process.env.OPENBITFUN_GENUI_SCREENSHOT_DIR, name + '.png'), Buffer.from(src.split(',')[1], 'base64'));
    }
  }
  const settingsUrl = new URL(url); settingsUrl.searchParams.set('settings', '');
  await page.goto(settingsUrl.href); await verify();
  await page.waitForSelector('.gen-ui-library-preview');
  await page.click('[role="combobox"]');
  await page.waitForSelector('[role="option"]');
  assert.deepEqual(await page.$$eval('[role="option"]', elements => elements.map(element => element.textContent)), ['Open Intelligent UI', 'OpenBitFun', 'Harmony']);
  for (const option of await page.$$('[role="option"]')) {
    if (await option.evaluate(element => element.textContent?.includes('Harmony') ?? false)) { await option.click(); break; }
  }
  await page.waitForSelector('[data-gen-ui-app="library-preview-harmony"]');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('genui-browser-library')), 'harmony');
  await setInputValue('[aria-label="Shared note"]', 'Temporary demo');
  await waitForReactiveText('Temporary demo');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('genui-browser-state')), null);
  if (process.env.OPENBITFUN_GENUI_SCREENSHOT_DIR) {
    await page.$eval('[data-testid="genui-evidence"]', element => { element.hidden = true; });
    await page.screenshot({ path: join(process.env.OPENBITFUN_GENUI_SCREENSHOT_DIR, 'settings-harmony.png'), fullPage: true });
  }
  await page.reload(); await verify();
  await page.waitForSelector('[data-gen-ui-app="library-preview-harmony"]');
  assert.notEqual(await page.$eval('[aria-label="Shared note"]', element => element.value), 'Temporary demo');
  assert.equal(await page.$eval('select', element => element.value), 'harmony');
  assert.deepEqual(errors, []);
  for (const deferred of [false, true]) {
    const streamUrl = new URL(url); streamUrl.searchParams.set('streaming', '');
    if (deferred) streamUrl.searchParams.set('deferred', '');
    await page.goto(streamUrl.href); await verify();
    const next = async stage => {
      await page.click('[data-testid="stream-advance"]');
      await page.waitForSelector('[data-testid="genui-stream"][data-stage="' + stage + '"]');
    };
    await next(1);
    await page.waitForSelector('[data-gen-ui-app]');
    await next(2);
    assert(await page.$('[data-gen-ui-app]'));
    assert(await page.$eval('[data-testid="genui-stream"]', element => Number(element.dataset.sent) < Number(element.dataset.total)));
    await next(3);
    await page.waitForSelector('[data-gen-ui-app]');
    assert.match(await page.$eval('[data-gen-ui-app]', element => element.textContent ?? ''), /Streaming source/);
    await next(4);
    await page.waitForSelector('[data-gen-ui-postcheck="passed"]');
    assert.equal(await page.$$eval('[role="alert"]', elements => elements.length), 0);
  }
  assert.deepEqual(errors, []);
  console.log('PASS GenUI mounted checks, layout, transient interaction, settings and native/deferred incremental streaming with stable DOM');
} finally {
  const child = browser.process();
  try { await browser.close(); }
  finally { child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); }
}
