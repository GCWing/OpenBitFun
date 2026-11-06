import { SceneDiagnosticPage } from './SceneDiagnosticPage.mjs';

/** Calibrate observation overhead; this path cannot report feedback latency. */
export class SceneProbeDiagnosticPage extends SceneDiagnosticPage {
  async measureFrameOnlyOpen(trigger, rootSelector) {
    await this.execute((trigger, rootSelector) => {
      let start, raf, done = false;
      const result = { rootSelector, frames: [], observer: 'frame-only', ready: false };
      const pressed = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) start ??= performance.now();
      };
      document.addEventListener('pointerdown', pressed, true);
      const tick = time => {
        if (start !== undefined) {
          const elapsed = time - start;
          result.frames.push(elapsed);
          if (elapsed >= 700) {
            // Same real interaction and settling interval, but no per-frame
            // visibility/geometry/loading queries. Validate DOM state once.
            const root = document.querySelector(rootSelector);
            result.ready = !!root?.classList.contains('openbitfun-scene-viewport__scene--visible')
              && !root.hasAttribute('inert')
              && !root.querySelector('[aria-busy="true"], .gallery-skeleton, .gallery-skeleton-card, [data-openbitfun-part="loading"], .config-loading-state, .history-session-loading:not([data-history-loading-phase="idle"])');
            result.durationMs = elapsed;
            done = true;
            return;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      window.__sceneFrameOnlyProbe = { result, done: () => done, stop: () => {
        cancelAnimationFrame(raf); document.removeEventListener('pointerdown', pressed, true);
      } };
    }, trigger, rootSelector);
    try {
      await this.click(trigger);
      await this.until(() => this.execute(() => window.__sceneFrameOnlyProbe.done()), rootSelector, 20000);
      return await this.execute(() => window.__sceneFrameOnlyProbe.result);
    } finally {
      await this.execute(() => { window.__sceneFrameOnlyProbe?.stop(); delete window.__sceneFrameOnlyProbe; });
    }
  }
}
