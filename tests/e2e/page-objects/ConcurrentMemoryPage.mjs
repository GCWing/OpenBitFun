import { ConcurrentWorkloadPage } from './ConcurrentWorkloadPage.mjs';

/** Read-only lifetime observations. Weak references never own transcript DOM. */
export class ConcurrentMemoryPage extends ConcurrentWorkloadPage {
  async residencySnapshot() {
    const snapshot = await super.residencySnapshot();
    const memory = await this.execute(() => {
      const observed = window.__concurrentMemoryRoots ??= { seen: new WeakSet(), roots: [] };
      for (const root of document.querySelectorAll('[data-testid="flowchat-message-list"]')) {
        if (observed.seen.has(root)) continue;
        observed.seen.add(root); observed.roots.push(new WeakRef(root));
      }
      const roots = { observed: observed.roots.length, connected: 0, detachedAlive: 0, collected: 0 };
      for (const ref of observed.roots) {
        const root = ref.deref();
        if (!root) roots.collected++;
        else if (root.isConnected) roots.connected++;
        else roots.detachedAlive++;
      }
      const resources = window.__OPENBITFUN_RESOURCE_BUDGET__?.snapshot();
      let highlightRanges = 0, detachedHighlightRanges = 0;
      for (const highlight of CSS.highlights?.values() ?? []) for (const range of highlight) {
        highlightRanges++;
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) detachedHighlightRanges++;
      }
      return { timeOrigin: performance.timeOrigin, at: performance.now(), roots,
        mountedRows: document.querySelectorAll('.virtual-item-wrapper').length,
        resourceBudgetAvailable: !!resources,
        resourceEntries: resources?.map(({ kind, bytes, protectedReason }) => ({ kind, bytes, protectedReason })) ?? [],
        resourceBytes: resources?.reduce((sum, item) => sum + item.bytes, 0) ?? null,
        highlightRanges, detachedHighlightRanges };
    });
    return { ...snapshot, memory };
  }
}
