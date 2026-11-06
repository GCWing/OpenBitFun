import assert from 'node:assert/strict';
import { WebDriverFramePage } from './WebDriverFramePage.mjs';

/** Native script semantics; all DOM fixtures belong to this isolated run. */
export class WebDriverEvaluationPage extends WebDriverFramePage {
  script(source, args = [], mode = 'sync') {
    return this.request(`/session/${this.session}/execute/${mode}`, { script: source, args });
  }

  async exerciseEvaluation() {
    const payload = { text: 'Quotes "\' ` \\ and \n中文🚀\u2028\u0000', nested: [null, true, false, 123.5, { length: 2, value: 'literal' }] };
    assert.deepEqual(await this.script('return arguments[0];', [payload]), payload);
    assert.equal(await this.script(''), null);
    const source = `(value, done) => {
      if (typeof done === 'function') { setTimeout(() => done({ value, async: true }), 10); return; }
      return { value, async: false };
    }`;
    assert.deepEqual(await this.script(source, [payload]), { value: payload, async: false });
    assert.deepEqual(await this.script(source, [payload], 'async'), { value: payload, async: true });
    assert.deepEqual(await this.script('async value => { await Promise.resolve(); return value; }', [payload]), payload);

    // Evaluating the function expression is observable; never cache a previous
    // function/closure while making the native transport wrapper reusable.
    const effect = `(() => {
      window.__evaluationFixtureCount = (window.__evaluationFixtureCount || 0) + 1;
      const count = window.__evaluationFixtureCount;
      return () => count;
    })()`;
    assert.equal(await this.script(effect), 1);
    assert.equal(await this.script(effect), 2);
    for (const mode of ['sync', 'async']) {
      await assert.rejects(() => this.script('() => { throw new Error("evaluation-fixture-error"); }', [], mode),
        /javascript error.*evaluation-fixture-error/s);
    }
    const timeouts = await this.request(`/session/${this.session}/timeouts`);
    try {
      // The existing driver clamps script deadlines to at least five seconds.
      await this.request(`/session/${this.session}/timeouts`, { script: 5000 });
      await assert.rejects(() => this.script('done => { setTimeout(() => done("late"), 6000); }', [], 'async'), /timeout.*5000ms/s);
    } finally { await this.request(`/session/${this.session}/timeouts`, timeouts); }
    assert.equal(await this.script('() => 42'), 42, 'A timed-out call must not poison later calls');

    await this.installFixture();
    const outer = await this.element('#webdriver-frame-outer');
    await this.switchFrame(outer);
    const input = await this.element('#draft');
    assert.deepEqual(await this.script('(element, value) => { element.value = value; return { marker: window.frameMarker, value: element.value, argument: value }; }',
      [input, payload.text]), { marker: 'outer', value: payload.text.replace(/[\r\n]/g, ''), argument: payload.text });
    await this.switchFrame(await this.element('#nested'));
    assert.deepEqual(await this.script('(value, done) => setTimeout(() => done({ marker: window.frameMarker, value }), 10)',
      [payload], 'async'), { marker: 'nested', value: payload });
    await this.switchFrame(null);
    await this.execute(() => document.getElementById('webdriver-frame-outer').remove());
    await this.snapshot();
    const origin = await this.execute(() => performance.timeOrigin);
    await this.request(`/session/${this.session}/refresh`, {});
    await this.until(() => this.execute(previous => performance.timeOrigin !== previous, origin), 'fresh document after script checks');
    await this.ready();
    assert.deepEqual(await this.script('value => value', [payload]), payload, 'Bootstrap must survive document replacement');
    assert.equal(await this.execute(() => window.__evaluationFixtureCount ?? null), null);
    return { structuredArguments: true, callbackAndPromise: true, freshFunctionEvaluation: true,
      errorsAndTimeoutRecovery: true, selectedFrameArguments: true, refreshedDocument: true };
  }
}
