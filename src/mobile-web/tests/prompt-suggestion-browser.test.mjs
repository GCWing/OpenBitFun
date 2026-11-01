import assert from 'node:assert/strict';
import test from 'node:test';
import { launchBrowser, startSourceServer } from './helpers/browser-account-harness.mjs';

async function assertSuggestionFits(page, selector) {
  // The page clips horizontal overflow, so body.scrollWidth alone misses
  // text and icons spilling outside an otherwise correctly sized button.
  const bounds = await page.$eval(selector, node => {
    const button = node.getBoundingClientRect();
    const label = node.querySelector('[data-openbitfun-part="label"]').getBoundingClientRect();
    const icon = node.querySelector('[data-openbitfun-part="trailing"]').getBoundingClientRect();
    const composer = document.querySelector('.chat-page__composer').getBoundingClientRect();
    return {
      button: button.toJSON(), label: label.toJSON(), icon: icon.toJSON(), composer: composer.toJSON(),
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
    };
  });
  assert.ok(bounds.label.width > 0, 'the suggestion label needs its own constrained layout box');
  assert.ok(bounds.button.left >= bounds.composer.left - 1);
  assert.ok(bounds.button.right <= bounds.composer.right + 1);
  assert.ok(bounds.label.left >= bounds.button.left);
  assert.ok(bounds.label.right <= bounds.icon.left);
  assert.ok(bounds.icon.right < bounds.button.right, 'the acceptance icon must remain inside the button');
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, 'suggestion content must not overflow the button');
  assert.equal(await page.$eval('body', node => node.scrollWidth <= innerWidth), true);
}

test('suggestions fit the composer across compact, foldable and wide layouts without losing text or submitting', { timeout: 60_000 }, async () => {
  const server = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const selector = '[data-testid="chat-prompt-suggestion"]';
    const suggestions = [
      'Continue',
      '  Review the tests\nand explain what still needs fixing  ',
      '你看到的渲染实际是什么样？把异常的几条贴出来，我帮你定位是字符解析、转义处理还是货币、环境变量的启发式规则出了问题。',
      `  https://example.com/${'unbroken-path-segment'.repeat(12)}  `,
    ];
    for (const [index, text] of suggestions.entries()) {
      for (const width of [320, 390, 768, 1200]) {
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
        await assertSuggestionFits(page, selector);
        for (const gate of ['offline', 'sending']) {
          await page.evaluate(gate => window.suggestions[gate](true), gate);
          await page.waitForSelector(selector, { hidden: true });
          await page.evaluate(gate => window.suggestions[gate](false), gate);
          await page.waitForSelector(selector);
        }
        await page.screenshot({ path: `/tmp/mobile-prompt-suggestion-${index}-${width}.png` });
        await page.click(selector);
        await page.waitForFunction(text => document.activeElement?.value === text, {}, text);
        assert.deepEqual(await page.evaluate(() => window.suggestions.calls), [text]);
        await page.waitForSelector(selector, { hidden: true });
        await page.$eval('textarea', node => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, '');
          node.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForSelector(selector);
        await assertSuggestionFits(page, selector);
        // The expanded composer must retain its bounds during a live compact/wide switch.
        await page.setViewport({ width: width < 900 ? 1200 : 390, height: 844 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertSuggestionFits(page, selector);
        await page.evaluate(() => window.suggestions.event({ event: 'session-record', session_id: 'session', payload: {
          sessionId: 'session', id: 'turn/second', revision: 2,
          turn: { turnId: 'second', sessionId: 'session', turnIndex: 1, status: 'inprogress', timestamp: 2, userMessage: { id: 'user-2', content: 'Continue', timestamp: 2 } },
        } }));
        await page.waitForSelector(selector, { hidden: true });
        assert.deepEqual(await page.evaluate(() => window.suggestions.calls), [text]);
      }
    }
  } finally { await browser.close(); await server.close(); }
});

test('the trailing control sends a suggestion without touching the draft', { timeout: 60_000 }, async () => {
  const server = await startSourceServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(server.origin);
    await page.evaluate(async () => {
      const { mountPromptSuggestionFixture } = await import('/tests/fixtures/prompt-suggestion.tsx');
      window.suggestions = mountPromptSuggestionFixture();
    });
    await page.waitForFunction(() => window.suggestions.ready());
    await page.evaluate(() => {
      const fixture = window.suggestions;
      fixture.event({ event: 'session-record', session_id: 'session', payload: {
        sessionId: 'session', id: 'turn/first', revision: 1,
        turn: { turnId: 'first', sessionId: 'session', turnIndex: 0, status: 'completed', timestamp: 1, userMessage: { id: 'user-1', content: 'Review', timestamp: 1 } },
      } });
      fixture.event({ event: 'agentic://prompt-suggestion', session_id: 'session',
        payload: { sessionId: 'session', sourceTurnId: 'first', suggestion: 'Run the tests' } });
      fixture.caughtUp();
    });
    const selector = '[data-testid="chat-prompt-suggestion"]';
    await page.waitForSelector(selector);
    // The compact accept affordance must stay the default target; sending is an
    // explicit second control, not the whole bubble.
    assert.equal(await page.$eval(selector, node => node.textContent), 'Run the tests');
    await page.click('[data-testid="chat-prompt-suggestion-send"]');
    await page.waitForFunction(() => window.suggestions.calls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.suggestions.calls), ['send:Run the tests']);
    await page.waitForSelector(selector, { hidden: true });
    assert.equal(
      await page.evaluate(() => document.querySelector('textarea')?.value ?? ''),
      '',
      'a one-tap send must not fill the draft',
    );
  } finally { await browser.close(); await server.close(); }
});
