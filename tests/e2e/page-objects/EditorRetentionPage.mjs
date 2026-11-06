import { EditorLanguagePage } from './EditorLanguagePage.mjs';

/** Weak observations only: never retain editor/model/Worker objects or force GC. */
export class EditorRetentionPage extends EditorLanguagePage {
  startRetentionProbe() {
    return this.execute(() => {
      if (window.__editorRetention) throw new Error('Editor retention probe already running');
      const OriginalWorker = window.Worker;
      const workers = [], models = [], editors = [], roots = [];
      const modelRows = new WeakMap(), editorRows = new WeakMap(), rootRows = new WeakMap();
      let monaco, created, disposing;
      const markDisposed = row => () => { row.disposed = true; row.disposedAtMs = performance.now(); };
      const wrapTerminate = (row, originalTerminate) => function(...values) {
        row.terminated = true; row.terminatedAtMs = performance.now();
        return originalTerminate.apply(this, values);
      };
      const WorkerProbe = new Proxy(OriginalWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget);
          const originalTerminate = worker.terminate;
          const row = { id: workers.length + 1, weak: new WeakRef(worker), terminated: false,
            name: typeof args[1]?.name === 'string' ? args[1].name : null,
            createdAtMs: performance.now(), originalTerminate };
          const terminate = wrapTerminate(row, originalTerminate);
          row.terminate = terminate; worker.terminate = terminate; workers.push(row);
          return worker;
        },
      });
      window.Worker = WorkerProbe;
      const watchModel = model => {
        if (modelRows.has(model)) return;
        const row = { id: models.length + 1, weak: new WeakRef(model), uri: model.uri.toString(),
          language: model.getLanguageId(), characters: model.getValueLength(), disposed: model.isDisposed() };
        modelRows.set(model, row); models.push(row);
      };
      const discover = () => {
        if (!monaco && window.monaco?.editor) {
          monaco = window.monaco;
          created = monaco.editor.onDidCreateModel(watchModel);
          disposing = monaco.editor.onWillDisposeModel(model => {
            const row = modelRows.get(model);
            if (row) { row.disposed = true; row.disposedAtMs = performance.now(); }
          });
        }
        monaco?.editor.getModels().forEach(watchModel);
        for (const root of document.querySelectorAll('.code-editor-tool')) {
          if (!rootRows.has(root)) {
            const row = { id: roots.length + 1, weak: new WeakRef(root) };
            roots.push(row); rootRows.set(root, row);
          }
          const editor = root.querySelector('.code-editor-tool__content > div')?.__monacoEditor;
          if (!editor || editorRows.has(editor)) continue;
          const row = { id: editors.length + 1, weak: new WeakRef(editor), disposed: false };
          // Do not retain the returned disposable: it can retain the editor.
          editor.onDidDispose(markDisposed(row));
          editors.push(row); editorRows.set(editor, row);
        }
      };
      const snapshot = () => {
        discover();
        return { atMs: performance.now(), monacoLoaded: Boolean(monaco),
          currentModels: monaco?.editor.getModels().map(model => ({ uri: model.uri.toString(),
            language: model.getLanguageId(), characters: model.getValueLength() })) ?? [],
          models: models.map(({ weak, ...row }) => ({ ...row, alive: Boolean(weak.deref()) })),
          editors: editors.map(({ weak, ...row }) => ({ ...row, alive: Boolean(weak.deref()) })),
          roots: roots.map(({ id, weak }) => ({ id, alive: Boolean(weak.deref()), connected: weak.deref()?.isConnected ?? false })),
          workers: workers.map(({ weak, originalTerminate, terminate, ...row }) => ({ ...row, alive: Boolean(weak.deref()) })),
        };
      };
      window.__editorRetention = { snapshot, stop: () => {
        const result = snapshot(); created?.dispose(); disposing?.dispose();
        if (window.Worker === WorkerProbe) window.Worker = OriginalWorker;
        for (const row of workers) {
          const worker = row.weak.deref();
          if (worker?.terminate === row.terminate) worker.terminate = row.originalTerminate;
        }
        return result;
      } };
    });
  }

  async openFile(filePath) {
    const result = await super.openFile(filePath);
    await this.retentionSnapshot();
    return result;
  }

  retentionSnapshot() {
    return this.execute(() => window.__editorRetention.snapshot());
  }

  resetEmptyTypeScriptWorker() {
    return this.execute(() => {
      if (window.monaco.editor.getModels().length) throw new Error('Worker diagnosis requires every model to be closed');
      const defaults = window.monaco.languages.typescript.typescriptDefaults;
      const before = JSON.stringify(defaults.getCompilerOptions());
      // Causal intervention only. Monaco's public configuration notification
      // resets its cached language worker; this is not a product lifecycle fix.
      defaults.setCompilerOptions(defaults.getCompilerOptions());
      return { before, after: JSON.stringify(defaults.getCompilerOptions()), atMs: performance.now() };
    });
  }

  refreshEmptyTypeScriptProgram() {
    return this.execute(async () => {
      const before = window.__editorRetention.snapshot();
      if (before.currentModels.length) throw new Error('Program diagnosis requires every model to be closed');
      if (!before.workers.some(worker => worker.name === 'monaco-typescript-worker' && worker.alive && !worker.terminated)) {
        throw new Error('Program diagnosis requires the existing TypeScript Worker');
      }
      const startedAtMs = performance.now();
      const getWorker = await window.monaco.languages.typescript.getTypeScriptWorker();
      const worker = await getWorker();
      const filesBefore = await worker.getScriptFileNames();
      if (filesBefore.length) throw new Error('The Worker still owns mirror models or extra libraries');
      // Diagnostic intervention only: this public language-service request
      // synchronizes its derived program to the now-empty mirror inventory.
      // It neither terminates the Worker nor changes compiler options.
      const diagnostics = await worker.getCompilerOptionsDiagnostics('openbitfun-empty-program.ts');
      const after = window.__editorRetention.snapshot();
      return { startedAtMs, completedAtMs: performance.now(), filesBefore,
        filesAfter: await worker.getScriptFileNames(), codes: diagnostics.map(item => item.code),
        workersBefore: before.workers, workersAfter: after.workers };
    });
  }

  semanticDiagnostics(filePath) {
    return this.execute(async selector => {
      const editor = document.querySelector(`${selector} .code-editor-tool__content > div`)?.__monacoEditor;
      const uri = editor?.getModel()?.uri;
      if (!uri) throw new Error('Missing reopened editor model');
      const started = performance.now();
      const getWorker = await window.monaco.languages.typescript.getTypeScriptWorker();
      const worker = await getWorker(uri);
      const diagnostics = await worker.getSemanticDiagnostics(uri.toString());
      return { durationMs: performance.now() - started, codes: diagnostics.map(item => item.code) };
    }, this.root(filePath));
  }

  stopRetentionProbe() {
    return this.execute(() => {
      const result = window.__editorRetention?.stop(); delete window.__editorRetention; return result;
    });
  }
}
