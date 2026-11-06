import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

export class SceneVisibilityPage extends WorkbenchResidencyPage {
  async click(selector) {
    // The embedded element-click endpoint emits MouseEvent only. Exercise the
    // real pointerdown handlers and modality tracker without importing stores.
    await this.execute(selector => {
      const target = document.querySelector(selector);
      if (!target || !target.checkVisibility({ checkVisibilityCSS: true }) || target.closest('[inert]')) {
        throw new Error(`Pointer target is not interactive: ${selector}`);
      }
      window.__openbitfunWd.scrollElementIntoView(target);
      const box = target.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, composed: true,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0, detail: 1 };
      const pointer = (type, buttons) => target.dispatchEvent(new PointerEvent(type, {
        ...base, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      const mouse = (type, buttons) => target.dispatchEvent(new MouseEvent(type, { ...base, buttons }));
      pointer('pointerover', 0); mouse('mouseover', 0);
      pointer('pointermove', 0); mouse('mousemove', 0);
      if (pointer('pointerdown', 1) && mouse('mousedown', 1)) window.__openbitfunWd.focusWithoutScroll(target);
      pointer('pointerup', 0); mouse('mouseup', 0); mouse('click', 0);
    }, selector);
  }

  async measureOpen(trigger, rootSelector) {
    await this.execute((trigger, rootSelector) => {
      let start, raf, done = false, contentPending = false, presentationPending = false;
      const result = { rootSelector, frames: [], milestones: {}, loadingFrames: 0, missingFrames: 0 };
      const pressed = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) start ??= performance.now();
      };
      document.addEventListener('pointerdown', pressed, true);
      const loading = root => root.querySelector('[aria-busy="true"], .gallery-skeleton, .gallery-skeleton-card, [data-openbitfun-part="loading"], .config-loading-state, .history-session-loading:not([data-history-loading-phase="idle"])');
      const tick = time => {
        if (start !== undefined) {
          const elapsed = time - start; result.frames.push(elapsed);
          const root = document.querySelector(rootSelector);
          if (root?.checkVisibility({ checkVisibilityCSS: true }) && root.getBoundingClientRect().width > 0) {
            result.milestones.visibleMs ??= elapsed;
            if (!presentationPending) {
              presentationPending = true;
              requestAnimationFrame(() => requestAnimationFrame(() => { result.milestones.presentedMs = performance.now() - start; }));
            }
            if (loading(root)) result.loadingFrames++;
            else if (!contentPending) {
              contentPending = true;
              requestAnimationFrame(() => {
                if (root.isConnected && !loading(root)) result.milestones.contentMs ??= performance.now() - start;
                else contentPending = false;
              });
            }
          } else result.missingFrames++;
          if ((elapsed >= 700 && result.milestones.contentMs !== undefined) || elapsed >= 15000) {
            done = true; result.durationMs = elapsed; return;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      window.__sceneOpenProbe = { result, done: () => done, stop: () => {
        cancelAnimationFrame(raf); document.removeEventListener('pointerdown', pressed, true);
      } };
    }, trigger, rootSelector);
    try {
      await this.click(trigger);
      await this.until(() => this.execute(() => window.__sceneOpenProbe.done()), rootSelector, 20000);
      return await this.execute(() => window.__sceneOpenProbe.result);
    } finally {
      await this.execute(() => { window.__sceneOpenProbe?.stop(); delete window.__sceneOpenProbe; });
    }
  }

  async scrollHistory() {
    const point = await this.execute(() => {
      const box = document.querySelector('[data-flowchat-scroller]').getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    });
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'scene-reader',
      actions: [{ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY: -650, duration: 100 }] }] });
  }

  hiddenSceneGuards() {
    return this.execute(() => {
      const previousFocus = document.activeElement;
      const rows = [...document.querySelectorAll('[data-testid="scene-viewport-scene"]')]
        .filter(node => !node.classList.contains('openbitfun-scene-viewport__scene--visible'))
        .map(node => {
          const style = getComputedStyle(node);
          const control = node.querySelector('button, input, textarea, [contenteditable="true"], [tabindex]');
          control?.focus({ preventScroll: true });
          const focused = node.contains(document.activeElement);
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return { id: node.dataset.sceneId, inert: node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden'),
            visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents,
            contentVisibility: style.contentVisibility, focused, hit: !!hit && node.contains(hit),
            descendantVisible: !!control && control.checkVisibility({ checkVisibilityCSS: true }) };
        });
      if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
      return rows;
    });
  }

  async transitionFrames(trigger) {
    await this.execute(trigger => {
      const frames = []; let start, raf;
      const clicked = event => {
        if (event.target instanceof Element && event.target.closest(trigger)) start ??= performance.now();
      };
      document.addEventListener('pointerdown', clicked, true);
      const tick = time => {
        if (start !== undefined) frames.push({ time: time - start,
          scenes: [...document.querySelectorAll('[data-testid="scene-viewport-scene"]')].map(node => ({
            id: node.dataset.sceneId, opacity: Number(getComputedStyle(node).opacity),
            visible: node.classList.contains('openbitfun-scene-viewport__scene--visible'),
            transitionDuration: getComputedStyle(node).transitionDuration,
            outgoing: node.classList.contains('openbitfun-scene-viewport__scene--outgoing'),
            incoming: node.classList.contains('openbitfun-scene-viewport__scene--incoming'),
            inert: node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden'),
          })) });
        if (start === undefined || time - start < 800) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      window.__sceneVisibilityFrames = { frames, stop: () => {
        cancelAnimationFrame(raf); document.removeEventListener('pointerdown', clicked, true);
      } };
    }, trigger);
    try {
      await this.click(trigger);
      await this.until(() => this.execute(() => window.__sceneVisibilityFrames.frames.at(-1)?.time >= 800), 'scene crossfade');
      return await this.execute(() => window.__sceneVisibilityFrames.frames);
    } finally {
      await this.execute(() => { window.__sceneVisibilityFrames?.stop(); delete window.__sceneVisibilityFrames; });
    }
  }
}
