import { EditorWorkloadPage } from './EditorWorkloadPage.mjs';

/** Observe each language-service phase without holding a native eval open. */
export class EditorLanguagePage extends EditorWorkloadPage {
  async openHtmlAsCode(filePath) {
    const selector = `[role="treeitem"][data-file-path=${JSON.stringify(filePath)}]`;
    await this.ensureFileTreeEntry(filePath);
    await this.execute(selector => {
      const target = document.querySelector(selector), rect = target.getBoundingClientRect();
      window.__editorHtmlMenu = { target: target.outerHTML.slice(0, 2000), rect: rect.toJSON(),
        hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.outerHTML.slice(0, 2000) };
      const observe = event => {
        window.__editorHtmlMenu.event = { target: event.target?.outerHTML.slice(0, 2000),
          x: event.clientX, y: event.clientY, path: event.composedPath().filter(node => node instanceof Element)
            .map(node => ({ tag: node.tagName, class: node.className, filePath: node.getAttribute('data-file-path') })) };
      };
      document.addEventListener('contextmenu', observe, { capture: true, once: true });
      window.__editorHtmlMenuDispose = () => document.removeEventListener('contextmenu', observe, true);
    }, selector);
    const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'pointer', id: 'html-source-menu',
      parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', origin: element, x: 0, y: 0, duration: 0 },
        { type: 'pointerDown', button: 2 }, { type: 'pointerUp', button: 2 },
      ],
    }] });
    try { await this.until(() => this.visible('[data-menu-id="file-open"]'), 'HTML source opening action', 10000); }
    finally {
      this.htmlOpeningDiagnostic = await this.execute(() => {
        window.__editorHtmlMenuDispose?.();
        const state = { ...window.__editorHtmlMenu,
          menus: [...document.querySelectorAll('[role="menu"], [data-menu-id]')]
            .map(node => ({ id: node.dataset.menuId, text: node.textContent, visible: node.checkVisibility({ checkVisibilityCSS: true }) })) };
        delete window.__editorHtmlMenu; delete window.__editorHtmlMenuDispose;
        return state;
      });
    }
    await this.click('[data-menu-id="file-open"]');
    await this.until(async () => (await this.editorSnapshot(filePath)).ready, 'HTML source editor');
    return { kind: 'native-file-context-menu' };
  }

  startSemanticProbe(filePath, diagnostic = 'semantic') {
    return this.execute((selector, diagnostic) => {
      const uri = document.querySelector(`${selector} .code-editor-tool__content > div`)
        ?.__monacoEditor?.getModel()?.uri;
      if (!uri) throw new Error('Missing language diagnostic model');
      const state = { stage: 'factory', startedAtMs: performance.now(), done: false, uri: uri.toString() };
      window.__editorSemantic = state;
      (async () => {
        try {
          const factory = await (diagnostic === 'syntactic'
            ? window.monaco.languages.typescript.getJavaScriptWorker()
            : window.monaco.languages.typescript.getTypeScriptWorker());
          state.stage = 'worker'; state.factoryAtMs = performance.now();
          const worker = await factory(uri);
          state.stage = 'semantic'; state.workerAtMs = performance.now();
          const diagnostics = await (diagnostic === 'syntactic'
            ? worker.getSyntacticDiagnostics(uri.toString()) : worker.getSemanticDiagnostics(uri.toString()));
          state.codes = diagnostics.map(item => item.code);
          state.stage = 'complete'; state.completedAtMs = performance.now();
        } catch (error) { state.error = String(error); state.stage = 'failed'; }
        finally { state.done = true; }
      })();
    }, this.root(filePath), diagnostic);
  }

  semanticState() {
    return this.execute(() => ({ ...window.__editorSemantic,
      markers: window.monaco?.editor.getModelMarkers(window.__editorSemantic?.uri
        ? { resource: window.monaco.Uri.parse(window.__editorSemantic.uri) } : {})
        .map(marker => ({ code: marker.code, severity: marker.severity })) ?? [],
      errors: (window.__openbitfunWdLogs ?? []).filter(item => item.level === 'SEVERE' || item.level === 'WARNING')
        .slice(-10).map(item => ({ level: item.level, message: item.message.slice(0, 1500) })),
    }));
  }

  fileLanguageState(filePath) {
    return this.execute(selector => {
      const root = document.querySelector(selector);
      const model = root?.querySelector('.code-editor-tool__content > div')?.__monacoEditor?.getModel();
      return { language: model?.getLanguageId(),
        markers: model ? window.monaco.editor.getModelMarkers({ resource: model.uri })
          .map(marker => ({ code: marker.code, severity: marker.severity })) : [],
        squiggles: root?.querySelectorAll('[class*="squiggly-error"], [class*="squiggly-warning"]').length ?? 0,
        suggestionsVisible: Boolean(root?.querySelector('.suggest-widget.visible')),
        suggestions: [...(root?.querySelectorAll('.suggest-widget.visible .monaco-list-row') ?? [])]
          .map(row => row.textContent),
      };
    }, this.root(filePath));
  }
}
