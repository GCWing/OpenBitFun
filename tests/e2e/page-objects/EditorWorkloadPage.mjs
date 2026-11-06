import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

/** Real file-tree/editor controls. The exposed Monaco instance is read-only here. */
export class EditorWorkloadPage extends WorkbenchResidencyPage {
  root(filePath) { return `.code-editor-tool[data-file-path=${JSON.stringify(filePath)}]`; }
  fileTreeEntryInteractive(filePath) {
    return this.execute(filePath => {
      const entry = [...document.querySelectorAll('[role="treeitem"][data-file-path]')]
        .find(node => node.dataset.filePath === filePath && !node.closest('[inert], [aria-hidden="true"]'));
      if (!entry) return false;
      const rect = entry.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && entry.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }, filePath);
  }
  async ensureFileTreeEntry(filePath) {
    if (await this.fileTreeEntryInteractive(filePath)) return;
    const treeIsActive = await this.execute(() => [...document.querySelectorAll('[role="treeitem"][data-file-path]')]
      .some(node => !node.closest('[inert], [aria-hidden="true"]') && node.getBoundingClientRect().width > 0));
    if (treeIsActive) {
      await this.until(() => this.fileTreeEntryInteractive(filePath), 'file tree entry after refresh');
      return;
    }
    const workspace = await this.invoke('get_current_workspace', { request: {} });
    // Main/scene navigation keeps its inactive layer mounted. Width and
    // checkVisibility alone do not prove that a user can hit a retained row.
    await this.openWorkspaceMenu(workspace.id);
    await this.click('[data-testid="nav-workspace-menu-open-directory"]');
    await this.until(() => this.fileTreeEntryInteractive(filePath), 'interactive file tree entry');
  }
  async openFile(filePath) {
    this.fileSceneTabs ??= new Map();
    const tabId = this.fileSceneTabs.get(filePath);
    const tab = tabId && `.openbitfun-scene-bar__item[data-scene-tab-id=${JSON.stringify(tabId)}] [role="tab"]`;
    const existingTab = tab && await this.visible(tab);
    if (!existingTab) await this.ensureFileTreeEntry(filePath);
    const trigger = existingTab ? tab : `[role="treeitem"][data-file-path=${JSON.stringify(filePath)}]`;
    await this.execute((trigger, rootSelector) => {
      let start, frame, done = false, contentPending = false;
      const result = { rootSelector, frames: [], milestones: {} };
      const clicked = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) start ??= performance.now();
      };
      const tick = time => {
        if (start !== undefined) {
          const elapsed = time - start;
          result.frames.push(elapsed);
          const root = document.querySelector(rootSelector);
          const visible = root?.checkVisibility({ checkVisibilityCSS: true }) && root.getBoundingClientRect().width > 0;
          if (visible) {
            result.milestones.visibleMs ??= elapsed;
            const editor = root.querySelector('.code-editor-tool__content > div')?.__monacoEditor;
            if (!contentPending && editor?.getModel()?.getValueLength() > 0
              && root.querySelector('.view-line') && !root.querySelector('[data-openbitfun-part="loading"]')) {
              contentPending = true;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                if (root.isConnected && root.checkVisibility({ checkVisibilityCSS: true })) {
                  result.milestones.contentMs = performance.now() - start;
                } else contentPending = false;
              }));
            }
          }
          if (elapsed >= 700 && result.milestones.contentMs !== undefined || elapsed >= 30_000) {
            result.durationMs = elapsed; done = true; return;
          }
        }
        frame = requestAnimationFrame(tick);
      };
      document.addEventListener('click', clicked, true);
      frame = requestAnimationFrame(tick);
      window.__editorOpenProbe = { result, done: () => done, dispose: () => {
        cancelAnimationFrame(frame); document.removeEventListener('click', clicked, true);
      } };
    }, trigger, this.root(filePath));
    try {
      await this.click(trigger);
      await this.until(() => this.execute(() => window.__editorOpenProbe.done()), `loaded editor ${filePath}`, 35_000);
      const result = await this.execute(() => window.__editorOpenProbe.result);
      if (result.milestones.contentMs === undefined) throw new Error(`Editor content did not become ready: ${filePath}`);
      const sceneId = await this.execute(selector => document.querySelector(selector)
        ?.closest('[data-testid="scene-viewport-scene"]')?.dataset.sceneId, this.root(filePath));
      if (sceneId) this.fileSceneTabs.set(filePath, sceneId);
      return { ...result, triggerKind: existingTab ? 'scene-tab' : 'file-tree' };
    } finally {
      await this.execute(() => { window.__editorOpenProbe?.dispose(); delete window.__editorOpenProbe; });
    }
  }
  editorSnapshot(filePath) {
    return this.execute(filePath => {
      const root = [...document.querySelectorAll('.code-editor-tool[data-file-path]')]
        .find(node => node.dataset.filePath === filePath && node.checkVisibility({ checkVisibilityCSS: true }));
      const editor = root?.querySelector('.code-editor-tool__content > div')?.__monacoEditor;
      const model = editor?.getModel();
      if (!model) return { ready: false };
      return { ready: !root.querySelector('[data-openbitfun-part="loading"]'),
        readonly: root.dataset.readonly, lines: model.getLineCount(), characters: model.getValueLength(),
        first: model.getLineContent(1), last: model.getLineContent(model.getLineCount()),
        penultimate: model.getLineContent(Math.max(1, model.getLineCount() - 1)),
        currentLine: model.getLineContent(editor.getPosition()?.lineNumber ?? 1),
        version: model.getAlternativeVersionId(), position: editor.getPosition(),
        selection: editor.getSelection(), scrollTop: editor.getScrollTop(), visibleRanges: editor.getVisibleRanges(),
        mountedViews: document.querySelectorAll('.monaco-editor').length,
      };
    }, filePath);
  }
  async keyChord(keys) {
    // The embedded key source omits legacy keyCode, which Monaco still reads.
    // Exercise its production DOM handlers without invoking editor commands or
    // mutating the model. This remains synthetic input, not trusted OS keys.
    const special = { '\uE03D': ['Meta', 'MetaLeft', 91], '\uE008': ['Shift', 'ShiftLeft', 16],
      '\uE009': ['Control', 'ControlLeft', 17], ' ': [' ', 'Space', 32],
      '\uE015': ['ArrowDown', 'ArrowDown', 40], '\uE00C': ['Escape', 'Escape', 27] };
    const events = keys.map(value => {
      if (special[value]) return special[value];
      if (/^[a-z]$/i.test(value)) return [value, `Key${value.toUpperCase()}`, value.toUpperCase().charCodeAt(0)];
      throw new Error(`Unsupported editor shortcut key: ${value}`);
    });
    await this.execute(events => {
      const pressed = new Set();
      const dispatch = (type, [key, code, keyCode]) => document.activeElement?.dispatchEvent(new KeyboardEvent(type, {
        key, code, keyCode, which: keyCode, bubbles: true, cancelable: true,
        metaKey: pressed.has('Meta'), shiftKey: pressed.has('Shift'), ctrlKey: pressed.has('Control'),
      }));
      for (const event of events) { pressed.add(event[0]); dispatch('keydown', event); }
      for (const event of [...events].reverse()) { dispatch('keyup', event); pressed.delete(event[0]); }
    }, events);
  }
  async typeChunks(filePath, chunks, intervalMs = 80) {
    const selector = `${this.root(filePath)} textarea.inputarea`;
    const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
    for (const text of chunks) {
      await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  async enterText(selector, text) {
    const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
    await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
  }
  startEditorProbe(filePath) {
    return this.execute(filePath => {
      if (window.__editorWorkloadProbe) throw new Error('An editor probe is already running');
      const frames = [], inputRafMs = [], wheelTimes = [];
      const pending = new Set();
      let frame;
      const tick = at => { frames.push(at); frame = requestAnimationFrame(tick); };
      const belongs = target => target instanceof Element && target.closest('.code-editor-tool')?.dataset.filePath === filePath;
      const input = event => {
        if (!belongs(event.target)) return;
        const start = performance.now();
        const id = requestAnimationFrame(() => { pending.delete(id); inputRafMs.push(performance.now() - start); });
        pending.add(id);
      };
      const wheel = event => { if (belongs(event.target)) wheelTimes.push(performance.now()); };
      document.addEventListener('input', input, true); document.addEventListener('wheel', wheel, true);
      frame = requestAnimationFrame(tick);
      window.__editorWorkloadProbe = { stop: () => {
        cancelAnimationFrame(frame); pending.forEach(id => cancelAnimationFrame(id));
        document.removeEventListener('input', input, true); document.removeEventListener('wheel', wheel, true);
        return { frames, inputRafMs, wheelTimes };
      } };
    }, filePath);
  }
  stopEditorProbe() {
    return this.execute(() => {
      const result = window.__editorWorkloadProbe?.stop(); delete window.__editorWorkloadProbe; return result;
    });
  }
  async scrollEditor(filePath, deltaY, steps = 24) {
    const point = await this.execute(selector => {
      const rect = document.querySelector(`${selector} .monaco-editor`).getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, this.root(filePath));
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'editor-workload-scroll',
      actions: Array.from({ length: steps }, () => ({ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 16 })),
    }] });
  }
}
