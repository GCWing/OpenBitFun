import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

async function closeDetails(page) {
  await page.waitForFunction(() => {
    const sheet = document.querySelector('.chat-tool-details[data-state="open"]');
    return sheet && sheet.getAnimations({ subtree: true }).every(animation => animation.playState === 'finished');
  });
  await page.click('.chat-tool-details[data-state="open"] button[aria-label="Close"]');
  await page.waitForFunction(() => !document.querySelector('.chat-tool-details'));
}

test('message times and quiet tool failures work at compact and wide sizes', { timeout: 60000 }, async () => {
  const source = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(source.origin);
    const times = await page.evaluate(async () => {
      const { messageTimestamp } = await import('/src/i18n/messageTime.ts');
      return ['1700000000', '1700000000000', '1700000000000000', '1700000000000000000', '', 'invalid']
        .map(value => messageTimestamp(value)?.getTime() ?? null);
    });
    assert.deepEqual(times, [1700000000000, 1700000000000, 1700000000000, 1700000000000, null, null]);
    for (const width of [390, 768, 1280]) {
      await page.setViewport({ width, height: 844 });
      await page.evaluate(async () => (await import('/tests/helpers/mobile-chat-regressions-fixture.tsx')).showTranscript());
      await page.waitForSelector('.chat-tool-list__header[aria-expanded="false"]');
      const dates = await page.$$eval('.chat-msg__timestamp', nodes => nodes.map(node => node.dateTime));
      assert.deepEqual(dates, ['2023-11-14T22:13:20.000Z', '2023-11-14T22:13:21.000Z']);
      assert.equal(await page.$('.chat-tool-card[data-prominent="true"]'), null);
      if (process.env.MOBILE_CHAT_SCREENSHOT) await page.screenshot({ path: `${process.env.MOBILE_CHAT_SCREENSHOT}-collapsed-${width}.png` });
      await page.click('.chat-tool-list__header');
      await page.waitForSelector('.chat-tool-card--settled');
      const failed = await page.$('.chat-tool-card--settled');
      await (await failed.$('button')).click();
      await page.waitForFunction(() => document.body.innerText.includes('HTTP 404'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.MOBILE_CHAT_SCREENSHOT) await page.screenshot({ path: `${process.env.MOBILE_CHAT_SCREENSHOT}-${width}.png` });
      await closeDetails(page);
      await page.click('.chat-tool-list__header');
      await page.waitForSelector('.chat-tool-list__header[aria-expanded="false"]');
    }
    await page.evaluate(async () => (await import('/tests/helpers/mobile-chat-regressions-fixture.tsx')).showTranscript(false, 'ordered'));
    await page.waitForSelector('.chat-thinking');
    assert.equal(await page.$('.chat-thinking--streaming'), null, 'failed/cancelled reads are settled');
    assert.equal(await page.$('.chat-tool-card'), null, 'failed reads stay in the ordered read summary');
    await page.click('.chat-thinking button');
    assert.equal(await page.$$eval('.chat-read-tools .chat-tool-details__trigger', nodes => nodes.length), 7);
    await page.click('.chat-read-tools .chat-tool-details__trigger:nth-child(3)');
    await page.waitForFunction(() => document.body.innerText.includes('HTTP 404'));
    await closeDetails(page);

    await page.evaluate(async () => (await import('/tests/helpers/mobile-chat-regressions-fixture.tsx')).showTranscript(false, 'subagent'));
    await page.waitForSelector('.chat-task-card__summary');
    await page.click('.chat-task-card__summary');
    await page.waitForSelector('.chat-task-card__step.is-settled');
    assert.equal(await page.$('.chat-task-card__step.is-error'), null, 'ordinary subagent tool failures stay neutral');
    for (const status of ['failed', 'error', 'cancelled', 'rejected']) {
      await page.evaluate(async value => (await import('/tests/helpers/mobile-chat-regressions-fixture.tsx')).showTranscript(false, 'subagent', value), status);
      await page.waitForSelector('.chat-task-card--settled[data-prominent="false"]');
      assert.equal(await page.$('.chat-task-card__header .chat-tool-card__spinner'), null, `${status} tasks do not keep spinning`);
    }
    await page.evaluate(async () => (await import('/tests/helpers/mobile-chat-regressions-fixture.tsx')).showTranscript(true, 'subagent', 'pending_confirmation'));
    await page.waitForSelector('.chat-task-card[data-prominent="true"]');
    await page.evaluate(async () => (await import('/tests/helpers/mobile-chat-regressions-fixture.tsx')).showTranscript(true));
    await page.waitForSelector('.chat-tool-card[data-prominent="true"]');
    assert.equal(await page.$('.chat-tool-list--collapsed'), null, 'approval stays reachable');
  } finally { await browser.close(); await source.close(); }
});
