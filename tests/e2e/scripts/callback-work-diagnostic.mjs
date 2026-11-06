/** Diagnostic only: preserves callbacks/IDs, observes work without disabling it. */
export async function startCallbackWorkDiagnostic(page) {
  return page.execute(() => {
    if (window.__callbackWorkDiagnostic) throw new Error('A callback diagnostic is already active');
    const original = { requestAnimationFrame: window.requestAnimationFrame,
      setTimeout: window.setTimeout, setInterval: window.setInterval };
    const groups = new Map(), mutations = new Map(), scrollWrites = new Map();
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const startedAt = performance.now();
    let active = true;
    const wrap = (kind, callback) => {
      if (typeof callback !== 'function') return callback;
      const source = Function.prototype.toString.call(callback);
      const key = `${kind}:${source}`;
      let row = groups.get(key);
      if (!row) {
        row = { kind, source, registrationStack: new Error().stack, registrations: 0, calls: 0, totalMs: 0, maxMs: 0 };
        groups.set(key, row);
      }
      row.registrations++;
      return function (...args) {
        if (!active) return Reflect.apply(callback, this, args);
        const at = performance.now();
        try { return Reflect.apply(callback, this, args); }
        finally {
          const duration = performance.now() - at;
          row.calls++; row.totalMs += duration; row.maxMs = Math.max(row.maxMs, duration);
        }
      };
    };
    const wrapped = {
      requestAnimationFrame: callback => original.requestAnimationFrame.call(window, wrap('raf', callback)),
      setTimeout: (callback, wait, ...args) => original.setTimeout.call(window, wrap('timeout', callback), wait, ...args),
      setInterval: (callback, wait, ...args) => original.setInterval.call(window, wrap('interval', callback), wait, ...args),
    };
    Object.assign(window, wrapped);
    // Observe the native setter without changing its value, ownership or timing
    // policy. The geometry reads add overhead: this is never an acceptance run.
    const scrollTopSetter = scrollTopDescriptor?.set && function (value) {
      if (!active || !this.matches('[data-flowchat-scroller]')) {
        return Reflect.apply(scrollTopDescriptor.set, this, [value]);
      }
      const before = Reflect.apply(scrollTopDescriptor.get, this, []);
      const result = Reflect.apply(scrollTopDescriptor.set, this, [value]);
      const after = Reflect.apply(scrollTopDescriptor.get, this, []);
      const state = { before, requested: value, after, height: this.scrollHeight,
        viewport: this.clientHeight, origin: this.dataset.flowchatScrollOrigin ?? null };
      const key = JSON.stringify(state);
      let row = scrollWrites.get(key);
      if (!row) {
        row = { ...state, calls: 0, firstAt: performance.now(), lastAt: 0, stack: new Error().stack };
        scrollWrites.set(key, row);
      }
      row.calls++; row.lastAt = performance.now();
      return result;
    };
    if (scrollTopSetter) Object.defineProperty(Element.prototype, 'scrollTop', { ...scrollTopDescriptor, set: scrollTopSetter });
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        const owner = element?.closest('[data-openbitfun-component]');
        const key = JSON.stringify({ kind: record.type, attribute: record.attributeName,
          tag: element?.tagName, className: element?.getAttribute('class'), component: owner?.dataset.openbitfunComponent,
          part: owner?.dataset.openbitfunPart });
        mutations.set(key, (mutations.get(key) ?? 0) + 1);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__callbackWorkDiagnostic = { stop: () => {
      active = false;
      observer.disconnect();
      for (const key of Object.keys(original)) if (window[key] === wrapped[key]) window[key] = original[key];
      if (scrollTopSetter && Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')?.set === scrollTopSetter) {
        Object.defineProperty(Element.prototype, 'scrollTop', scrollTopDescriptor);
      }
      return { startedAt, endedAt: performance.now(), callbacks: [...groups.values()].sort((a, b) => b.totalMs - a.totalMs),
        scrollWrites: [...scrollWrites.values()].sort((a, b) => b.calls - a.calls),
        mutations: [...mutations].map(([key, count]) => ({ ...JSON.parse(key), count })).sort((a, b) => b.count - a.count),
        limitation: 'Instrumentation adds overhead; timers registered before observation are not wrapped. Mutation counts are not CPU attribution.' };
    } };
  });
}

export async function stopCallbackWorkDiagnostic(page) {
  return page.execute(() => {
    const result = window.__callbackWorkDiagnostic?.stop();
    delete window.__callbackWorkDiagnostic;
    return result;
  });
}
