import { SceneVisibilityPage } from './SceneVisibilityPage.mjs';

/** Real DOM selection and wheel delivery, without retaining row nodes in probes. */
export class TimelineSelectionPage extends SceneVisibilityPage {
  selectRows() {
    return this.execute(() => {
      const scroller = document.querySelector('[data-flowchat-scroller]');
      const rows = [...scroller.querySelectorAll('.virtual-item-wrapper[data-virtual-item-key]')];
      const prose = rows.flatMap(row => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim().length >= 24 && !node.parentElement.closest('button, style, script, textarea')) {
            return [{ row, node }];
          }
        }
        return [];
      });
      if (prose.length < 2) throw new Error('Need two mounted prose rows');
      const range = document.createRange();
      range.setStart(prose[0].node, 0);
      range.setEnd(prose[1].node, 24);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      // Use WebKit's own selectionchange delivery, not an extra synthetic event.
      return { text: selection.toString(), keys: prose.slice(0, 2).map(item => item.row.dataset.virtualItemKey) };
    });
  }

  selectAcrossScroller() {
    return this.execute(() => {
      const scroller = document.querySelector('[data-flowchat-scroller]');
      const range = document.createRange(); range.setStartBefore(scroller); range.setEndAfter(scroller);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { textLength: selection.toString().length,
        anchorOutside: !scroller.contains(selection.anchorNode), focusOutside: !scroller.contains(selection.focusNode),
        intersects: range.intersectsNode(scroller) };
    });
  }

  clearSelection() { return this.execute(() => window.getSelection()?.removeAllRanges()); }

  selectOutside() {
    return this.execute(() => {
      const outside = document.querySelector('[data-testid="chat-input-textarea"]');
      const range = document.createRange(); range.selectNodeContents(outside);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
  }

  selectionSnapshot() {
    return this.execute(() => {
      const selection = window.getSelection(), scroller = document.querySelector('[data-flowchat-scroller]');
      return { text: selection?.toString(), collapsed: selection?.isCollapsed,
        anchorConnected: selection?.anchorNode?.isConnected ?? false,
        focusConnected: selection?.focusNode?.isConnected ?? false,
        scrollTop: scroller.scrollTop,
        keys: [...scroller.querySelectorAll('[data-virtual-item-key]')].map(row => row.dataset.virtualItemKey) };
    });
  }

  async scrollSelection(deltaY) {
    const point = await this.execute(() => {
      const box = document.querySelector('[data-flowchat-scroller]').getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    });
    await this.request(`/session/${this.session}/actions`, { actions: [{ type: 'wheel', id: 'selection-reader',
      actions: [{ type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 100 }] }] });
  }
}
