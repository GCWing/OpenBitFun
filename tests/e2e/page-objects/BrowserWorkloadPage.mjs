import assert from 'node:assert/strict';
import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

export class BrowserWorkloadPage extends WorkbenchResidencyPage {
  trigger(sessionId) { return `[data-testid="nav-session-item"][data-session-id=${JSON.stringify(sessionId)}]`; }
  async inChild(handle, action) {
    await this.request(`/session/${this.session}/window`, { handle });
    try { return await action(); }
    finally { await this.request(`/session/${this.session}/window`, { handle: 'main' }); }
  }
  childState(handle) { return this.inChild(handle, () => this.execute(() => window.workloadSnapshot?.() ?? null)); }
  async tool(action, params = {}) {
    const result = await this.invoke('execute_tool', { request: { toolName: 'ControlHub', input: { domain: 'browser', action, params } } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.result?.ok, true, JSON.stringify(result));
    return result.result.data;
  }
  async configure({ url, workspace, sessions }) {
    const models = await this.invoke('get_config', { request: { path: 'ai.models' } });
    await this.invoke('set_config', { request: { path: 'ai.models', expectedModels: models, value: [{
      id: 'browser-workload', name: 'Browser workload', provider: 'anthropic', model_name: 'browser-workload',
      base_url: url, request_url: `${url}/v1/messages`, api_key: 'isolated-loopback-fixture', auth: { type: 'api_key' },
      enabled: true, context_window: 128000, max_tokens: 1024, capabilities: ['text_chat', 'function_calling'],
    }] } });
    for (const [path, value] of [
      ['ai.default_models', { primary: 'browser-workload', fast: 'browser-workload' }],
      ['ai.enable_deferred_tool_loading', false], ['app.ai_experience.enable_session_title_generation', false],
      ['app.ai_experience.enable_welcome_panel_ai_analysis', false], ['app.ai_experience.enable_prompt_suggestion', false],
    ]) await this.invoke('set_config', { request: { path, value } });
    const current = await this.invoke('get_current_workspace', { request: {} });
    for (const sessionId of sessions) await this.invoke('create_session', { request: {
      sessionId, sessionName: sessionId, agentType: 'agentic', workspacePath: workspace, workspaceId: current.id,
      config: { modelName: 'browser-workload', safeMode: false },
    } });
    const origin = await this.execute(() => performance.timeOrigin);
    await this.request(`/session/${this.session}/refresh`, {});
    await this.until(() => this.execute(old => performance.timeOrigin !== old, origin), 'new workload document');
    await this.ready();
    for (const id of sessions) await this.until(() => this.visible(this.trigger(id)), `session ${id}`);
  }
  async select(sessionId) {
    await this.click(this.trigger(sessionId));
    await this.until(() => this.visible('[data-testid="chat-input-textarea"]'), 'session composer');
  }
  async closePresentation({ sessionId, handle }) {
    await this.select(sessionId);
    const root = `[data-webview-label=${JSON.stringify(handle)}]`;
    await this.until(() => this.visible(root), 'selected browser presentation');
    const tab = '.canvas-tab[data-tab-type="browser"]';
    await this.click(`${tab} [data-openbitfun-product-part="action"]`);
    await this.until(() => this.execute(selector => !document.querySelector(selector), tab), 'closed browser presentation tab');
  }
  async activate({ sessionId, handle }, trigger = this.trigger(sessionId)) {
    await this.inChild(handle, () => this.execute(() => {
      const probe = { visibilityAt: null, presentedAt: null, frames: [] };
      const visible = () => {
        if (document.visibilityState !== 'visible' || probe.visibilityAt !== null) return;
        probe.visibilityAt = Date.now();
        requestAnimationFrame(() => requestAnimationFrame(() => { probe.presentedAt = Date.now(); }));
      };
      document.addEventListener('visibilitychange', visible);
      window.__browserPresentation = { probe, dispose: () => document.removeEventListener('visibilitychange', visible) };
    }));
    await this.execute(trigger => {
      const clicked = event => { if (event.target instanceof Element && event.target.closest(trigger)) window.__browserClick.at ??= Date.now(); };
      window.__browserClick = { at: null, dispose: () => document.removeEventListener('click', clicked, true) };
      document.addEventListener('click', clicked, true);
    }, trigger);
    try {
      const panel = await this.measureOpen(trigger, `[data-webview-label=${JSON.stringify(handle)}]`);
      const clickAt = await this.execute(() => window.__browserClick.at);
      const child = await this.until(() => this.inChild(handle, () => this.execute(() =>
        window.__browserPresentation.probe.presentedAt !== null && window.__browserPresentation.probe)), 'native child presentation');
      assert.ok(child.visibilityAt >= clickAt, 'Child must become visible after the session click');
      return { ...panel, nativeVisibilityMs: child.visibilityAt - clickAt, nativePresentationMs: child.presentedAt - clickAt };
    } finally {
      await this.execute(() => { window.__browserClick?.dispose(); delete window.__browserClick; });
      await this.inChild(handle, () => this.execute(() => { window.__browserPresentation?.dispose(); delete window.__browserPresentation; }));
    }
  }
  async typeChunks(selector, chunks, intervalMs = 80) {
    const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
    for (const text of chunks) {
      await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  async scrollChild(steps = 24, deltaY = 320) {
    const point = await this.execute(() => ({ x: Math.floor(innerWidth / 2), y: Math.floor(innerHeight * .8) }));
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'browser-reader',
      actions: Array.from({ length: steps }, () => ({ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 16 })),
    }] });
  }
  startChildProbe() {
    return this.execute(() => {
      const frames = [], inputRafMs = [], wheelTimes = [], pending = new Set(); let frame;
      const tick = at => { frames.push(at); frame = requestAnimationFrame(tick); };
      const input = () => { const start = performance.now(); const id = requestAnimationFrame(() => {
        pending.delete(id); inputRafMs.push(performance.now() - start);
      }); pending.add(id); };
      const wheel = () => wheelTimes.push(performance.now());
      document.addEventListener('input', input, true); document.addEventListener('wheel', wheel, true);
      frame = requestAnimationFrame(tick);
      window.__browserInteraction = { stop: () => {
        cancelAnimationFrame(frame); pending.forEach(id => cancelAnimationFrame(id));
        document.removeEventListener('input', input, true); document.removeEventListener('wheel', wheel, true);
        return { frames, inputRafMs, wheelTimes };
      } };
    });
  }
  stopChildProbe() {
    return this.execute(() => { const raw = window.__browserInteraction.stop(); delete window.__browserInteraction; return raw; });
  }
}
