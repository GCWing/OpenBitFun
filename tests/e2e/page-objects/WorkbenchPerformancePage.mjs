/** Real product controls through the embedded W3C WebDriver, without importing product stores. */
export class WorkbenchPerformancePage {
  constructor(endpoint) { this.endpoint = endpoint; }

  async request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(this.endpoint + route, {
      method, signal: AbortSignal.timeout(45_000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
    return result.value;
  }

  async connect() { this.session = (await this.request('/session', {})).sessionId; }
  setAutomaticUpdateChecks(enabled) {
    return this.execute(async enabled => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      await invoke('product_control_invoke', { request: {
        action: 'configure', capabilityId: 'setting.application.general', optionId: 'auto-update', value: enabled,
      } });
      const result = await invoke('product_control_invoke', { request: {
        action: 'get', capabilityId: 'setting.application.general',
      } });
      return result.currentOptionValues['auto-update'];
    }, enabled);
  }
  execute(fn, ...args) {
    return this.request(`/session/${this.session}/execute/sync`, { script: fn.toString(), args });
  }
  async until(read, label, timeout = 30_000) {
    const start = Date.now();
    let error;
    while (Date.now() - start < timeout) {
      try { const result = await read(); if (result) return result; } catch (caught) { error = caught; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}: ${error ?? 'not ready'}`);
  }
  async click(selector) {
    const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
    await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  }
  visible(selector) {
    return this.execute(selector => {
      const element = document.querySelector(selector);
      return !!element && element.getBoundingClientRect().width > 0 && element.checkVisibility({ checkVisibilityCSS: true });
    }, selector);
  }
  async ready() {
    await this.until(() => this.execute(() => !!document.querySelector('[data-testid="nav-personal-overview"]')
      && !document.getElementById('openbitfun-startup-overlay')), 'interactive shell');
  }
  readingAnchor() {
    return this.execute(() => {
      const scroller = document.querySelector('[data-flowchat-scroller]');
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll('.virtual-item-wrapper')].find(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > top && rect.top < top + scroller.clientHeight && rect.height > 0;
      });
      return { key: row?.dataset.virtualItemKey, offset: row ? row.getBoundingClientRect().top - top : 0 };
    });
  }
  async snapshot() {
    return this.execute(() => {
      // An element in a detached iframe can remain isConnected to its old
      // document. Walk the owning frames as well so the driver does not retain
      // closed app documents; hidden but mounted frames remain valid.
      const handles = window.__openbitfunWdElements;
      const isLiveHandle = node => {
        if (!node?.isConnected) return false;
        let owner = node.ownerDocument;
        try {
          while (owner && owner !== document) {
            const frame = owner.defaultView?.frameElement;
            if (!frame?.isConnected) return false;
            owner = frame.ownerDocument;
          }
          return owner === document;
        } catch { return false; }
      };
      let releasedDriverHandles = 0;
      if (handles) for (const [key, node] of Object.entries(handles)) if (!isLiveHandle(node)) {
        delete handles[key]; releasedDriverHandles++;
      }
      return {
        releasedDriverHandles,
        domNodes: document.getElementsByTagName('*').length,
        sceneHosts: document.querySelectorAll('[data-testid="scene-viewport-scene"]').length,
        iframes: document.querySelectorAll('iframe').length,
        monacoEditors: document.querySelectorAll('.monaco-editor').length,
        animations: document.getAnimations().map(animation => ({ state: animation.playState,
          visible: animation.effect?.target instanceof Element && animation.effect.target.checkVisibility({ checkVisibilityCSS: true }),
          name: animation.animationName ?? null,
          owner: animation.effect?.target instanceof Element ? animation.effect.target.getAttribute('class') : null,
          scene: animation.effect?.target instanceof Element ? animation.effect.target.closest('[data-scene-id]')?.getAttribute('data-scene-id') : null,
          part: animation.effect?.target?.getAttribute?.('data-motion-part') ?? null,
          duration: animation.effect?.getTiming().duration,
          currentTime: animation.currentTime,
        })),
        resourceBudget: window.__OPENBITFUN_RESOURCE_BUDGET__?.snapshot() ?? null,
        jsHeap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null,
        api: window.__OPENBITFUN_STARTUP_TRACE__?.snapshot()?.api ?? null,
        resources: performance.getEntriesByType('resource').map(entry => ({ name: new URL(entry.name).pathname,
          durationMs: entry.duration, decodedBytes: entry.decodedBodySize })),
      };
    });
  }
  // Run outside timing windows. Sample the actual authored motion at fixed
  // times so a performance change cannot pass by changing its geometry/speed.
  motionSignature() {
    return this.execute(() => {
      const host = document.querySelector('.personal-overview__avatar');
      const animations = host?.getAnimations({ subtree: true }) ?? [];
      const saved = animations.map(animation => ({ animation, startTime: animation.startTime,
        currentTime: animation.currentTime, state: animation.playState }));
      const timing = animations.map(animation => ({ part: animation.effect.target.dataset.motionPart,
        duration: animation.effect.getTiming().duration, iterations: String(animation.effect.getTiming().iterations),
        frames: animation.effect.getKeyframes() }));
      const samples = [];
      try {
        animations.forEach(animation => animation.pause());
        for (let time = 0; time < 1600; time += 40) {
          animations.forEach(animation => { animation.currentTime = time; });
          samples.push({ time, parts: [...(host?.querySelectorAll('rect, path, circle, ellipse') ?? [])].map((element, index) => {
            const style = getComputedStyle(element), matrix = element.getScreenCTM(), box = element.getBBox();
            const origin = host.getBoundingClientRect();
            return { part: `${index}:${element.tagName}`, transform: style.transform, origin: style.transformOrigin,
              opacity: style.opacity, matrix: matrix ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - origin.left, matrix.f - origin.top] : null,
              box: [box.x, box.y, box.width, box.height] };
          }) });
        }
      } finally {
        for (const { animation, startTime, currentTime, state } of saved) {
          animation.currentTime = currentTime;
          if (state === 'running') { animation.play(); animation.startTime = startTime; }
        }
      }
      return { timing, samples };
    });
  }
  async measureOpen(trigger, rootSelector) {
    await this.execute((trigger, rootSelector) => {
      let start, frame, finished = false, presentedPending = false, dataPending = false;
      const result = { rootSelector, frames: [], loadingFrames: 0, missingFrames: 0, milestones: {}, errors: [] };
      const clicked = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) start ??= performance.now();
      };
      document.addEventListener('click', clicked, true);
      const tick = time => {
        if (start !== undefined) {
          const elapsed = time - start;
          result.frames.push(elapsed);
          const root = document.querySelector(rootSelector);
          const visible = root && root.checkVisibility({ checkVisibilityCSS: true }) && root.getBoundingClientRect().width > 0;
          if (visible) {
            result.milestones.visibleMs ??= elapsed;
            if (!presentedPending) {
              presentedPending = true;
              requestAnimationFrame(() => requestAnimationFrame(() => { result.milestones.presentedMs = performance.now() - start; }));
            }
            const loading = root.querySelector('[aria-busy="true"], .gallery-skeleton, .gallery-skeleton-card, [data-openbitfun-part="loading"], .config-loading-state, .history-session-loading:not([data-history-loading-phase="idle"])');
            if (loading) result.loadingFrames++;
            if (!loading && !dataPending) {
              dataPending = true;
              requestAnimationFrame(() => {
                if (root.isConnected && !root.querySelector('[aria-busy="true"], .gallery-skeleton, .gallery-skeleton-card, [data-openbitfun-part="loading"], .config-loading-state')) {
                  result.milestones.contentMs ??= performance.now() - start;
                } else dataPending = false;
              });
            }
          } else result.missingFrames++;
          if (elapsed >= 700 && result.milestones.contentMs !== undefined || elapsed >= 15_000) {
            finished = true;
            result.durationMs = elapsed;
            result.errors = [...(root?.querySelectorAll('[role="alert"]') ?? [])].map(el => el.textContent?.slice(0, 240));
            document.removeEventListener('click', clicked, true);
            return;
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      window.__workbenchPerf = { result, done: () => finished, dispose: () => {
        cancelAnimationFrame(frame); document.removeEventListener('click', clicked, true);
      } };
    }, trigger, rootSelector);
    try {
      await this.click(trigger);
      await this.until(() => this.execute(() => window.__workbenchPerf.done()), rootSelector, 20_000);
      return await this.execute(() => window.__workbenchPerf.result);
    } finally {
      await this.execute(() => { window.__workbenchPerf?.dispose(); delete window.__workbenchPerf; });
    }
  }
  async drag(selector, axis, distance = 160, steps = 60, pointerEvents = true) {
    const point = await this.execute(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, selector);
    await this.execute((selector, axis) => {
      const frames = [], positions = []; let frame;
      const tick = time => {
        frames.push(time);
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        if (rect) positions.push(axis === 'x' ? rect.x : rect.y);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      window.__workbenchDrag = { stop: () => { cancelAnimationFrame(frame); return { frames, positions }; } };
    }, selector, axis);
    const moves = Array.from({ length: steps }, (_, i) => ({ type: 'pointerMove', origin: 'viewport', duration: 16,
      x: point.x + (axis === 'x' ? Math.round(Math.sin((i + 1) / steps * Math.PI * 2) * distance) : 0),
      y: point.y + (axis === 'y' ? Math.round(Math.sin((i + 1) / steps * Math.PI * 2) * distance) : 0) }));
    try {
      if (pointerEvents) {
        // The embedded driver's W3C actions currently emit MouseEvent only.
        // Exercise the production PointerEvent handlers in the real WebView.
        // Native capture is neither replaced nor mocked; geometry must change.
        await this.execute(async (selector, point, moves) => {
          const target = document.querySelector(selector);
          const dispatch = (type, position, buttons) => target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
            clientX: position.x, clientY: position.y, button: 0, buttons,
          }));
          dispatch('pointerdown', point, 1);
          try {
            for (const move of moves) {
              await new Promise(resolve => setTimeout(resolve, move.duration));
              dispatch('pointermove', move, 1);
            }
          } finally { dispatch('pointerup', moves.at(-1), 0); }
        }, selector, point, moves);
      } else await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'pointer', id: 'workbench-resize',
        parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', origin: 'viewport', ...point }, { type: 'pointerDown', button: 0 },
          ...moves, { type: 'pointerUp', button: 0 },
        ] }] });
      return await this.execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const frames = window.__workbenchDrag.stop(); delete window.__workbenchDrag; resolve(frames);
      }))));
    } finally { await this.request(`/session/${this.session}/actions`, undefined, 'DELETE'); }
  }
}
