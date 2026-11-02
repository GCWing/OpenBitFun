import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

test('background delivery survives remote event reduction and collapses only quiet results in the real browser', { timeout: 60000 }, async () => {
  const source = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(source.origin);
    const reduced = await page.evaluate(async () => {
      const fixture = await import('/tests/helpers/background-delivery-fixture.tsx');
      return { execution: fixture.reduceBackgroundExecution(), recovery: fixture.rejectsOldGeneration() };
    });
    assert.equal(reduced.execution.start.active_turn.backgroundDelivery.disposition, 'pending');
    assert.equal(reduced.execution.finished.new_messages[1].content, 'Nothing changed; remaining quiet.');
    assert.equal(reduced.execution.finished.new_messages[0].status, 'completed');
    assert.equal(reduced.execution.finished.new_messages[1].metadata.backgroundDelivery.disposition, 'quiet');
    assert.equal(reduced.recovery.old, null);
    assert.equal(reduced.recovery.active.status, 'active');
    for (const width of [390, 768, 1280]) {
      await page.setViewport({ width, height: 844 });
      await page.evaluate(async () => (await import('/tests/helpers/background-delivery-fixture.tsx')).showBackgroundTranscript('quiet'));
      await page.waitForSelector('.chat-background-run');
      assert.equal(await page.$('.chat-msg--assistant'), null, 'raw quiet reply is unmounted while collapsed');
      await page.click('.chat-background-run button');
      await page.waitForSelector('.chat-msg--assistant');
      assert.match(await page.$eval('.chat-msg--assistant', node => node.textContent), /Nothing changed/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}`);
      if (process.env.BACKGROUND_DELIVERY_SCREENSHOT) await page.screenshot({ path: `${process.env.BACKGROUND_DELIVERY_SCREENSHOT}-${width}.png` });
      await page.click('.chat-background-run button');
      await page.waitForFunction(() => !document.querySelector('.chat-msg--assistant'));
    }
    for (const mode of ['legacy', 'failure']) {
      await page.evaluate(async mode => (await import('/tests/helpers/background-delivery-fixture.tsx')).showBackgroundTranscript(mode), mode);
      await page.waitForSelector('.chat-msg--assistant');
      assert.equal(await page.$('.chat-background-run'), null);
    }
    await page.evaluate(async () => (await import('/tests/helpers/background-delivery-fixture.tsx')).showBackgroundTranscript('question'));
    await page.waitForFunction(() => document.body.innerText.includes('Choose a value'));
    assert.equal(await page.$('.chat-background-run'), null, 'an outstanding interaction stays directly accessible');
  } finally {
    await browser.close();
    await source.close();
  }
});
