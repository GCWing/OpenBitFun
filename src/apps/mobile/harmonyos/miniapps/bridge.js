// Mobile adapter for the existing public MiniApp API. No desktop or network calls.
(() => {
  const pending = new Map();
  const localeHandlers = [];
  let sequence = 0;
  let locale = window.__miniappLocale || 'en-US';
  let unsupported = '';
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = `local-${++sequence}`;
    pending.set(id, { resolve, reject });
    parent.postMessage({ id, method, params }, '*');
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data) return;
    const reply = event.data;
    if (reply.type === 'openbitfun:event' && reply.event === 'localeChange') {
      locale = reply.payload.locale;
      unsupported = reply.payload.unsupported;
      document.documentElement.lang = locale;
      localeHandlers.forEach(fn => fn({ locale }));
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    if (reply.error) entry.reject(new Error(reply.error.message));
    else entry.resolve(reply.result);
  });
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const applyAppearance = () => {
    const mode = scheme.matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-openbitfun-appearance-mode', mode);
    document.documentElement.style.colorScheme = mode;
  };
  applyAppearance();
  scheme.addEventListener('change', applyAppearance);
  window.app = Object.freeze({
    get locale() { return locale; },
    onLocaleChange: fn => localeHandlers.push(fn),
    storage: Object.freeze({
      get: key => call('storage.get', { key }),
      set: (key, value) => call('storage.set', { key, value })
    }),
    clipboard: Object.freeze({ writeText: text => call('clipboard.writeText', { text }) }),
    call: () => Promise.reject(new Error(unsupported))
  });
  parent.postMessage({ method: 'openbitfun/request-locale' }, '*');
})();
