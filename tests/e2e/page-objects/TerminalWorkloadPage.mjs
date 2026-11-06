import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

/** Actual terminal controls; xterm diagnostics and native metadata are read-only. */
export class TerminalWorkloadPage extends WorkbenchResidencyPage {
  root(sessionId) { return `.openbitfun-terminal[data-session-id=${JSON.stringify(sessionId)}]`; }
  snapshots() {
    return this.execute(() => (window.__OPENBITFUN_TERMINAL_DIAGNOSTICS__?.snapshot() ?? []).map(state => {
      const root = [...document.querySelectorAll('.openbitfun-terminal[data-session-id]')]
        .find(node => node.dataset.sessionId === state.sessionId);
      return { ...state, visible: !!root?.checkVisibility({ checkVisibilityCSS: true }),
        sceneId: root?.closest('[data-testid="scene-viewport-scene"]')?.dataset.sceneId };
    }));
  }
  async snapshotTerminal(sessionId) { return (await this.snapshots()).find(row => row.sessionId === sessionId); }
  clickTerminalText(sessionId) {
    // The embedded driver omits MouseEvent.detail. xterm uses detail=1 to
    // distinguish a single click from double/triple-click selection.
    return this.execute(selector => {
      const screen = document.querySelector(`${selector} .xterm-screen`);
      const rect = screen.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2, clientY = rect.top + rect.height / 2;
      const target = document.elementFromPoint(clientX, clientY);
      if (!target || !screen.contains(target)) throw new Error('Terminal text is not hit-testable');
      for (const type of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window,
          clientX, clientY, button: 0, buttons: type === 'mousedown' ? 1 : 0, detail: 1 }));
      }
    }, this.root(sessionId));
  }
  selectAllTerminal(sessionId) {
    return this.execute(selector => {
      const input = document.querySelector(`${selector} .xterm-helper-textarea`);
      input.focus({ preventScroll: true });
      const keydown = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65,
        ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(keydown);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', keyCode: 65, which: 65,
        ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return { handled: keydown.defaultPrevented };
    }, this.root(sessionId));
  }
  copyTerminalSelection(sessionId) {
    // Exercise xterm's copy event without overwriting the user's OS clipboard.
    return this.execute(selector => {
      const input = document.querySelector(`${selector} .xterm-helper-textarea`);
      input.focus({ preventScroll: true });
      const clipboardData = new DataTransfer();
      const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return { handled: event.defaultPrevented, text: clipboardData.getData('text/plain') };
    }, this.root(sessionId));
  }
  async historyCursor(sessionId) {
    const history = await this.invoke('terminal_get_history', { sessionId });
    if (!Number.isSafeInteger(history.nextOffset)) throw new Error('Terminal history does not expose a replay cursor');
    return history.nextOffset;
  }
  async waitForShellPrompt(sessionId, cursor) {
    let text = '', nextOffset = cursor;
    return this.until(async () => {
      const history = await this.invoke('terminal_get_history', { sessionId, afterOffset: nextOffset });
      text += history.data; nextOffset = history.nextOffset;
      // Shell integration marks command input readiness after prompt setup.
      // A child-process EXIT marker alone can precede zsh's input setup.
      return /\x1b\](?:633|133);B(?:\x07|\x1b\\)/.test(text) && { cursor, nextOffset, promptReady: true };
    }, 'shell command-input readiness after child exit');
  }
  async createTerminal(workspaceId) {
    const existing = new Set((await this.snapshots()).map(row => row.sessionId));
    await this.openWorkspaceMenu(workspaceId);
    const newRoot = '.openbitfun-terminal[data-session-id]' + [...existing].map(id => `:not([data-session-id=${JSON.stringify(id)}])`).join('');
    const timing = await this.measureOpen('[data-testid="nav-workspace-menu-create-terminal"]', newRoot);
    if (timing.milestones.contentMs === undefined) throw new Error('New terminal view did not become ready');
    const terminal = await this.until(async () => (await this.snapshots())
      .find(row => row.sessionId && !existing.has(row.sessionId) && row.visible), 'new native terminal');
    return { terminal, timing };
  }
  async activate(terminal) {
    const timing = await this.measureOpen(`.openbitfun-scene-bar__item[data-scene-tab-id=${JSON.stringify(terminal.sceneId)}] [role="tab"]`,
      this.root(terminal.sessionId));
    if (timing.milestones.contentMs === undefined) throw new Error(`Terminal did not activate: ${terminal.sessionId}`);
    return timing;
  }
  async command(sessionId, text, marker) {
    const selector = `${this.root(sessionId)} textarea.xterm-helper-textarea`;
    await this.click(`${this.root(sessionId)} .xterm-screen`);
    await this.until(() => this.execute(sessionId => document.activeElement?.closest('[data-session-id]')?.dataset.sessionId === sessionId,
      sessionId), 'terminal input focus');
    if (marker) await this.execute((sessionId, marker) => {
      let frame, start, pending = false, done = false;
      const result = { frames: [], inputRafMs: [], responseMs: null };
      const inputFrames = new Set();
      const input = event => {
        if (event.target?.closest?.('[data-session-id]')?.dataset.sessionId !== sessionId) return;
        const at = performance.now(); start ??= at;
        const id = requestAnimationFrame(() => { inputFrames.delete(id); result.inputRafMs.push(performance.now() - at); });
        inputFrames.add(id);
      };
      const tick = at => {
        if (start !== undefined) {
          result.frames.push(at);
          const state = window.__OPENBITFUN_TERMINAL_DIAGNOSTICS__?.snapshot().find(row => row.sessionId === sessionId);
          if (!pending && state?.tailLines.some(line => line.trim() === marker)) {
            pending = true;
            const first = requestAnimationFrame(() => {
              inputFrames.delete(first);
              const second = requestAnimationFrame(() => {
                inputFrames.delete(second); result.responseMs = performance.now() - start; done = true;
              });
              inputFrames.add(second);
            });
            inputFrames.add(first);
          }
        }
        if (!done) frame = requestAnimationFrame(tick);
      };
      document.addEventListener('input', input, true);
      frame = requestAnimationFrame(tick);
      window.__terminalCommandProbe = { result, done: () => done, stop: () => {
        cancelAnimationFrame(frame); inputFrames.forEach(id => cancelAnimationFrame(id));
        document.removeEventListener('input', input, true);
      } };
    }, sessionId, marker);
    try {
      const element = await this.request(`/session/${this.session}/element`, { using: 'css selector', value: selector });
      await this.request(`/session/${this.session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text });
      // xterm reads legacy keyCode; the embedded key source omits it.
      const submitted = await this.execute(() => {
        const target = document.activeElement;
        const events = [];
        for (const type of ['keydown', 'keyup']) {
          const event = new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
          });
          target?.dispatchEvent(event); events.push({ type, defaultPrevented: event.defaultPrevented });
        }
        return { events, target: target?.className, sessionId: target?.closest('[data-session-id]')?.dataset.sessionId };
      });
      if (!marker) return submitted;
      await this.until(() => this.execute(() => window.__terminalCommandProbe.done()), `terminal response ${marker}`);
      return await this.execute(() => window.__terminalCommandProbe.result);
    } finally {
      if (marker) await this.execute(() => { window.__terminalCommandProbe?.stop(); delete window.__terminalCommandProbe; });
    }
  }
  startFrameProbe() {
    return this.execute(() => {
      if (window.__terminalFrames) throw new Error('A terminal frame probe is already running');
      const frames = [], wheelTimes = [];
      let frame;
      const tick = time => { frames.push(time); frame = requestAnimationFrame(tick); };
      const wheel = () => { wheelTimes.push(performance.now()); };
      document.addEventListener('wheel', wheel, true); frame = requestAnimationFrame(tick);
      window.__terminalFrames = { stop: () => {
        cancelAnimationFrame(frame); document.removeEventListener('wheel', wheel, true); return { frames, wheelTimes };
      } };
    });
  }
  stopFrameProbe() {
    return this.execute(() => { const raw = window.__terminalFrames?.stop(); delete window.__terminalFrames; return raw; });
  }
  startResizeDiagnostic(commands = ['terminal_resize']) {
    return this.execute(commands => {
      const bridge = window.__TAURI_INTERNALS__, invoke = bridge.invoke, calls = [], errors = [];
      const timeout = window.setTimeout, clear = window.clearTimeout, timers = new Map();
      const wrappedTimeout = function (callback, wait, ...args) {
        const id = timeout.call(window, callback, wait, ...args), stack = new Error().stack;
        if (stack?.includes('scheduleBackendResize') || stack?.includes('debounceXtermResizeX')) timers.set(id, { id, wait, stack });
        return id;
      };
      const wrappedClear = function (id) {
        const timer = timers.get(id);
        if (timer) timer.cancelStack = new Error().stack;
        return clear.call(window, id);
      };
      const error = event => errors.push({ at: performance.now(), message: event.message, stack: event.error?.stack });
      const wrapped = function (command, args, ...rest) {
        if (!commands.includes(command)) return Reflect.apply(invoke, this, [command, args, ...rest]);
        const row = { at: performance.now(), command, request: args?.request };
        calls.push(row);
        return Promise.resolve(Reflect.apply(invoke, this, [command, args, ...rest])).then(value => {
          row.completedAt = performance.now(); return value;
        }, caught => { row.error = String(caught); throw caught; });
      };
      bridge.invoke = wrapped;
      const invokeWrapperInstalled = bridge.invoke === wrapped;
      window.setTimeout = wrappedTimeout; window.clearTimeout = wrappedClear;
      window.addEventListener('error', error);
      window.__terminalResizeDiagnostic = { stop: () => {
        if (bridge.invoke === wrapped) bridge.invoke = invoke;
        if (window.setTimeout === wrappedTimeout) window.setTimeout = timeout;
        if (window.clearTimeout === wrappedClear) window.clearTimeout = clear;
        window.removeEventListener('error', error);
        return { calls, errors, invokeWrapperInstalled, timers: [...timers.values()] };
      } };
    }, commands);
  }
  stopResizeDiagnostic() {
    return this.execute(() => {
      const result = window.__terminalResizeDiagnostic?.stop(); delete window.__terminalResizeDiagnostic; return result;
    });
  }
  resizeNavigation(distance) {
    // A different final width is needed to verify PTY geometry; the ordinary
    // smoothness sweep returns to its initial width and cannot prove a resize.
    return this.execute(async distance => {
      const target = document.querySelector('[data-openbitfun-part="navDivider"]');
      const rect = target.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const dispatch = (type, at, buttons) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: at, clientY: y, button: 0, buttons,
      }));
      dispatch('pointerdown', x, 1);
      try {
        for (let step = 1; step <= 20; step++) {
          await new Promise(resolve => setTimeout(resolve, 16));
          dispatch('pointermove', x + distance * step / 20, 1);
        }
      } finally { dispatch('pointerup', x + distance, 0); }
    }, distance);
  }
  async wheel(sessionId, deltaY, steps = 24) {
    const point = await this.execute(selector => {
      const rect = document.querySelector(`${selector} .xterm-screen`).getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, this.root(sessionId));
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'terminal-output-scroll',
      actions: Array.from({ length: steps }, () => ({ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 16 })),
    }] });
  }
}
