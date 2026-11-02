import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

const text = String.raw`行内 $x$、$x^2+y^2=z^2$、\(\alpha\)、\(\frac{a}{b}\)

$$E=mc^2$$

https://example.com/${'unbroken-path-segment'.repeat(16)}

${'Keep every line of the original message.\n'.repeat(16)}`.trim();

async function clickButton(page, label) {
  await page.waitForFunction(label => Array.from(document.querySelectorAll('button')).some(node => node.textContent === label), {}, label);
  await page.evaluate(label => Array.from(document.querySelectorAll('button')).find(node => node.textContent === label).click(), label);
}

async function assertSheetLayout(page, selector) {
  // Media-query changes and sheet presence can restart the entrance animation.
  await page.$eval(selector, async node => {
    const sheet = node.closest('[role="dialog"]');
    await Promise.all(sheet.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const layout = await page.$eval(selector, node => {
    const sheet = node.closest('[role="dialog"]');
    const body = sheet.querySelector('[data-openbitfun-part="body"]');
    const actions = sheet.querySelector('[data-openbitfun-part="actions"]');
    const field = node.closest('[data-openbitfun-component="mobile-textarea"]') ?? node;
    return {
      sheet: sheet.getBoundingClientRect().toJSON(), body: body.getBoundingClientRect().toJSON(),
      field: field.getBoundingClientRect().toJSON(), actions: actions.getBoundingClientRect().toJSON(),
      textAlign: getComputedStyle(node).textAlign,
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.ok(Math.abs(layout.field.left - layout.actions.left) <= 1, 'message field must align with the actions, not shrink to its text');
  assert.ok(Math.abs(layout.field.right - layout.actions.right) <= 1, 'message field must use the available sheet width');
  assert.ok(['left', 'start'].includes(layout.textAlign), 'message content must be leading-aligned');
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'unbroken text must not cause horizontal overflow');
  assert.ok(layout.scrollHeight > layout.clientHeight, 'long content must remain scrollable');
  assert.ok(layout.sheet.left >= 0 && layout.sheet.right <= layout.viewport.width);
  assert.ok(layout.sheet.top >= 0 && layout.sheet.bottom <= layout.viewport.height + 1, JSON.stringify(layout));
  assert.ok(layout.body.bottom <= layout.actions.top + 1, 'scrolling content must not overlap the actions');
}

test('edit and rollback sheets use the full message width through resize and keep long text scrollable', { timeout: 60_000 }, async () => {
  const server = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    for (const theme of ['dark', 'light']) {
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(server.origin);
      await page.evaluate(async ({ text, theme }) => {
        document.documentElement.setAttribute('data-color-scheme', theme);
        localStorage.setItem('openbitfun-mobile-language', 'en-US');
        window.rollbackFixture = (await import('/tests/fixtures/chat-rollback.tsx')).mountRollbackFixture(text);
      }, { text, theme });
      await page.waitForSelector('.chat-msg--user');
      for (const mode of ['edit', 'rollback']) {
        await page.$eval('.chat-msg--user', node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
        await clickButton(page, mode === 'edit' ? 'Edit & resend' : 'Roll back to here');
        const selector = mode === 'edit' ? '.chat-msg__rollback-input' : '.chat-msg__rollback-quote';
        await page.waitForSelector(selector);
        await page.waitForFunction(() => !document.querySelector('[data-openbitfun-component="mobile-sheet"][data-state="exiting"]'));
        assert.equal(await page.$eval(selector, node => node.value ?? node.textContent), text);
        // Resize the open sheet without remounting it, including a keyboard-sized viewport.
        for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 768, height: 844 }, { width: 1200, height: 844 }, { width: 390, height: 420 }]) {
          await page.setViewport(viewport);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await assertSheetLayout(page, selector);
          await page.screenshot({ path: `/tmp/mobile-${mode}-${theme}-${viewport.width}-${viewport.height}.png` });
        }
        await page.$eval(selector, node => { node.scrollTop = node.scrollHeight; });
        assert.ok(await page.$eval(selector, node => node.scrollTop > 0), 'the end of the message is reachable');
        if (mode === 'edit') {
          await page.focus(selector);
          const before = await page.$eval(selector, node => node.value);
          await page.keyboard.press('End');
          await page.keyboard.press('Enter');
          assert.equal(await page.$eval(selector, node => node.value.length), before.length + 1, 'Enter remains a text-editing action');
        }
        await clickButton(page, 'Cancel');
        await page.waitForSelector(selector, { hidden: true });
        assert.deepEqual(await page.evaluate(() => window.rollbackFixture.calls), [], 'layout, editing and cancel must not roll back or send');
      }
    }
  } finally { await browser.close(); await server.close(); }
});
