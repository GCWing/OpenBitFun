import assert from 'node:assert/strict';
import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

/** Isolated DOM fixture for the native driver's same-origin frame commands. */
export class WebDriverFramePage extends WorkbenchResidencyPage {
  async installFixture() {
    return this.execute(() => {
      const outer = document.createElement('iframe');
      outer.id = 'webdriver-frame-outer';
      outer.style.cssText = 'position:fixed;inset:20px;width:700px;height:500px;z-index:2147483647;background:white;border:0';
      document.body.appendChild(outer);
      outer.contentDocument.open();
      outer.contentDocument.write('<!doctype html><html><body><label for="draft">Outer draft</label><input id="draft"><button id="count">Count</button><output id="result">0</output><iframe id="nested"></iframe><div style="height:6000px">Scrollable content</div></body></html>');
      outer.contentDocument.close();
      const nested = outer.contentDocument.getElementById('nested');
      nested.contentDocument.open();
      nested.contentDocument.write('<!doctype html><html><body><label for="draft">Nested draft</label><input id="draft"></body></html>');
      nested.contentDocument.close();
      outer.contentWindow.frameMarker = 'outer'; nested.contentWindow.frameMarker = 'nested';
      outer.contentWindow.frameCounts = { inputs: 0, clicks: 0, wheels: 0 };
      outer.contentDocument.addEventListener('input', () => outer.contentWindow.frameCounts.inputs++);
      outer.contentDocument.addEventListener('wheel', () => outer.contentWindow.frameCounts.wheels++);
      outer.contentDocument.getElementById('count').addEventListener('click', () => {
        outer.contentWindow.frameCounts.clicks++;
        outer.contentDocument.getElementById('result').textContent = String(outer.contentWindow.frameCounts.clicks);
      });
      return [...document.querySelectorAll('iframe,frame')].indexOf(outer);
    });
  }

  element(selector) { return this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector }); }
  switchFrame(id) { return this.request(`/session/${this.session}/frame`, { id }); }
  elementRoute(reference, suffix) {
    return `/session/${this.session}/element/${reference['element-6066-11e4-a52e-4f735466cecf']}/${suffix}`;
  }

  async exerciseFrames() {
    const frameIndex = await this.installFixture();
    const outer = await this.element('#webdriver-frame-outer');
    await this.switchFrame(outer);
    assert.equal(await this.execute(() => window.frameMarker), 'outer', 'User scripts use the selected frame');
    const input = await this.element('#draft');
    await this.request(this.elementRoute(input, 'value'), { text: 'outer draft' });
    assert.equal(await this.request(this.elementRoute(input, 'property/value')), 'outer draft');
    assert.equal(await this.request(this.elementRoute(input, 'computedlabel')), 'Outer draft');
    await this.click('#count');
    assert.equal(await this.execute(() => document.getElementById('result').textContent), '1');
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'frame-reader', actions: [
      { type: 'scroll', origin: 'viewport', x: 650, y: 450, deltaX: 0, deltaY: 800, duration: 16 },
    ] }] });
    await this.until(() => this.execute(() => scrollY > 100), 'selected frame wheel scrolling');
    const outerState = await this.execute(() => ({ marker: window.frameMarker, draft: document.getElementById('draft').value,
      scrollY, ...window.frameCounts, localBridge: typeof window.__openbitfunWd }));
    assert.equal(outerState.inputs, 1); assert.equal(outerState.clicks, 1); assert.ok(outerState.wheels > 0);
    const nested = await this.element('#nested');
    await this.switchFrame(nested);
    assert.equal(await this.execute(() => window.frameMarker), 'nested');
    const innerInput = await this.element('#draft');
    await this.request(this.elementRoute(innerInput, 'value'), { text: 'nested draft' });
    assert.equal(await this.request(this.elementRoute(innerInput, 'computedlabel')), 'Nested draft');
    assert.equal(await this.request(this.elementRoute(innerInput, 'property/value')), 'nested draft');
    await this.request(`/session/${this.session}/frame/parent`, {});
    assert.equal(await this.execute(() => window.frameMarker), 'outer');
    assert.equal(await this.request(this.elementRoute(input, 'property/value')), 'outer draft');
    await this.request(this.elementRoute(input, 'clear'), {});
    assert.equal(await this.execute(() => document.getElementById('draft').value), '');
    await this.switchFrame(null);
    assert.equal(await this.execute(() => window.frameMarker ?? null), null);
    await this.switchFrame(frameIndex);
    assert.equal(await this.execute(() => window.frameMarker), 'outer', 'Index frame selection must match element selection');
    assert.equal(await this.request(this.elementRoute(input, 'property/value')), '');
    await this.switchFrame(null);
    const retained = await this.snapshot();
    assert.equal(retained.releasedDriverHandles, 0, 'Keep handles in live nested frames');
    await this.switchFrame(outer);
    assert.equal(await this.request(this.elementRoute(input, 'property/value')), '', 'Retained frame input remains addressable');
    await this.switchFrame(null);
    await this.execute(() => document.getElementById('webdriver-frame-outer').remove());
    const closed = await this.snapshot();
    assert.ok(closed.releasedDriverHandles >= 4, 'Release removed outer/nested frames and their input handles');
    const childHandles = await this.execute(() => Object.values(window.__openbitfunWdElements)
      .filter(node => node.ownerDocument !== document).length);
    assert.equal(childHandles, 0, 'No removed child document is retained by the driver');
    return { frameIndex, outerState, nestedDraft: 'nested draft', parentFrameRestored: true, topFrameRestored: true,
      releasedDriverHandles: closed.releasedDriverHandles, closedChildHandles: childHandles };
  }
}
