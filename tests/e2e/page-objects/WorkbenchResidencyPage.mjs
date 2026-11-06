import { WorkbenchPerformancePage } from './WorkbenchPerformancePage.mjs';

export class WorkbenchResidencyPage extends WorkbenchPerformancePage {
  async openWorkspaceMenu(workspaceId) {
    const selector = `[data-testid="nav-workspace-card"][data-workspace-id=${JSON.stringify(workspaceId)}]`;
    await this.until(() => this.visible(selector), 'workspace card');
    const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
    // Use the card's real context menu. Its overflow button is intentionally
    // invisible until hover/focus, so visibility is not a hydration signal.
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'pointer', id: 'workspace-context-menu',
      parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', origin: element, x: 0, y: 0, duration: 0 },
        { type: 'pointerDown', button: 2 }, { type: 'pointerUp', button: 2 },
      ],
    }] });
    await this.until(() => this.visible('[data-testid="nav-workspace-menu-open-directory"]'), 'workspace context menu');
  }
  invoke(command, request) {
    return this.execute((command, request) => window.__TAURI_INTERNALS__.invoke(command, request), command, request);
  }
  async residencySnapshot() {
    const base = await this.snapshot();
    const retained = await this.execute(() => ({
      documentHidden: document.hidden,
      documentHasFocus: document.hasFocus(),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      scenes: [...document.querySelectorAll('[data-testid="scene-viewport-scene"]')].map(node => ({
        id: node.dataset.sceneId, active: node.dataset.sceneActive, descendants: node.querySelectorAll('*').length,
      })),
      terminalIds: [...document.querySelectorAll('.openbitfun-terminal[data-session-id]')].map(node => node.dataset.sessionId),
      tabs: [...document.querySelectorAll('.openbitfun-scene-bar__item[data-scene-tab-id]')].map(node => node.dataset.sceneTabId),
      draft: document.querySelector('[data-testid="chat-input-textarea"]')?.textContent ?? null,
      canvases: document.querySelectorAll('canvas').length,
      driverHandles: Object.keys(window.__openbitfunWdElements ?? {}).length,
    }));
    return { ...base, ...retained };
  }
  async enterDraft(text) {
    const element = await this.request(`/session/${this.session}/element`, {
      using: 'css selector', value: '[data-testid="chat-input-textarea"]',
    });
    await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
  }
  async closeClosableTabs() {
    const closed = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const id = await this.execute(() => [...document.querySelectorAll('[data-scene-bar-part="closeTab"]')]
        .map(node => node.dataset.sceneId).find(id => id !== 'personal-overview'));
      if (!id) return closed;
      const selector = `[data-scene-bar-part="closeTab"][data-scene-id=${JSON.stringify(id)}]`;
      // The close icon can be hidden until hover. Select its visible tab and
      // use the product's Delete shortcut instead of clicking a hidden target.
      const tabSelector = `[role="tab"][data-openbitfun-value=${JSON.stringify(id)}]`;
      await this.click(tabSelector);
      await this.execute(tabSelector => {
        const tab = document.querySelector(tabSelector);
        if (!tab || !tab.checkVisibility({ checkVisibilityCSS: true }) || tab.closest('[inert]')) {
          throw new Error('The tab must be interactive before closing it');
        }
        tab.focus({ preventScroll: true });
        tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true }));
        tab.dispatchEvent(new KeyboardEvent('keyup', { key: 'Delete', code: 'Delete', bubbles: true }));
      }, tabSelector);
      await this.until(() => this.execute(selector => !document.querySelector(selector), selector), `closed ${id}`);
      closed.push(id);
    }
    throw new Error('Close controls did not exhaust the finite fixture tabs');
  }
}
