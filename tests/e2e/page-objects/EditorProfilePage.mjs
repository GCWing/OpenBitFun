import { EditorLanguagePage } from './EditorLanguagePage.mjs';
import { LayoutReadDiagnosticPage } from './LayoutReadDiagnosticPage.mjs';

/** Diagnostic wrappers preserve return values and never retain editor instances. */
export class EditorProfilePage extends EditorLanguagePage {
  startLayoutReads() { return LayoutReadDiagnosticPage.prototype.startLayoutReads.call(this); }
  stopLayoutReads() { return LayoutReadDiagnosticPage.prototype.stopLayoutReads.call(this); }

  startEditorCreationProbe() {
    return this.execute(() => {
      const namespace = window.monaco.editor, originalCreate = namespace.create;
      const model = namespace.getModels()[0];
      if (!model) throw new Error('Creation diagnosis requires opened fixture models');
      const prototype = Object.getPrototypeOf(model), originalGetValue = prototype.getValue;
      const creates = [], themes = [], restores = [], values = { count: 0, totalMs: 0, maxMs: 0, slow: [] };
      for (const name of ['defineTheme', 'setTheme']) {
        const original = namespace[name];
        namespace[name] = function(...args) {
          const startedAtMs = performance.now();
          try { return original.apply(this, args); }
          finally { themes.push({ name, theme: args[0], startedAtMs, durationMs: performance.now() - startedAtMs }); }
        };
        restores.push(() => { namespace[name] = original; });
      }
      namespace.create = function(...args) {
        const startedAtMs = performance.now();
        try { return originalCreate.apply(this, args); }
        finally { creates.push({ startedAtMs, durationMs: performance.now() - startedAtMs,
          uri: args[1]?.model?.uri.toString(), lines: args[1]?.model?.getLineCount() }); }
      };
      prototype.getValue = function(...args) {
        const startedAtMs = performance.now();
        try { return originalGetValue.apply(this, args); }
        finally {
          const durationMs = performance.now() - startedAtMs;
          values.count++; values.totalMs += durationMs; values.maxMs = Math.max(values.maxMs, durationMs);
          if (durationMs >= 1 && values.slow.length < 100) values.slow.push({ durationMs,
            uri: this.uri.toString(), stack: new Error('Model value diagnostic').stack });
        }
      };
      window.__editorCreationProbe = { stop: () => {
        namespace.create = originalCreate; prototype.getValue = originalGetValue;
        restores.forEach(restore => restore());
        return { creates, themes, values };
      } };
    });
  }

  stopEditorCreationProbe() {
    return this.execute(() => {
      const result = window.__editorCreationProbe?.stop(); delete window.__editorCreationProbe; return result;
    });
  }
}
