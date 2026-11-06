/** Native companion view. Activity is seeded through its production event contract. */
export class PetPerformancePage {
  constructor(endpoint) { this.endpoint = endpoint; }
  async request(route, body) {
    const response = await fetch(this.endpoint + route, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(45_000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
    return result.value;
  }
  async until(read, label) {
    const start = Date.now();
    let error;
    while (Date.now() - start < 60_000) {
      try { const value = await read(); if (value) return value; } catch (caught) { error = caught; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out: ${label}: ${error ?? 'not ready'}`);
  }
  async connect() { this.session = (await this.request('/session', {})).sessionId; }
  select(handle) { return this.request(`/session/${this.session}/window`, { handle }); }
  execute(fn, ...args) { return this.request(`/session/${this.session}/execute/sync`, { script: fn.toString(), args }); }
  invoke(command, args = {}) { return this.execute((command, args) => window.__TAURI_INTERNALS__.invoke(command, args), command, args); }
  activity(mood, tasks = []) {
    return this.invoke('plugin:event|emit', { event: 'agent-companion://activity-updated',
      payload: { mood, tasks, emittedAt: Date.now(), sequence: Date.now() } });
  }
  async ready() {
    await this.until(() => this.execute(() => !!document.querySelector('[data-openbitfun-part="petdex"]')), 'pet sprite');
    await this.execute(() => {
      window.__petPerf = { mutations: 0 };
      const pet = document.querySelector('[data-openbitfun-component="chat-input-pixel-pet"]');
      new MutationObserver(records => { window.__petPerf.mutations += records.length; })
        .observe(pet, { attributes: true, childList: true, subtree: true });
    });
  }
  snapshot() {
    return this.execute(() => {
      const pet = document.querySelector('[data-openbitfun-part="petdex"]');
      const style = pet && getComputedStyle(pet);
      return { visibility: document.visibilityState, domNodes: document.getElementsByTagName('*').length,
        heap: performance.memory?.usedJSHeapSize ?? null,
        mutations: window.__petPerf?.mutations,
        scripts: [...document.scripts].map(s => s.src).filter(Boolean),
        sprite: pet ? { width: pet.getBoundingClientRect().width, height: pet.getBoundingClientRect().height,
          backgroundImage: style.backgroundImage, x: style.backgroundPositionX, y: style.backgroundPositionY,
          duration: style.animationDuration, name: style.animationName, state: style.animationPlayState,
          inlineStyle: pet.getAttribute('style') } : null,
        animations: document.getAnimations().map(a => ({ name: a.animationName, state: a.playState, time: a.currentTime })),
      };
    });
  }
  cadence() {
    return this.execute(() => new Promise(resolve => {
      const frames = [], positions = new Set();
      const start = performance.now();
      const tick = now => {
        frames.push(now);
        const pet = document.querySelector('[data-openbitfun-part="petdex"]');
        positions.add(getComputedStyle(pet).backgroundPositionX);
        if (now - start < 2600) requestAnimationFrame(tick);
        else resolve({ frames, positions: [...positions] });
      };
      requestAnimationFrame(tick);
    }));
  }
}
