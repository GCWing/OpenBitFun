import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';
import { PetPerformancePage } from './PetPerformancePage.mjs';

/** Companion diagnostics without loading main-window stores into its WebView. */
export class PetResidencyPage extends WorkbenchResidencyPage {
  select(handle) { return this.request(`/session/${this.session}/window`, { handle }); }
  activity(...args) { return PetPerformancePage.prototype.activity.apply(this, args); }
  cadence() {
    return this.execute(() => new Promise(resolve => {
      const frames = []; const start = performance.now();
      const tick = time => {
        const pet = document.querySelector('[data-openbitfun-part="petdex"]');
        const style = getComputedStyle(pet);
        frames.push({ time, name: style.animationName, x: style.backgroundPositionX,
          row: Number(pet.style.getPropertyValue('--openbitfun-petdex-row')) });
        if (time - start < 2600) requestAnimationFrame(tick);
        else resolve({ frames });
      };
      requestAnimationFrame(tick);
    }));
  }

  async preparePet() {
    await this.invoke('show_agent_companion_desktop_pet');
    await this.select('agent-companion-pet');
    await this.until(() => this.execute(() => !!document.querySelector('[data-openbitfun-part="petdex"]')), 'pet sprite');
  }

  startCallbackProbe() {
    return this.execute(() => {
      const callbacks = window.__TAURI_INTERNALS__.callbacks;
      if (!(callbacks instanceof Map)) throw new Error('Tauri callback inventory is unavailable');
      const counts = { registered: 0, removed: 0, dispatched: 0, initialSize: callbacks.size, maxSize: callbacks.size };
      const patches = ['set', 'delete', 'get'].map(method => {
        const descriptor = Object.getOwnPropertyDescriptor(callbacks, method);
        const original = callbacks[method];
        const wrapped = function(...args) {
          const result = original.apply(this, args);
          if (method === 'set') counts.registered++;
          else if (method === 'delete' && result) counts.removed++;
          else if (method === 'get' && typeof result === 'function') counts.dispatched++;
          counts.maxSize = Math.max(counts.maxSize, callbacks.size);
          return result;
        };
        callbacks[method] = wrapped;
        return { method, descriptor, wrapped };
      });
      window.__petResidency = { counts, stop() {
        for (const { method, descriptor, wrapped } of patches) {
          if (callbacks[method] !== wrapped) continue;
          if (descriptor) Object.defineProperty(callbacks, method, descriptor);
          else delete callbacks[method];
        }
        delete window.__petResidency;
      } };
    });
  }

  stopCallbackProbe() { return this.execute(() => window.__petResidency?.stop()); }

  residencySnapshot() {
    return this.execute(() => {
      const pet = document.querySelector('[data-openbitfun-part="petdex"]');
      const style = pet && getComputedStyle(pet);
      const rect = pet?.getBoundingClientRect();
      return {
        visibility: document.visibilityState,
        domNodes: document.getElementsByTagName('*').length,
        driverHandles: Object.keys(window.__openbitfunWdElements ?? {}).length,
        callbackCount: window.__TAURI_INTERNALS__?.callbacks?.size ?? null,
        callbackChurn: window.__petResidency?.counts ?? null,
        actualJsHeap: performance.memory?.usedJSHeapSize ?? null,
        sprite: pet ? { width: rect.width, height: rect.height, backgroundImage: style.backgroundImage,
          animationName: style.animationName, playState: style.animationPlayState,
          row: Number(pet.style.getPropertyValue('--openbitfun-petdex-row')),
          lookPositionX: pet.style.backgroundPositionX } : null,
        bubbles: document.querySelectorAll('[data-agent-companion-session-id]').length,
        animations: document.getAnimations().map(animation => ({ name: animation.animationName,
          state: animation.playState, time: animation.currentTime })),
      };
    });
  }
}
