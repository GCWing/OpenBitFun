import { WorkbenchResidencyPage } from './WorkbenchResidencyPage.mjs';

/** Separate diagnostic: preserve every native result, capture slow read callers. */
export class LayoutReadDiagnosticPage extends WorkbenchResidencyPage {
  startLayoutReads(options = {}) {
    return this.execute(options => {
      const restores = [], reads = new Map(), slow = [];
      let pendingWrites = [], writeCount = 0;
      const nodeLabel = node => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return element ? { tag: element.tagName, testId: element.getAttribute('data-testid'),
          class: element.getAttribute('class')?.slice(0, 240),
          scene: element.closest('[data-scene-id]')?.getAttribute('data-scene-id') } : null;
      };
      const collectWrites = records => {
        for (const mutation of records) {
          writeCount++;
          if (pendingWrites.length >= 128) continue;
          pendingWrites.push({ collectedAt: performance.now(), type: mutation.type,
            target: nodeLabel(mutation.target), attribute: mutation.attributeName,
            oldValue: mutation.oldValue?.slice(0, 240),
            currentValueAtCollection: mutation.attributeName
              ? mutation.target.getAttribute(mutation.attributeName)?.slice(0, 240) : undefined,
            addedCount: mutation.addedNodes.length, removedCount: mutation.removedNodes.length,
            added: [...mutation.addedNodes].slice(0, 3).map(nodeLabel),
            removed: [...mutation.removedNodes].slice(0, 3).map(nodeLabel) });
        }
      };
      const observer = options.mutations ? new MutationObserver(collectWrites) : null;
      observer?.observe(document.documentElement, { subtree: true, childList: true,
        attributes: true, attributeOldValue: true, characterData: true });
      const takeWrites = () => {
        if (!observer) return undefined;
        collectWrites(observer.takeRecords());
        const value = { total: writeCount, dropped: writeCount - pendingWrites.length, records: pendingWrites };
        pendingWrites = []; writeCount = 0;
        return value;
      };
      const record = (kind, target, start) => {
        const elapsedMs = performance.now() - start;
        const entry = reads.get(kind) ?? { kind, count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
        entry.count++; entry.totalMs += elapsedMs; entry.maxMs = Math.max(entry.maxMs, elapsedMs);
        if (elapsedMs >= 1) {
          entry.slowCount++;
          if (slow.length < 2000) {
            const owner = target?.closest?.('[data-scene-id]');
            const active = document.querySelector('[data-testid="scene-viewport-scene"][data-scene-active="true"]');
            const sceneState = node => node ? {
              id: node.getAttribute('data-scene-id'), phase: node.getAttribute('data-pane-motion-phase'),
              active: node.getAttribute('data-scene-active'),
              visible: node.classList.contains('openbitfun-scene-viewport__scene--visible'),
            } : null;
            slow.push({ kind, elapsedMs, at: performance.now(),
              tag: target?.tagName, class: target?.getAttribute?.('class'),
              scene: owner?.getAttribute('data-scene-id'),
              ownerScene: sceneState(owner), activeScene: sceneState(active),
              writesSincePreviousSlowRead: takeWrites(),
              focus: observer ? { ...nodeLabel(document.activeElement),
                focusVisible: document.activeElement?.matches(':focus-visible') } : undefined,
              stack: new Error('Layout read diagnostic').stack });
          }
        }
        reads.set(kind, entry);
      };
      for (const [prototype, keys] of [[Element.prototype, ['scrollHeight', 'scrollWidth', 'scrollLeft', 'scrollTop', 'clientWidth', 'clientHeight']],
        [HTMLElement.prototype, ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']]]) {
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          if (!descriptor?.get || !descriptor.configurable) throw new Error(`Cannot diagnose ${key}`);
          Object.defineProperty(prototype, key, { ...descriptor, get() {
            const start = performance.now(), value = descriptor.get.call(this);
            record(key, this, start); return value;
          } });
          restores.push(() => Object.defineProperty(prototype, key, descriptor));
        }
      }
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        const start = performance.now(), value = rect.call(this);
        record('getBoundingClientRect', this, start); return value;
      };
      restores.push(() => { Element.prototype.getBoundingClientRect = rect; });
      const visibility = Element.prototype.checkVisibility;
      if (visibility) {
        Element.prototype.checkVisibility = function (...args) {
          const start = performance.now(), value = visibility.apply(this, args);
          record('checkVisibility', this, start); return value;
        };
        restores.push(() => { Element.prototype.checkVisibility = visibility; });
      }
      const style = window.getComputedStyle;
      window.getComputedStyle = function (...args) {
        const start = performance.now(), value = style.apply(this, args);
        record('getComputedStyle', args[0], start); return value;
      };
      restores.push(() => { window.getComputedStyle = style; });
      window.__layoutReadDiagnostic = { stop: () => {
        const remainingWrites = takeWrites(); observer?.disconnect();
        restores.reverse().forEach(restore => restore());
        return { reads: [...reads.values()], slow, remainingWrites };
      } };
    }, options);
  }
  stopLayoutReads() {
    return this.execute(() => {
      const result = window.__layoutReadDiagnostic?.stop(); delete window.__layoutReadDiagnostic; return result;
    });
  }
}
