import assert from 'node:assert/strict';
import { BrowserWorkloadPage } from './BrowserWorkloadPage.mjs';

export class BrowserCapturePage extends BrowserWorkloadPage {
  windowSize() {
    return this.invoke('plugin:window|inner_size', { label: 'main' });
  }

  setWindowSize(size) {
    // The native Window remains valid when it contains multiple WebViews.
    return this.invoke('plugin:window|set_size', { label: 'main', value: { Physical: size } });
  }

  async openCaptureFixture(fixture, workspace) {
    const sessionId = 'browser-capture-a';
    await this.configure({ url: fixture.url, workspace, sessions: [sessionId] });
    await this.select(sessionId);
    await this.enterDraft('BROWSER_WORKLOAD_a');
    await this.click('[data-testid="chat-input-send-btn"]');
    await this.until(() => fixture.results.has('a') || fixture.errors.length, 'real browser open', 90000);
    assert.deepEqual(fixture.errors, []);
    assert.ok(!fixture.results.get('a').is_error);
    const inventory = await this.tool('list_pages', { target: 'builtin' });
    const browser = inventory.pages.find(item => item.url === `${fixture.url}/pages/a`);
    assert.ok(browser?.id);
    await this.tool('navigate', { target: 'builtin', session_id: browser.id, url: fixture.captureUrl, observe: 'article' });
    await this.until(() => this.inChild(browser.id, () => this.execute(() =>
      document.readyState === 'complete' && !!document.querySelector('#capture-fixture'))), 'static screenshot fixture');
    return { sessionId, handle: browser.id };
  }

  async prepareCapture(handle, scroll) {
    return this.inChild(handle, () => this.execute(async scroll => {
      await document.fonts.ready;
      scrollTo(0, scroll);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { width: innerWidth, height: innerHeight, devicePixelRatio, scrollY,
        visibility: document.visibilityState, title: document.title };
    }, scroll));
  }

  capturePng(handle) {
    return this.inChild(handle, () => this.request(`/session/${this.session}/screenshot`));
  }

  capturePreview(handle) {
    return this.invoke('browser_webview_capture_preview', { request: { label: handle } });
  }
}
