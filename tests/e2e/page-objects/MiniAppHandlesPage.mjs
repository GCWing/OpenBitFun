import { MiniAppWorkloadPage } from './MiniAppWorkloadPage.mjs';

/** Observe automation-owned handles separately from product caches and state. */
export class MiniAppHandlesPage extends MiniAppWorkloadPage {
  inspectHandles(releaseDetachedDocuments = false) {
    return this.execute(release => {
      const documents = new Set();
      const visit = doc => {
        if (!doc || documents.has(doc)) return;
        documents.add(doc);
        for (const frame of doc.querySelectorAll('iframe,frame')) {
          try { visit(frame.contentDocument); } catch {}
        }
      };
      visit(document);
      const handles = window.__openbitfunWdElements ?? {};
      const rows = Object.entries(handles).map(([id, node]) => ({ id,
        tag: node.tagName ?? node.nodeName, connected: node.isConnected,
        liveDocument: documents.has(node.ownerDocument),
        appId: node.ownerDocument?.documentElement?.dataset.openbitfunMiniappRendered ?? null }));
      const detached = rows.filter(row => !row.connected || !row.liveDocument);
      if (release) for (const row of detached) delete handles[row.id];
      return { liveDocuments: documents.size, handleCount: rows.length, detached, released: release ? detached.length : 0 };
    }, releaseDetachedDocuments);
  }
}
