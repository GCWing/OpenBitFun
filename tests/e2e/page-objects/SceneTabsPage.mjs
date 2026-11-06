import { SceneVisibilityPage } from './SceneVisibilityPage.mjs';

export class SceneTabsPage extends SceneVisibilityPage {
  async prepareNavigation() {
    const origin = await this.execute(() => {
      localStorage.setItem('openbitfun:appearance:sidebar', JSON.stringify({ version: 1,
        pinnedIds: ['builtin.todos', 'builtin.agents', 'builtin.assistants', 'builtin.skills.installed', 'builtin.insights'] }));
      return performance.timeOrigin;
    });
    await this.request(`/session/${this.session}/refresh`, {});
    await this.until(() => this.execute(previous => performance.timeOrigin !== previous, origin), 'new navigation document');
    await this.ready();
    await this.until(() => this.visible('[data-testid="nav-builtin.agents"]'), 'fixture pinned navigation');
  }

  tabsSnapshot() {
    return this.execute(() => {
      const tabs = document.querySelector('[data-scene-bar-part="tabs"]');
      const box = tabs.getBoundingClientRect();
      return { left: tabs.scrollLeft, width: tabs.clientWidth, extent: tabs.scrollWidth,
        viewportWidth: innerWidth,
        tabs: [...tabs.querySelectorAll('[role="tab"]')].map(tab => {
          const item = tab.closest('[data-openbitfun-part="item"]'), rect = item.getBoundingClientRect();
          return { id: tab.dataset.openbitfunValue, selected: tab.getAttribute('aria-selected') === 'true',
            focused: tab === document.activeElement, left: rect.left - box.left, right: rect.right - box.left };
        }) };
    });
  }

  async pressTabKey(key) {
    await this.execute(key => {
      const tabs = document.querySelector('[data-scene-bar-part="tabs"]');
      const selected = tabs.querySelector('[role="tab"][aria-selected="true"]');
      selected.focus({ preventScroll: true });
      selected.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
      selected.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
    }, key);
  }

  async traceScroll(action) {
    await this.execute(() => {
      const frames = []; let raf, done = false, start = performance.now();
      const tick = time => {
        frames.push({ time: time - start, left: document.querySelector('[data-scene-bar-part="tabs"]').scrollLeft });
        if (time - start < 800) raf = requestAnimationFrame(tick); else done = true;
      };
      raf = requestAnimationFrame(tick);
      window.__sceneTabScroll = { frames, done: () => done, stop: () => cancelAnimationFrame(raf) };
    });
    try {
      await action();
      await this.until(() => this.execute(() => window.__sceneTabScroll.done()), 'tab scrolling');
      return await this.execute(() => window.__sceneTabScroll.frames);
    } finally {
      await this.execute(() => { window.__sceneTabScroll?.stop(); delete window.__sceneTabScroll; });
    }
  }

  async wheelTabs(deltaY) {
    const point = await this.execute(() => {
      const box = document.querySelector('[data-scene-bar-part="tabs"]').getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    });
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'scene-tab-wheel',
      actions: [{ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 100 }] }] });
  }
}
