import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

/** Records custom-protocol IPC request/response headers, never payloads or responses. */
export class NativeInvokeDiagnosticPage extends WorkbenchResidencyPage {
  startInvokeTrace(previewRequestDelayMs = 0) {
    return this.execute(previewDelay => {
      // Tauri 2.11's invoke/ipc properties are immutable. Observe its fetch
      // transport without replacing callbacks or consuming response bodies.
      const original = window.fetch;
      const calls = [], clicks = []; let dropped = 0;
      const now = () => performance.timeOrigin + performance.now();
      const traced = function(resource, init) {
        const url = typeof resource === 'string' ? new URL(resource, location.href) : null;
        if (url?.protocol !== 'ipc:') return original.call(this, resource, init);
        if (calls.length >= 5000) { dropped++; return original.call(this, resource, init); }
        const command = decodeURIComponent(url.pathname.slice(1));
        let label, bounds;
        if (typeof init?.body === 'string') {
          try {
            const args = JSON.parse(init.body); label = args?.request?.label ?? args?.label;
            if (command === 'browser_webview_set_bounds') bounds = Object.fromEntries(
              ['x', 'y', 'width', 'height'].filter(key => Number.isFinite(args?.request?.[key]))
                .map(key => [key, args.request[key]]));
          } catch {}
        }
        const row = { command, label: typeof label === 'string' ? label : null, bounds, startedAtMs: now() };
        calls.push(row);
        try {
          const send = () => { row.dispatchedAtMs = now(); return original.call(this, resource, init); };
          const request = command === 'browser_webview_capture_preview' && previewDelay > 0
            ? new Promise(resolve => setTimeout(resolve, previewDelay)).then(send) : send();
          return request.then(response => {
            row.responseAtMs = now(); row.ok = response.headers.get('Tauri-Response') === 'ok'; return response;
          }, error => { row.responseAtMs = now(); row.ok = false; throw error; });
        } catch (error) { row.responseAtMs = now(); row.ok = false; throw error; }
      };
      const clicked = event => {
        const item = event.target instanceof Element && event.target.closest('[data-testid="nav-session-item"]');
        if (item) clicks.push({ sessionId: item.dataset.sessionId, atMs: now() });
      };
      window.fetch = traced; document.addEventListener('click', clicked, true);
      window.__nativeInvokeDiagnostic = { stop: () => {
        if (window.fetch === traced) window.fetch = original;
        document.removeEventListener('click', clicked, true);
        return { transport: 'custom-protocol-fetch', calls, clicks, dropped };
      } };
    }, previewRequestDelayMs);
  }

  stopInvokeTrace() {
    return this.execute(() => {
      const result = window.__nativeInvokeDiagnostic?.stop(); delete window.__nativeInvokeDiagnostic; return result ?? null;
    });
  }
}
