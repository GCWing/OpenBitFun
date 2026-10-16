import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

test('suggestion stream and composer preserve text across compact and wide layouts without submitting', { timeout: 60_000 }, async () => {
  const server = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const selector = '[data-testid="chat-prompt-suggestion"]';
    const text = '  Review the tests\nand explain what still needs fixing  ';
    for (const width of [390, 1200]) {
      await page.setViewport({ width, height: 844 });
      await page.goto(server.origin);
      await page.evaluate(async () => {
        const { mountPromptSuggestionFixture } = await import('/tests/fixtures/prompt-suggestion.tsx');
        window.suggestions = mountPromptSuggestionFixture();
      });
      await page.waitForFunction(() => window.suggestions.ready());
      await page.evaluate(text => {
        const fixture = window.suggestions;
        fixture.event({ event: 'session-record', session_id: 'session', payload: {
          sessionId: 'session', id: 'turn/first', revision: 1,
          turn: { turnId: 'first', sessionId: 'session', turnIndex: 0, status: 'completed', timestamp: 1, userMessage: { id: 'user-1', content: 'Review', timestamp: 1 } },
        } });
        fixture.event({ event: 'agentic://prompt-suggestion', session_id: 'session',
          payload: { sessionId: 'session', sourceTurnId: 'first', suggestion: text } });
        fixture.caughtUp();
      }, text);
      await page.waitForSelector(selector);
      assert.equal(await page.$eval(selector, node => node.textContent), text);
      assert.equal(await page.$eval('body', node => node.scrollWidth <= innerWidth), true);
      for (const gate of ['offline', 'sending']) {
        await page.evaluate(gate => window.suggestions[gate](true), gate);
        await page.waitForSelector(selector, { hidden: true });
        await page.evaluate(gate => window.suggestions[gate](false), gate);
        await page.waitForSelector(selector);
      }
      await page.screenshot({ path: `/tmp/mobile-prompt-suggestion-${width}.png` });
      await page.click(selector);
      await page.waitForFunction(text => document.activeElement?.value === text, {}, text);
      assert.deepEqual(await page.evaluate(() => window.suggestions.calls), [text]);
      await page.waitForSelector(selector, { hidden: true });
      await page.$eval('textarea', node => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, '');
        node.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector(selector);
      await page.evaluate(() => window.suggestions.event({ event: 'session-record', session_id: 'session', payload: {
        sessionId: 'session', id: 'turn/second', revision: 2,
        turn: { turnId: 'second', sessionId: 'session', turnIndex: 1, status: 'inprogress', timestamp: 2, userMessage: { id: 'user-2', content: 'Continue', timestamp: 2 } },
      } }));
      await page.waitForSelector(selector, { hidden: true });
      assert.deepEqual(await page.evaluate(() => window.suggestions.calls), [text]);
    }
  } finally { await browser.close(); await server.close(); }
});
