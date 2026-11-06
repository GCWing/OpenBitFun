import assert from 'node:assert/strict';
import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

export class MiniAppWorkloadPage extends WorkbenchResidencyPage {
  frame(id) { return `iframe[data-app-id=${JSON.stringify(id)}][data-run-scope="active"]`; }
  root(id) { return `[data-openbitfun-scene="miniapp"][data-miniapp-id=${JSON.stringify(id)}]`; }
  tab(id) { return `[role="tab"][data-openbitfun-value=${JSON.stringify(`miniapp:${id}`)}]`; }
  launch(id) { return `[data-market-key=${JSON.stringify(`local:${id}`)}] button:has(.miniapp-installed-card__launch-icon)`; }

  async prepareNavigation() {
    const origin = await this.execute(() => {
      localStorage.setItem('openbitfun:appearance:sidebar', JSON.stringify({ version: 1, pinnedIds: ['builtin.miniapps'] }));
      return performance.timeOrigin;
    });
    await this.request(`/session/${this.session}/refresh`, {});
    await this.until(() => this.execute(before => performance.timeOrigin !== before, origin), 'new fixture navigation document');
    await this.ready();
    await this.until(() => this.visible('[data-testid="nav-builtin.miniapps"]'), 'pinned MiniApps navigation');
  }

  async install(requests) {
    const installed = [];
    for (const request of requests) {
      const app = await this.invoke('create_miniapp', { request });
      assert.ok(app.id);
      installed.push({ id: app.id, name: app.name });
    }
    return installed;
  }

  async openGallery() {
    const tab = '[role="tab"][data-openbitfun-value="miniapps"]';
    await this.click(await this.visible(tab) ? tab : '[data-testid="nav-builtin.miniapps"]');
    await this.until(() => this.visible('[data-openbitfun-scene="miniapp-gallery"]'), 'MiniApp gallery');
  }

  installedIds() {
    return this.execute(() => [...document.querySelectorAll('[data-market-key^="local:"]')]
      .map(node => node.dataset.marketKey.slice(6)));
  }

  async measureGallery(ids) {
    const trigger = '[data-testid="nav-builtin.miniapps"]';
    await this.execute((trigger, ids) => {
      let started, frame, previousReady = false;
      const result = { contentMs: null };
      const clicked = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) started ??= performance.now();
      };
      const tick = () => {
        const gallery = document.querySelector('[data-openbitfun-scene="miniapp-gallery"]');
        if (started !== undefined && gallery?.checkVisibility({ checkVisibilityCSS: true })) {
          const loaded = new Set([...gallery.querySelectorAll('[data-market-key^="local:"]')].map(node => node.dataset.marketKey.slice(6)));
          const ready = ids.every(id => loaded.has(id));
          if (ready && previousReady) result.contentMs = performance.now() - started;
          previousReady = ready;
        } else previousReady = false;
        if (result.contentMs === null) frame = requestAnimationFrame(tick);
      };
      document.addEventListener('click', clicked, true); frame = requestAnimationFrame(tick);
      window.__miniappCatalogPresentation = { result, dispose: () => {
        cancelAnimationFrame(frame); document.removeEventListener('click', clicked, true);
      } };
    }, trigger, ids);
    try {
      const panel = await this.measureOpen(trigger, '[data-openbitfun-scene="miniapp-gallery"]');
      const content = await this.until(() => this.execute(() => {
        const result = window.__miniappCatalogPresentation.result;
        return result.contentMs !== null && result;
      }), 'populated installed app catalog');
      return { ...panel, populatedContentMs: content.contentMs };
    } finally {
      await this.execute(() => { window.__miniappCatalogPresentation?.dispose(); delete window.__miniappCatalogPresentation; });
    }
  }

  async inApp(id, action) {
    const frame = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: this.frame(id) });
    await this.request(`/session/${this.session}/frame`, { id: frame });
    try { return await action(); }
    finally { await this.request(`/session/${this.session}/frame`, { id: null }); }
  }

  state(id) {
    return this.execute(selector => {
      const frame = document.querySelector(selector);
      const state = frame?.contentWindow?.workloadSnapshot?.();
      return state ? { ...state, visible: frame.checkVisibility({ checkVisibilityCSS: true }),
        active: frame.closest('[data-testid="scene-viewport-scene"]')?.dataset.sceneActive } : null;
    }, this.frame(id));
  }

  async residencySnapshot() {
    const snapshot = await super.residencySnapshot();
    snapshot.miniapps = await this.execute(() => [...document.querySelectorAll('iframe[data-app-id][data-run-scope="active"]')]
      .map(frame => ({ id: frame.dataset.appId, ...frame.contentWindow?.workloadSnapshot?.(),
        visible: frame.checkVisibility({ checkVisibilityCSS: true }) })));
    return snapshot;
  }

  async measureApp(id, trigger = this.tab(id)) {
    await this.execute((trigger, selector) => {
      let started, frame, childFrame, childWindow, pending = false;
      const result = { contentMs: null };
      const clicked = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) started ??= performance.now();
      };
      const tick = () => {
        const target = document.querySelector(selector), content = target?.contentWindow;
        const state = content?.workloadSnapshot?.();
        if (started !== undefined && !pending && state?.ready && state.messages > 0
          && target.checkVisibility({ checkVisibilityCSS: true }) && target.getBoundingClientRect().width > 0) {
          pending = true;
          childWindow = content;
          childFrame = content.requestAnimationFrame(() => {
            childFrame = content.requestAnimationFrame(() => {
              if (target.isConnected && target.checkVisibility({ checkVisibilityCSS: true })) result.contentMs = performance.now() - started;
              else pending = false;
            });
          });
        }
        if (result.contentMs === null) frame = requestAnimationFrame(tick);
      };
      document.addEventListener('click', clicked, true); frame = requestAnimationFrame(tick);
      window.__miniappPresentation = { result, dispose: () => {
        cancelAnimationFrame(frame); childWindow?.cancelAnimationFrame(childFrame);
        document.removeEventListener('click', clicked, true);
      } };
    }, trigger, this.frame(id));
    try {
      const panel = await this.measureOpen(trigger, this.root(id));
      const content = await this.until(() => this.execute(() =>
        window.__miniappPresentation.result.contentMs !== null && window.__miniappPresentation.result), 'live MiniApp content', 30000);
      const state = await this.state(id);
      assert.ok(state?.ready && state.worker?.pid > 0 && state.messages > 0, 'Real Worker RPC and pushed data must arrive');
      assert.deepEqual(state.errors, []);
      return { ...panel, frameContentMs: content.contentMs, state };
    } finally {
      await this.execute(() => { window.__miniappPresentation?.dispose(); delete window.__miniappPresentation; });
    }
  }

  async typeChunks(chunks, intervalMs = 80) {
    const input = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: '#draft' });
    for (const text of chunks) {
      await this.request(`/session/${this.session}/element/${input['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  async scrollApp(steps = 24, deltaY = 320) {
    const point = await this.execute(() => ({ x: Math.floor(innerWidth / 2), y: Math.floor(innerHeight * .8) }));
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'miniapp-reader',
      actions: Array.from({ length: steps }, () => ({ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 16 })),
    }] });
  }

  async compute(times) {
    for (let index = 0; index < times; index++) {
      const before = await this.execute(() => window.workloadSnapshot().computations);
      await this.click('#compute');
      await this.until(() => this.execute(before => window.workloadSnapshot().computations > before, before), 'Worker computation');
    }
  }

  startProbe() {
    return this.execute(() => {
      const frames = [], inputRafMs = [], wheelTimes = [], pending = new Set(); let frame;
      const tick = time => { frames.push(time); frame = requestAnimationFrame(tick); };
      const input = () => { const start = performance.now(); const id = requestAnimationFrame(() => {
        pending.delete(id); inputRafMs.push(performance.now() - start);
      }); pending.add(id); };
      const wheel = () => wheelTimes.push(performance.now());
      document.addEventListener('input', input, true); document.addEventListener('wheel', wheel, true);
      frame = requestAnimationFrame(tick);
      window.__miniappInteraction = { stop: () => {
        cancelAnimationFrame(frame); pending.forEach(id => cancelAnimationFrame(id));
        document.removeEventListener('input', input, true); document.removeEventListener('wheel', wheel, true);
        return { frames, inputRafMs, wheelTimes };
      } };
    });
  }

  stopProbe() {
    return this.execute(() => { const result = window.__miniappInteraction.stop(); delete window.__miniappInteraction; return result; });
  }

  async closeApp(id) {
    await this.click(`[data-scene-bar-part="closeTab"][data-scene-id=${JSON.stringify(`miniapp:${id}`)}]`);
    await this.until(() => this.execute(selector => !document.querySelector(selector), this.frame(id)), 'removed MiniApp frame');
    await this.until(async () => !(await this.invoke('miniapp_worker_list_running')).includes(id), 'stopped MiniApp Worker');
  }
}
