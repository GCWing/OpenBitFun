import { SceneVisibilityPage } from './SceneVisibilityPage.mjs';

/** Low-overhead probes; no patched product timers, layout APIs or rendering. */
export class ConcurrentWorkloadPage extends SceneVisibilityPage {
  async waitForUnfocusedWindow() {
    const startedAt = Date.now();
    await this.until(async () => !await this.invoke('plugin:window|is_focused', { label: 'main' })
      && await this.execute(() => !document.hasFocus() && !document.hidden), 'visible unfocused main window');
    return { waitMs: Date.now() - startedAt, native: false, document: false };
  }
  startWindowStateProbe() {
    return this.execute(() => {
      if (window.__concurrentWindowState) throw new Error('Window state probe already active');
      const samples = [];
      const record = reason => samples.push({ at: performance.now(), reason,
        documentHasFocus: document.hasFocus(), documentHidden: document.hidden });
      const focus = event => { if (event.target === window) record(event.type); };
      const visibility = () => record('visibilitychange');
      window.addEventListener('focus', focus); window.addEventListener('blur', focus);
      document.addEventListener('visibilitychange', visibility);
      record('start');
      window.__concurrentWindowState = { stop: () => {
        record('end'); window.removeEventListener('focus', focus); window.removeEventListener('blur', focus);
        document.removeEventListener('visibilitychange', visibility); return samples;
      } };
    });
  }
  stopWindowStateProbe() {
    return this.execute(() => {
      const samples = window.__concurrentWindowState?.stop();
      delete window.__concurrentWindowState; return samples;
    });
  }
  async residencySnapshot() {
    const snapshot = await super.residencySnapshot();
    return { ...snapshot, nativeWindowFocused: await this.invoke('plugin:window|is_focused', { label: 'main' }) };
  }
  startRuntimeStatusProbe() {
    return this.execute(() => {
      if (window.__runtimeStatusProbe) throw new Error('A runtime status probe is already active');
      const samples = [];
      let frame;
      const tick = () => {
        const root = document.querySelector('[data-scene-active="true"] .runtime-status-slot--footer');
        const content = root?.querySelector('.runtime-status-slot__content');
        const spinner = root?.querySelector('[data-openbitfun-component="spinner"]');
        if (content) {
          const style = getComputedStyle(content);
          samples.push({ at: performance.now(), visible: root.dataset.runtimeStatusVisible,
            opacity: Number(style.opacity), transform: style.transform, height: content.getBoundingClientRect().height,
            active: spinner?.dataset.active,
            transitions: content.getAnimations().map(animation => ({ state: animation.playState,
              duration: animation.effect?.getTiming().duration, property: animation.transitionProperty })),
            glyphAnimations: spinner?.getAnimations({ subtree: true }).map(animation => ({ state: animation.playState,
              duration: animation.effect?.getTiming().duration })) ?? [],
          });
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      window.__runtimeStatusProbe = { stop: () => { cancelAnimationFrame(frame); return samples; } };
    });
  }
  stopRuntimeStatusProbe() {
    return this.execute(() => {
      const samples = window.__runtimeStatusProbe?.stop();
      delete window.__runtimeStatusProbe;
      return samples;
    });
  }
  startInteractionProbe() {
    return this.execute(() => {
      if (window.__concurrentWorkloadProbe) throw new Error('An interaction probe is already active');
      const frames = [], inputRafMs = [], inputEvents = [], wheelTimes = [];
      const inputFrames = new Set();
      let frame, active = true;
      const tick = time => { frames.push(time); frame = requestAnimationFrame(tick); };
      const input = event => {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest('[data-testid="chat-input-textarea"]')) return;
        const at = performance.now();
        inputEvents.push({ at, inputType: event.inputType, composing: event.isComposing });
        const id = requestAnimationFrame(() => {
          inputFrames.delete(id);
          if (active) inputRafMs.push(performance.now() - at);
        });
        inputFrames.add(id);
      };
      document.addEventListener('input', input, true);
      const wheel = () => wheelTimes.push(performance.now());
      document.addEventListener('wheel', wheel, true);
      frame = requestAnimationFrame(tick);
      window.__concurrentWorkloadProbe = { stop: () => {
        active = false;
        cancelAnimationFrame(frame); inputFrames.forEach(id => cancelAnimationFrame(id));
        document.removeEventListener('input', input, true);
        document.removeEventListener('wheel', wheel, true);
        return { frames, inputRafMs, inputEvents, wheelTimes, endedAt: performance.now() };
      } };
    });
  }
  stopInteractionProbe() {
    return this.execute(() => {
      const result = window.__concurrentWorkloadProbe?.stop();
      delete window.__concurrentWorkloadProbe;
      return result;
    });
  }
  async scrollTranscript(deltaY, steps = 24) {
    const point = await this.execute(() => {
      const root = document.querySelector('[data-flowchat-scroller]');
      if (!root?.checkVisibility({ checkVisibilityCSS: true })) throw new Error('Transcript is not visible');
      const rect = root.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'concurrent-reader',
      actions: Array.from({ length: steps }, () => ({ type: 'scroll', origin: 'viewport', ...point,
        deltaX: 0, deltaY, duration: 16 })),
    }] });
  }
  async typeDraftChunks(chunks, intervalMs = 80) {
    const element = await this.request(`/session/${this.session}/element`, {
      using: 'css selector', value: '[data-testid="chat-input-textarea"]',
    });
    const commandMs = [];
    for (const text of chunks) {
      const start = performance.now();
      await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
      commandMs.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return commandMs;
  }
  async configureLiveSession({ url, sessionId, workspace }) {
    const models = await this.invoke('get_config', { request: { path: 'ai.models' } });
    await this.invoke('set_config', { request: { path: 'ai.models', expectedModels: models, value: [{
      id: 'concurrent-workload', name: 'Concurrent workload', provider: 'anthropic', model_name: 'concurrent-workload',
      base_url: url, request_url: `${url}/v1/messages`, api_key: 'isolated-loopback-fixture',
      auth: { type: 'api_key' }, enabled: true, context_window: 128000, max_tokens: 32000,
      capabilities: ['text_chat', 'function_calling'],
    }] } });
    for (const [path, value] of [
      ['ai.default_models', { primary: 'concurrent-workload', fast: 'concurrent-workload' }],
      ['ai.enable_deferred_tool_loading', false],
      ['app.ai_experience.enable_session_title_generation', false],
      ['app.ai_experience.enable_welcome_panel_ai_analysis', false],
      ['app.ai_experience.enable_prompt_suggestion', false],
    ]) await this.invoke('set_config', { request: { path, value } });
    const current = await this.invoke('get_current_workspace', { request: {} });
    await this.invoke('create_session', { request: { sessionId, sessionName: sessionId, agentType: 'agentic',
      workspacePath: workspace, workspaceId: current.id, config: { modelName: 'concurrent-workload', safeMode: false } } });
    const previousDocument = await this.execute(() => performance.timeOrigin);
    await this.request(`/session/${this.session}/refresh`, {});
    // The embedded refresh command may return while the old document still
    // passes shell readiness. Wait for the new document before querying UI.
    await this.until(() => this.execute(previous => performance.timeOrigin !== previous, previousDocument), 'new session document');
    await this.ready();
    const trigger = `[data-testid="nav-session-item"][data-session-id=${JSON.stringify(sessionId)}]`;
    await this.until(() => this.visible(trigger), 'created session navigation');
    await this.click(trigger);
    await this.until(() => this.visible('[data-testid="chat-input-textarea"]'), 'live composer');
    const toggle = '[data-testid="workbench-toggle-panel"]';
    if (await this.execute(selector => document.querySelector(selector)?.getAttribute('aria-pressed') !== 'true', toggle)) await this.click(toggle);
    if (await this.execute(() => document.querySelectorAll('.monaco-editor').length)) {
      throw new Error('Concurrent workload must not open the excluded file editor');
    }
    return { workspaceId: current.id, trigger };
  }
  scrollPosition() {
    return this.execute(() => {
      const node = document.querySelector('[data-flowchat-scroller]');
      return node ? { top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight,
        following: !document.querySelector('.scroll-to-latest-bar[data-visible="true"]') } : null;
    });
  }
  async cancelTurn() {
    await this.execute(() => {
      let started, frame, elapsedMs;
      const click = event => {
        if (event.target instanceof Element && event.target.closest('[data-testid="chat-input-cancel-btn"]')) started = performance.now();
      };
      const tick = () => {
        if (started !== undefined && !document.querySelector('[data-testid="chat-input-cancel-btn"]')
          ?.checkVisibility({ checkVisibilityCSS: true })) elapsedMs = performance.now() - started;
        else frame = requestAnimationFrame(tick);
      };
      document.addEventListener('pointerdown', click, true); frame = requestAnimationFrame(tick);
      window.__concurrentCancel = { result: () => elapsedMs, dispose: () => {
        cancelAnimationFrame(frame); document.removeEventListener('pointerdown', click, true);
      } };
    });
    try {
      await this.click('[data-testid="chat-input-cancel-btn"]');
      await this.until(() => this.execute(() => window.__concurrentCancel.result() !== undefined), 'cancelled UI', 30_000);
      return await this.execute(() => window.__concurrentCancel.result());
    } finally { await this.execute(() => { window.__concurrentCancel?.dispose(); delete window.__concurrentCancel; }); }
  }
  draftText() {
    return this.execute(() => document.querySelector('[data-testid="chat-input-textarea"]')?.textContent ?? null);
  }
  streamPresentation() {
    return this.execute(() => {
      const text = [...document.querySelectorAll('.flow-text-block[data-streaming="true"]')]
        .filter(node => node.checkVisibility({ checkVisibilityCSS: true }));
      return { activeTextBlocks: text.length, characters: text.reduce((sum, node) => sum + (node.textContent?.length ?? 0), 0),
        mountedRows: document.querySelectorAll('.virtual-item-wrapper').length,
        cancelVisible: !!document.querySelector('[data-testid="chat-input-cancel-btn"]')?.checkVisibility({ checkVisibilityCSS: true }),
      };
    });
  }
  animationOwners() {
    return this.execute(() => document.getAnimations().filter(animation => animation.playState === 'running').map(animation => {
      const target = animation.effect?.target;
      const ancestors = [];
      for (let node = target; node instanceof Element && ancestors.length < 10; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestors.push({ tag: node.tagName, class: node.getAttribute('class'), testId: node.getAttribute('data-testid'),
          component: node.getAttribute('data-openbitfun-component'), part: node.getAttribute('data-openbitfun-part'),
          role: node.getAttribute('role'), label: node.getAttribute('aria-label'), busy: node.getAttribute('aria-busy'),
          runtimeStatusVisible: node.getAttribute('data-runtime-status-visible'), ariaHidden: node.getAttribute('aria-hidden'),
          opacity: style.opacity, visibility: style.visibility, display: style.display });
      }
      return { duration: animation.effect?.getTiming().duration, ancestors };
    }));
  }
}
