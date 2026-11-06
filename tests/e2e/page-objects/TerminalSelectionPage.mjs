import { TerminalWorkloadPage } from './TerminalWorkloadPage.mjs';

/** Renderer-failure fixture and readback; no xterm engine handles are exposed. */
export class TerminalSelectionPage extends TerminalWorkloadPage {
  loseWebglContext(sessionId) {
    return this.execute(selector => {
      const root = document.querySelector(selector);
      for (const canvas of root.querySelectorAll('canvas')) {
        const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const extension = context?.getExtension('WEBGL_lose_context');
        if (extension) { extension.loseContext(); return true; }
      }
      throw new Error('No live WebGL context supports the context-loss fixture');
    }, this.root(sessionId));
  }
  domSelection(sessionId) {
    return this.execute(selector => {
      const root = document.querySelector(selector);
      const rows = root.querySelector('.xterm-rows');
      return { visible: root.checkVisibility({ checkVisibilityCSS: true }),
        canvases: root.querySelectorAll('canvas').length,
        focused: document.activeElement === root.querySelector('.xterm-helper-textarea'),
        rendererFocused: rows?.classList.contains('xterm-focus'),
        renderedOutput: rows?.textContent.includes('selection output'),
        selectionRects: [...root.querySelectorAll('.xterm-selection > div')].map(node => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height, background: getComputedStyle(node).backgroundColor };
        }),
      };
    }, this.root(sessionId));
  }
  async blurTerminal() {
    await this.execute(() => document.querySelector('[data-testid="nav-search-trigger"]').focus({ preventScroll: true }));
    await this.presentationFrames();
  }
  presentationFrames() {
    return this.execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  }
}
